import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { presentToken } from "@platform/auth/tokenFormat";
import { asUser, scheduledJobs } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { boot, setupRunLease, start } from "../test-helpers/run-lease.testkit";
import { api, internal } from "./_generated/api";
import { EXECUTION_PROTOCOL_CAPABILITIES } from "./executionBindings";

const flag = "CODECAST_FORCED_DEVICE_MOVE_V1";
const previous = process.env[flag];
const device = "driver-target";
const targetBoot = "target-boot";
const capabilities = [...EXECUTION_PROTOCOL_CAPABILITIES];
const run = internal.edgeRunLease.driveMove;

beforeEach(() => {
  jest.useFakeTimers({ now: start });
  process.env[flag] = "1";
});

afterEach(() => {
  jest.useRealTimers();
  if (previous === undefined) delete process.env[flag];
  else process.env[flag] = previous;
});

async function fixture(register = true, crossAccount = true) {
  const f = await setupRunLease({ documentsRead: 230 });
  const runner = await f.t.run(async ({ db }) => {
    const rows = fixtureRows(db, "move driver target");
    const runner = crossAccount ? await rows.user() : f.owner;
    await rows.device(runner, { device_id: device, label: "Studio" });
    if (crossAccount) {
      const team = await rows.team();
      await rows.membership(f.owner, team);
      await rows.membership(runner, team);
      await db.insert("device_shares", {
        user_id: runner,
        team_id: team,
        device_id: device,
        shared_at: start,
      });
    }
    const id = await rows.token(runner, "move-driver-token");
    await db.patch(id, { device_id: device });
    return runner;
  });
  const bearer = presentToken("move-driver-token", device);
  if (register)
    await f.t.mutation(api.executionBindings.registerExecutionDaemonBoot, {
      api_token: bearer,
      owner_device_id: device,
      daemon_boot_id: targetBoot,
    });
  const owner = asUser(f.t, f.owner);
  const target = {
    conversation_id: f.conversation,
    expected_source_epoch: 1,
    destination_device_id: device,
  };
  const force = () =>
    owner.mutation(api.edgeRunLease.forceMove, {
      ...target,
      acknowledge_source_may_still_run: true,
    });
  const readHead = () => f.t.run(({ db }) => db.get(f.head));
  const next = () =>
    owner.query(api.edgeRunLease.forcedMoveOptions, {
      conversation_id: f.conversation,
    });
  const pulse = async (time = 0) => {
    jest.advanceTimersByTime(time);
    await f.t.finishInProgressScheduledFunctions();
  };
  const nextBinding = () =>
    f.t.run(({ db }) =>
      db
        .query("execution_bindings")
        .withIndex("by_conversation_epoch", (q) =>
          q.eq("conversation_id", f.conversation).eq("epoch", 2),
        )
        .unique(),
    );

  const announceReady = async () => {
    const auth = {
      owner_device_id: device,
      daemon_boot_id: targetBoot,
      api_token: bearer,
      protocol_version: 1,
    };
    const work = await f.t.query(api.executionBindings.listExecutionWork, {
      ...auth,
      capabilities,
    });
    expect(work).toMatchObject([
      {
        conversationId: f.conversation,
        currentEpoch: 1,
        pendingEpoch: 2,
        bindings: [{ state: "requested", request: { target: { epoch: 2 } } }],
      },
    ]);
    const address = { ...auth, conversation_id: f.conversation, epoch: 2 };
    const claim = await f.t.mutation(
      api.executionBindings.claimExecutionStart,
      {
        ...address,
        proposed_operation_id: "target-operation",
        configuration_revision: 2,
        required_capabilities: capabilities,
      },
    );
    expect(claim).toMatchObject({ operationId: "target-operation" });
    expect(
      await f.t.mutation(api.executionBindings.publishReadyBinding, {
        ...address,
        operation_id: "target-operation",
        requested_agent: "codex",
        actual_agent: "codex",
        transport: "app-server",
        handle: "target-handle",
        runtime_id: "target-runtime",
        applied_configuration_revision: 2,
        capabilities,
      }),
    ).toMatchObject({ accepted: true });
  };
  return {
    ...f,
    ownerClient: owner,
    runner,
    target,
    force,
    readHead,
    next,
    pulse,
    nextBinding,
    announceReady,
  };
}

