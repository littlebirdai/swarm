import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import type { CanonicalEvent } from "@codecast/edge-contract";
import {
  TURN_PROJECTION_VERSION,
  TURN_STARTER_PROJECTION_VERSION,
} from "@codecast/session-contract/turn-projection";
import { asUser } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import {
  leaseMs,
  setupRunLease,
  start,
} from "../test-helpers/run-lease.testkit";
import { api, internal } from "./_generated/api";

const flags = [
  "CODECAST_FENCED_EXECUTION_V1",
  "CODECAST_EDGE_DELIVERY_V1",
  "SWARM_TURN_BATON",
];
const saved = flags.map((flag) => process.env[flag]);
beforeEach(() => {
  for (const flag of flags) process.env[flag] = "1";
  setSystemTime(new Date(start));
});
afterEach(() => {
  for (const [index, flag] of flags.entries()) {
    if (saved[index] === undefined) delete process.env[flag];
    else process.env[flag] = saved[index];
  }
  setSystemTime();
});

test("the owner receives a current steer observation and eligible collaborators see neither it nor the prompts", async () => {
  const f = await setupRunLease();
  const lease = await f.claim("turn-feed-lease");
  if (lease.status !== "granted") throw new Error("Expected run lease");
  const base = {
    v: 1,
    session: f.conversation,
    run: 1,
    source: "provider",
    turn: "next",
    at: start,
  } as const;
  const append = async (
    events: CanonicalEvent[],
    token = lease.fencing_token,
  ) => {
    expect(
      await f.t.mutation(internal.edgeRunLease.append, {
        ...f.requestFence(token),
        events_json: JSON.stringify(events),
      }),
    ).toMatchObject({ status: "appended" });
  };
  const sender = await f.t.run(async ({ db }) => {
    const binding = await db.query("execution_bindings").unique();
    if (!binding) throw new Error("Expected binding");
    await db.patch(binding._id, {
      capabilities: [...(binding.capabilities ?? []), "steer-baton-v1"],
    });
    await db.patch(f.message, { human: true });
    const rows = fixtureRows(db, "fenced turn feed");
    const sender = await rows.user();
    await db.patch(f.conversation, { share_token: "turn-share" });
    await db.insert("share_redemptions", {
      conversation_id: f.conversation,
      user_id: sender,
      token: "turn-share",
      created_at: start,
    });
    await db.insert("collab_grants", {
      conversation_id: f.conversation,
      grantee_user_id: sender,
      owner_user_id: f.owner,
      status: "granted",
      created_at: start,
      updated_at: start,
    });
    return sender;
  });
  const args = { conversation_id: f.conversation };
  const feed = api.permissions.getFencedPromptFeed;
  const ownerFeed = () => asUser(f.t, f.owner).query(feed, args);
  const senderFeed = () => asUser(f.t, sender).query(feed, args);

  const fence = {
    v: 1 as const,
    bearer: f.bearer,
    session: f.conversation,
    run: 1,
    fencing_token: lease.fencing_token,
  };
  const permit = await f.t.mutation(internal.edgeDelivery.next, fence);
  if (permit.status !== "permit") throw new Error("Expected a delivery permit");
  expect(
    await f.t.mutation(internal.edgeDelivery.start, {
      ...fence,
      attempt_id: permit.attempt_id,
      delivery_id: permit.delivery_id,
      seq: permit.seq,
      intent: permit.intent,
      sender: permit.sender,
    }),
  ).toMatchObject({ status: "started", intent: "queue" });

  expect(await senderFeed()).toEqual({ prompts: [], turn: null });
  await append([
    {
      ...base,
      seq: 1,
      turn: "next",
      kind: "turn.started",
      body: { starter: permit.sender },
    },
    {
      ...base,
      seq: 2,
      turn: "next",
      kind: "prompt.opened",
      body: { prompt_id: "next-prompt", kind: "permission" },
    },
  ]);
  const observed_turn = { id: "next", run: 1, start_event_seq: 1 };
  expect(await ownerFeed()).toMatchObject({
    prompts: [{ prompt_id: "next-prompt" }],
    turn: { _id: f.conversation, observed_turn },
  });
  expect(await senderFeed()).toEqual({ prompts: [], turn: null });
  expect((await ownerFeed()).turn?.lease_remaining_ms).toBe(leaseMs);
  setSystemTime(new Date(start + 5_000));
  expect((await ownerFeed()).turn?.lease_remaining_ms).toBe(leaseMs - 5_000);
  await f.t.run(async ({ db }) => {
    const projection = await db.query("run_turn_projections").unique();
    if (!projection) throw new Error("Expected turn projection");
    await db.patch(projection._id, {
      projection_version: TURN_PROJECTION_VERSION,
    });
  });
  expect(await ownerFeed()).toMatchObject({
    prompts: [{ prompt_id: "next-prompt" }],
    turn: null,
  });
  await f.t.run(async ({ db }) => {
    const projection = await db.query("run_turn_projections").unique();
    if (!projection) throw new Error("Expected turn projection");
    await db.patch(projection._id, {
      projection_version: TURN_STARTER_PROJECTION_VERSION,
    });
  });
  await f.t.run(async ({ db }) => {
    const head = await db.query("conversation_execution_heads").unique();
    if (!head) throw new Error("Expected execution head");
    await db.patch(head._id, { admission_epoch: 2 });
  });
  expect(await senderFeed()).toEqual({ prompts: [], turn: null });
  expect(await ownerFeed()).toMatchObject({
    prompts: [{ prompt_id: "next-prompt" }],
    turn: null,
  });
  await f.t.run(async ({ db }) => {
    const head = await db.query("conversation_execution_heads").unique();
    if (!head) throw new Error("Expected execution head");
    await db.patch(head._id, { admission_epoch: 1 });
  });
  await append([
    { ...base, seq: 3, kind: "turn.ended", body: { reason: "completed" } },
  ]);
  expect(await ownerFeed()).toEqual({ prompts: [], turn: null });
  await append([
    {
      ...base,
      seq: 4,
      turn: "new",
      kind: "turn.started",
      body: { starter: permit.sender },
    },
  ]);
  expect(await ownerFeed()).toMatchObject({
    prompts: [],
    turn: { observed_turn: { id: "new", run: 1, start_event_seq: 4 } },
  });
  setSystemTime(new Date(start + leaseMs));
  const nextLease = await f.claim("turn-feed-replacement");
  expect(nextLease.status).toBe("granted");
  expect(await ownerFeed()).toEqual({ prompts: [], turn: null });
});
