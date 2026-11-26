import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { STEER_BATON_CAPABILITY } from "@codecast/edge-contract";
import { TURN_STARTER_PROJECTION_VERSION } from "@codecast/session-contract/turn-projection";
import { asUser } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { boot, setupRunLease, start } from "../test-helpers/run-lease.testkit";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";

const flag = "SWARM_TURN_BATON";
const saved = process.env[flag];
const turn = { id: "running-turn", run: 1, start_event_seq: 10 };

beforeEach(() => {
  process.env[flag] = "1";
  setSystemTime(new Date(start));
});

afterEach(() => {
  if (saved === undefined) delete process.env[flag];
  else process.env[flag] = saved;
  setSystemTime();
});

async function setup({
  starter = "person",
  capable = true,
}: {
  starter?: "person" | "agent" | "idle";
  capable?: boolean;
} = {}) {
  const f = await setupRunLease();
  const { other, projection } = await f.t.run(async ({ db }) => {
    const other = await fixtureRows(db, "baton second sender").user();
    await db.patch(f.conversation, { owner_user_id: other });
    const binding = (await db.get(f.binding))!;
    await db.patch(f.binding, {
      capabilities: [
        ...(binding.capabilities ?? []),
        ...(capable ? [STEER_BATON_CAPABILITY] : []),
      ],
      claim_id: "turn-lease",
    });
    await db.insert("run_leases", {
      conversation_id: f.conversation,
      owner_user_id: f.owner,
      binding_id: f.binding,
      claim_id: "turn-lease",
      fencing_token: "current-fence",
      boot,
      expires_at: start + 120_000,
      retain_until: start + 120_000,
    });
    const projection = await db.insert("run_turn_projections", {
      conversation_id: f.conversation,
      owner_user_id: f.owner,
      binding_id: f.binding,
      run: turn.run,
      status: "active",
      projection_version: TURN_STARTER_PROJECTION_VERSION,
      turn_ids: starter === "idle" ? [] : [turn.id],
      open_turn:
        starter === "idle"
          ? null
          : {
              id: turn.id,
              start_event_seq: turn.start_event_seq,
              prompt_ids: [],
              starter: {
                kind: starter,
                id: f.owner,
              },
            },
      received_at: start,
    });
    return { other, projection };
  });
  const actor = asUser(f.t, f.owner);
  const send = (
    id: string,
    {
      observed_turn = turn,
      sender = f.owner,
    }: {
      observed_turn?: typeof turn | null;
      sender?: Id<"users">;
    } = {},
  ) =>
    asUser(f.t, sender).mutation(api.pendingMessages.sendMessageV2, {
      command_id: id,
      client_id: id,
      conversation_id: f.conversation,
      content: id,
      ...(observed_turn ? { observed_turn } : {}),
    });
  const dispatch = (action: string, id: string) =>
    actor.mutation(api.dispatch.dispatch, {
      action,
      args:
        action === "queueMessage"
          ? [f.conversation, id, id]
          : [f.conversation, id, null, id],
      ...(action === "sendMessage"
        ? { result: { receiptActionVersion: 1, commandId: id } }
        : {}),
    });
  const snapshot = () =>
    f.t.run(async ({ db }) => ({
      messages: (await db.query("pending_messages").collect()).filter(
        (r) => r._id !== f.message,
      ),
      claim: await db.query("claims").unique(),
      turn: (await db.get(projection))?.open_turn,
      sequence: (await db.get(f.head))?.next_conversation_sequence,
      receipts: await db.query("local_command_receipts").collect(),
    }));
  return { ...f, other, projection, send, dispatch, snapshot };
}

function recorded(r: Doc<"pending_messages">) {
  return [
    r.client_id,
    r.delivery_intent,
    r.delivery_observed_turn,
    r.delivery_baton_token,
    r.conversation_sequence,
    r.status,
  ];
}

test("the starter steers without writes to claims, then the first contender materializes the baton and queues", async () => {
  const f = await setup();
  const first = await f.send("lone");
  const alone = await f.snapshot();
  expect(alone.claim).toBeNull();
  expect(alone.messages.map(recorded)).toEqual([
    ["lone", "steer", turn, null, 2, "pending"],
  ]);

  await f.send("contest", { sender: f.other });
  const joined = await f.snapshot();
  expect(joined.claim).toMatchObject({
    holder: f.owner,
    token: 1,
    lease_until: start + 30_000,
  });
  expect(joined.turn?.baton_converted).toBe(true);
  expect(joined.messages.map(recorded)).toEqual([
    ["lone", "steer", turn, null, 2, "pending"],
    ["contest", "queue", undefined, undefined, 3, "pending"],
  ]);

  expect(await f.send("lone")).toEqual(first);
  expect(await f.snapshot()).toEqual(joined);
  await f.send("holder");
  setSystemTime(new Date(start + 30_001));
  await f.send("next-holder", { sender: f.other });
  const passed = await f.snapshot();
  expect(passed.claim).toMatchObject({ holder: f.other, token: 2 });
  expect(passed.messages.slice(2).map(recorded)).toEqual([
    ["holder", "steer", turn, 1, 4, "pending"],
    ["next-holder", "steer", turn, 2, 5, "pending"],
  ]);
});