test("a forced move drives preparation, bounded queue pages and activation from scheduler jobs", async () => {
  const f = await fixture();
  await f.t.run(async ({ db }) => {
    const original = await db.get(f.message);
    if (!original) throw new Error("Expected a pending message");
    const { _id, _creationTime, ...fields } = original;
    for (let i = 2; i <= 321; i++)
      await db.insert("pending_messages", {
        ...fields,
        client_id: `delivery-${i}`,
        delivery_id: `delivery-${i}`,
        conversation_sequence: i,
      });
    await db.patch(f.head, { next_conversation_sequence: 322 });
  });
  const id = await f.force();
  expect(await f.next()).toMatchObject([{ progress: "requested" }]);
  await f.pulse();
  expect(await f.next()).toMatchObject([{ progress: "preparing" }]);
  await f.announceReady();
  await f.pulse(1);
  expect(await f.next()).toMatchObject([{ progress: "moving" }]);
  await f.t.finishAllScheduledFunctions(() => jest.runOnlyPendingTimers());
  expect(await f.readHead()).toMatchObject({
    current_epoch: 2,
    owner_user_id: f.runner,
    last_device_move: {
      move_id: id,
      epoch: 2,
      moved: 321,
      prepared_at: expect.any(Number),
      retargeted_at: expect.any(Number),
    },
  });
  expect((await f.readHead())?.device_move).toBeUndefined();
  expect(await f.next()).toMatchObject([
    { progress: "done", requestedDestination: "Studio" },
  ]);
  expect(await f.t.run(({ db }) => db.get(f.message))).toMatchObject({
    owner_user_id: f.runner,
    execution_epoch: 2,
    delivery_id: "delivery",
    conversation_sequence: 1,
  });
});

test("duplicate schedule tickets and a superseded move leave the current move unchanged", async () => {
  const f = await fixture();
  const move_id = await f.force();
  const ticket = { conversation_id: f.conversation, move_id, revision: 0 };
  await f.t.run(({ scheduler }) => scheduler.runAfter(0, run, ticket));
  await f.t.run(({ scheduler }) =>
    scheduler.runAfter(0, run, { ...ticket, move_id: "superseded" }),
  );
  await f.pulse();
  expect((await f.readHead())?.device_move?.driver).toMatchObject({
    step: "retarget",
    revision: 1,
    retries: 0,
  });
  expect(
    (await scheduledJobs(f.t, run)).filter(
      (job) => job.state.kind === "pending",
    ),
  ).toHaveLength(1);
  expect(await f.nextBinding()).toMatchObject({ move_id });
  await f.announceReady();
  await f.t.finishAllScheduledFunctions(() => jest.runOnlyPendingTimers());
  expect((await f.readHead())?.last_device_move?.moved).toBe(1);
});

test.each(["requested", "preparing"] as const)(
  "an abort stops the scheduled driver while %s",
  async (phase) => {
    const f = await fixture();
    const move_id = await f.force();
    if (phase === "preparing") await f.pulse();
    await f.t.mutation(internal.edgeRunLease.abortMove, {
      conversation_id: f.conversation,
      move_id,
      bearer: f.bearer,
    });
    const snapshot = await f.readHead();
    await f.t.finishAllScheduledFunctions(() => jest.runOnlyPendingTimers());
    expect(await f.readHead()).toEqual(snapshot);
    if (phase === "requested") {
      expect(await f.nextBinding()).toBeNull();
      expect(snapshot?.device_move).toBeUndefined();
    } else {
      expect(await f.nextBinding()).toMatchObject({ state: "requested" });
      expect(snapshot?.device_move?.phase).toBe("aborting");
    }
    expect(snapshot?.current_epoch).toBe(1);
  },
);

