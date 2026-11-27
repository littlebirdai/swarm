import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import {
  STEER_BATON_CAPABILITY,
  TAKEOVER_FENCE_CAPABILITY,
} from "@codecast/edge-contract";
import { asUser } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import {
  boot,
  machine,
  setupRunLease,
  start,
} from "../test-helpers/run-lease.testkit";
import {
  observed,
  steerDeliveryFixture,
} from "../test-helpers/steer-delivery.testkit";
import { api } from "./_generated/api";

const flags = [
  "SWARM_TURN_BATON",
  "CODECAST_EDGE_DELIVERY_V1",
  "CODECAST_EDGE_V1",
];
const previous = flags.map((flag) => process.env[flag]);
beforeEach(() => {
  for (const flag of flags) process.env[flag] = "1";
  setSystemTime(new Date(start));
});
afterEach(() => {
  for (const [index, flag] of flags.entries()) {
    if (previous[index] === undefined) delete process.env[flag];
    else process.env[flag] = previous[index];
  }
  setSystemTime();
});

async function setup() {
  const f = await steerDeliveryFixture();
  const outsider = await f.t.run(async ({ db }) => {
    const binding = await db.get(f.binding);
    if (!binding) throw new Error("Expected binding");
    await db.patch(f.binding, {
      capabilities: [...binding.capabilities!, TAKEOVER_FENCE_CAPABILITY],
    });
    return fixtureRows(db, "outside steer takeover").user();
  });
  const args = { conversation_id: f.conversation };
  const actor = asUser(f.t, f.other);
  const query = () => actor.query(api.collab.steerClaimState, args);
  const takeover = (expectedToken: number | null = null) =>
    actor.mutation(api.collab.takeOverSteer, {
      ...args,
      expected: observed,
      expected_holder: f.owner,
      expected_token: expectedToken,
    });
  const acknowledge = async (body: object, bearer = f.bearer) => {
    const response = await f.t.fetch("/edge/v1/takeover.ack", {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ ...f.fence, ...body }),
    });
    expect(response.status).toBe(200);
    return response.json();
  };
  return { ...f, actor, outsider, args, query, takeover, acknowledge };
}

test("the steer feed denies unauthorized viewers and only the owner can take over", async () => {
  const f = await setup();
  const withoutAccess = asUser(f.t, f.outsider);
  expect(
    await withoutAccess.query(api.collab.steerClaimState, f.args),
  ).toBeNull();
  expect(await f.t.query(api.collab.steerClaimState, f.args)).toBeNull();
  const command = {
    ...f.args,
    expected: observed,
    expected_holder: f.owner,
    expected_token: null,
  };
  expect(
    await withoutAccess.mutation(api.collab.takeOverSteer, command),
  ).toEqual({ status: "refused" });
  expect(
    await asUser(f.t, f.owner).mutation(api.collab.takeOverSteer, command),
  ).toEqual({ status: "refused" });
  expect(await f.query()).toMatchObject({
    holder: { id: f.owner },
    owner: true,
    can_send: true,
    can_steer: false,
    can_take_over: true,
    queue: { items: [{ id: f.message, sender: f.owner }], more: false },
  });
  expect(await f.t.run(({ db }) => db.query("claims").collect())).toEqual([]);
});

test("the owner takes an unstarted baton immediately and retires the exact fence on ack", async () => {
  const f = await setup();
  await f.send("reserved-old", observed);
  const old = await f.permit();
  expect(old.selected.intent).toBe("steer");
  const taken = await f.takeover();
  expect(taken.status).toBe("granted");
  expect(await f.query()).toMatchObject({
    holder: { id: f.other },
    can_steer: true,
    takeover_pending: false,
  });
  expect(await f.begin(old.request)).toMatchObject({
    status: "rejected",
    reason: "stale-baton",
  });
  const fence = await f.next();
  expect(fence).toMatchObject({
    status: "takeover_fence",
    baton_token: null,
    new_baton_token: 1,
    fence_id: taken.fence_id,
  });
  if (fence.status !== "takeover_fence")
    throw new Error("Expected takeover fence");
  const { fence_id, turn, baton_token } = fence;
  expect(await f.acknowledge({ fence_id, turn, baton_token })).toMatchObject({
    status: "recorded",
  });
  expect(await f.acknowledge({ fence_id, turn, baton_token })).toMatchObject({
    status: "duplicate",
  });
  expect(await f.next()).toMatchObject({ status: "empty" });
});