test("the same turn id on another start event rejects without allocating a sequence", async () => {
  const f = await setup();
  const before = await f.snapshot();
  await expect(
    f.send("stale", { observed_turn: { ...turn, start_event_seq: 9 } }),
  ).rejects.toThrow("STALE_TURN");
  expect(await f.snapshot()).toEqual(before);
});

test("an expired run lease refuses a steer while leaving the receipt and inbox untouched", async () => {
  const f = await setup();
  const before = await f.snapshot();
  setSystemTime(new Date(start + 120_000));
  await expect(f.send("expired-run")).rejects.toThrow("STALE_TURN");
  expect(await f.snapshot()).toEqual(before);
});

test("an occupied delivery slot keeps an expired baton from changing hands", async () => {
  const f = await setup();
  await f.send("contest", { sender: f.other });
  expect(await f.deliver("current-fence")).toMatchObject({ state: "claimed" });
  setSystemTime(new Date(start + 30_001));
  await f.send("waiting-sender", { sender: f.other });
  const state = await f.snapshot();
  expect(state.claim).toMatchObject({ holder: f.owner, token: 1 });
  expect(state.messages.map(recorded)).toEqual([
    ["contest", "queue", undefined, undefined, 2, "pending"],
    ["waiting-sender", "queue", undefined, undefined, 3, "pending"],
  ]);
});

test("an agent-started turn requires a numbered claim even for the session owner", async () => {
  const f = await setup({ starter: "agent" });
  await f.send("owner");
  const state = await f.snapshot();
  expect(state.claim).toMatchObject({ holder: f.owner, token: 1 });
  expect(state.messages.map(recorded)).toEqual([
    ["owner", "steer", turn, 1, 2, "pending"],
  ]);
});

test("store actions without an observation and explicit queue sends keep their admission order", async () => {
  const f = await setup();
  await f.dispatch("sendMessage", "old-composer");
  await f.dispatch("queueMessage", "cmd-enter");
  const state = await f.snapshot();
  expect(state.claim).toBeNull();
  expect(state.messages.map(recorded)).toEqual([
    ["old-composer", "queue", undefined, undefined, 2, "pending"],
    ["cmd-enter", "queue", undefined, undefined, 3, "held"],
  ]);
});

test("an idle session queues without a claim when the sender saw no turn", async () => {
  const f = await setup({ starter: "idle" });
  await expect(f.send("ended-turn")).rejects.toThrow("STALE_TURN");
  await f.send("idle", { observed_turn: null });
  const state = await f.snapshot();
  expect(state.claim).toBeNull();
  expect(state.messages.map(recorded)).toEqual([
    ["idle", "queue", undefined, undefined, 2, "pending"],
  ]);
});

test("a runtime without the capability retains the old path", async () => {
  const f = await setup({ capable: false });
  await f.send("normal");
  await f.dispatch("queueMessage", "queued");
  expect((await f.snapshot()).messages.map(recorded)).toEqual([
    ["normal", undefined, undefined, undefined, 2, "pending"],
    ["queued", undefined, undefined, undefined, undefined, "held"],
  ]);
});

test("flag off replays the old store send and keeps queued rows unsequenced", async () => {
  delete process.env[flag];
  const f = await setup();
  const first = await f.dispatch("sendMessage", "ordinary-one");
  await f.dispatch("queueMessage", "queued");
  await f.dispatch("sendMessage", "ordinary-two");
  const before = await f.snapshot();
  expect(before.sequence).toBe(4);
  expect(before.claim).toBeNull();
  expect(before.receipts).toHaveLength(2);
  expect(before.messages.map(recorded)).toEqual([
    ["ordinary-one", undefined, undefined, undefined, 2, "pending"],
    ["queued", undefined, undefined, undefined, undefined, "held"],
    ["ordinary-two", undefined, undefined, undefined, 3, "pending"],
  ]);
  expect(await f.dispatch("sendMessage", "ordinary-one")).toEqual(first);
  expect(await f.snapshot()).toEqual(before);
});