test("an unavailable destination retries with backoff then reports failure", async () => {
  const f = await fixture(false);
  await f.force();
  await f.pulse();
  expect((await f.readHead())?.device_move?.driver).toMatchObject({
    step: "prepare",
    retries: 1,
  });
  await f.pulse(999);
  expect((await f.readHead())?.device_move?.driver?.retries).toBe(1);
  await f.pulse(1);
  expect((await f.readHead())?.device_move?.driver?.retries).toBe(2);
  await f.t.finishAllScheduledFunctions(() => jest.runOnlyPendingTimers());
  expect((await f.readHead())?.device_move?.driver).toMatchObject({
    step: "failed",
    retries: 10,
  });
  expect(await f.next()).toMatchObject([
    {
      progress: "failed",
      failure: "Waiting for the destination daemon to connect",
    },
  ]);
  expect(await f.nextBinding()).toBeNull();
});

test("a normal recorded move starts driving only after source stop proof", async () => {
  const f = await fixture();
  const lease = await f.claim("normal-source");
  if (lease.status !== "granted") throw new Error("Expected source lease");
  const move_id = await f.t.mutation(internal.edgeRunLease.recordMove, {
    ...f.target,
    destination_runner_id: f.runner,
  });
  await f.pulse();
  expect(await f.nextBinding()).toBeNull();
  await f.t.mutation(internal.edgeRunLease.confirmMoveSourceStop, {
    conversation_id: f.conversation,
    move_id,
    bearer: f.bearer,
    daemon_boot_id: boot,
    runtime_id: "runtime",
    fencing_token: lease.fencing_token,
  });
  await f.pulse();
  await f.announceReady();
  await f.t.finishAllScheduledFunctions(() => jest.runOnlyPendingTimers());
  expect((await f.readHead())?.current_epoch).toBe(2);
});

test("a failing activation rolls back work from the step before persisting its retry", async () => {
  const f = await fixture();
  await f.force();
  await f.pulse();
  await f.announceReady();
  await f.t.run(async ({ db }) => {
    const binding = await db
      .query("execution_bindings")
      .withIndex("by_conversation_epoch", (q) =>
        q.eq("conversation_id", f.conversation).eq("epoch", 2),
      )
      .unique();
    if (!binding) throw new Error("Expected destination binding");
    await db.insert("run_event_cursors", {
      conversation_id: f.conversation,
      owner_user_id: f.runner,
      binding_id: binding._id,
      run: 2,
      last_event_seq: 0,
    });
  });
  await f.t.finishAllScheduledFunctions(() => jest.runOnlyPendingTimers());
  expect(await f.readHead()).toMatchObject({
    current_epoch: 1,
    owner_user_id: f.owner,
    device_move: {
      driver: {
        step: "failed",
        retries: 10,
        last_error: "The destination event run already exists",
      },
    },
  });
  expect(await f.t.run(({ db }) => db.get(f.binding))).toMatchObject({
    state: "ready",
  });
  expect(await f.t.run(({ db }) => db.get(f.conversation))).toMatchObject({
    user_id: f.owner,
  });
  expect(await f.next()).toMatchObject([{ progress: "failed" }]);
});

test("an oversized trigger handoff fails without transferring the conversation", async () => {
  const f = await fixture();
  await f.t.run(async ({ db }) => {
    for (let i = 0; i < 101; i++)
      await db.insert("agent_tasks", {
        user_id: f.owner,
        originating_conversation_id: f.conversation,
        title: "Trigger",
        prompt: "Check",
        schedule_type: "once",
        mode: "propose",
        status: "scheduled",
        retry_count: 0,
        run_count: 0,
        created_at: start,
      });
  });
  await f.force();
  await f.pulse();
  await f.announceReady();
  await f.t.finishAllScheduledFunctions(() => jest.runOnlyPendingTimers());
  expect(await f.next()).toMatchObject([
    {
      progress: "failed",
      failure: "The session has too many triggers for atomic activation",
    },
  ]);
  expect(await f.t.run(({ db }) => db.get(f.conversation))).toMatchObject({
    user_id: f.owner,
  });
});