test("takeover holds the slot and queues new sends until the daemon settles and acknowledges", async () => {
  const f = await setup();
  await f.send("started-old", observed);
  const old = await f.permit();
  expect(await f.begin(old.request)).toMatchObject({ status: "started" });
  const taken = await f.takeover();
  expect(taken.status).toBe("pending");
  expect(await f.query()).toMatchObject({
    holder: { id: f.owner },
    can_steer: false,
    takeover_pending: true,
  });
  await f.send("old-queues", observed);
  await f.send("owner-queues", observed, f.other);
  expect(
    (await f.rows()).messages.slice(-2).map((row) => row.delivery_intent),
  ).toEqual(["queue", "queue"]);
  const fence = await f.next();
  if (fence.status !== "takeover_fence")
    throw new Error("Expected takeover fence");
  const { fence_id, turn, baton_token } = fence;
  const ack = { fence_id, turn, baton_token };
  expect(await f.acknowledge(ack, f.wrongDevice)).toMatchObject({
    status: "stale",
  });
  expect(await f.acknowledge(ack)).toMatchObject({ status: "stale" });
  expect(await f.settle(old.request, "in_doubt")).toMatchObject({
    status: "recorded",
  });
  expect(await f.acknowledge(ack)).toMatchObject({ status: "stale" });
  expect(await f.next()).toEqual(fence);
  expect(
    await f.settle(old.request, "applied", {
      resolution_evidence: "known provider receipt",
    }),
  ).toMatchObject({ status: "recorded" });
  expect(await f.acknowledge({ ...ack, fence_id: "unrelated" })).toMatchObject({
    status: "stale",
  });
  expect(await f.acknowledge(ack)).toMatchObject({ status: "recorded" });
  expect(await f.query()).toMatchObject({
    holder: { id: f.other },
    takeover_pending: false,
    can_steer: true,
  });
});

test("the flag off refuses the feed and takeover without writing a claim", async () => {
  const f = await setup();
  delete process.env.SWARM_TURN_BATON;
  expect(await f.query()).toBeNull();
  expect(await f.takeover()).toEqual({ status: "refused" });
  expect(await f.t.run(({ db }) => db.query("claims").collect())).toEqual([]);
  expect(await f.next()).toMatchObject({ status: "permit", intent: "queue" });
});

test("the session store action dispatches a send with the exact observed turn", async () => {
  const f = await setup();
  const runner = asUser(f.t, f.owner);
  const send = (clientId: string, turn: typeof observed) =>
    runner.mutation(api.dispatch.dispatch, {
      action: "controlSteerComposer",
      args: [
        f.conversation,
        { kind: "send", clientId, text: "Steer", observed: turn },
      ],
    });
  expect(await send("live-steer", observed)).toMatchObject({
    status: "acknowledged",
  });
  expect((await f.rows()).messages.at(-1)).toMatchObject({
    delivery_intent: "steer",
    delivery_observed_turn: observed,
  });
  expect(
    await send("stale-live-steer", { ...observed, start_event_seq: 500 }),
  ).toMatchObject({ status: "rejected", code: "STALE_TURN" });
});

test("the authenticated hello attaches negotiated capabilities to its registered boot and lease", async () => {
  const f = await setupRunLease();
  await f.t.run(({ db }) =>
    db.insert("execution_daemon_boots", {
      user_id: f.owner,
      owner_device_id: machine,
      daemon_boot_id: boot,
      registered_at: start,
    }),
  );
  const hello = async (offeredBoot: string) =>
    (
      await f.t.fetch("/edge/v1/hello", {
        method: "POST",
        headers: { authorization: `Bearer ${f.bearer}` },
        body: JSON.stringify({
          machine,
          boot: offeredBoot,
          versions: [1],
          capabilities: [STEER_BATON_CAPABILITY, TAKEOVER_FENCE_CAPABILITY],
          providers: [{ name: "codex", version: "1.0.0" }],
          runtimes: [{ host: "laptop", isolation: "none" }],
          capacity: {
            memory_total_bytes: 1024,
            memory_available_bytes: 512,
            live_agents: 1,
          },
        }),
      })
    ).json();
  await hello("unregistered-boot");
  expect(await f.claim("live-baton")).toMatchObject({ status: "granted" });
  expect(await f.t.run(({ db }) => db.get(f.binding))).not.toHaveProperty(
    "edge_capabilities",
  );
  expect(await hello(boot)).toMatchObject({
    status: "ok",
    policy: {
      capabilities: [STEER_BATON_CAPABILITY, TAKEOVER_FENCE_CAPABILITY],
    },
  });
  expect(await f.claim("live-baton")).toMatchObject({ status: "granted" });
  expect(await f.t.run(({ db }) => db.get(f.binding))).toMatchObject({
    edge_capabilities: [STEER_BATON_CAPABILITY, TAKEOVER_FENCE_CAPABILITY],
  });
});
