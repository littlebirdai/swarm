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
    await rows.device(runner, {
      device_id: device,
      label: "Studio",
      last_seen: start,
    });
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
  const registerTarget = (daemonBoot = targetBoot) =>
    f.t.mutation(api.executionBindings.registerExecutionDaemonBoot, {
      api_token: bearer,
      owner_device_id: device,
      daemon_boot_id: daemonBoot,
    });
  if (register) await registerTarget();
  const owner = asUser(f.t, f.owner);
  const target = {
    conversation_id: f.conversation,
    expected_source_epoch: 1,
    destination_device_id: device,
  };
  const force = (
    destination = device,
    retry?: { move_id: string; revision: number },
  ) =>
    owner.mutation(api.edgeRunLease.forceMove, {
      ...target,
      destination_device_id: destination,
      acknowledge_source_may_still_run: true,
      retry_failed_move: retry,
    });
  const readHead = () => f.t.run(({ db }) => db.get(f.head));
  const next = (viewer = f.owner) =>
    asUser(f.t, viewer).query(api.edgeRunLease.forcedMoveOptions, {
      conversation_id: f.conversation,
    });
  const pulse = async (time = 0) => {
    jest.advanceTimersByTime(time);
    await f.t.finishInProgressScheduledFunctions();
  };
  const nextBinding = (epoch = 2) =>
    f.t.run(({ db }) =>
      db
        .query("execution_bindings")
        .withIndex("by_conversation_epoch", (q) =>
          q.eq("conversation_id", f.conversation).eq("epoch", epoch),
        )
        .unique(),
    );

  const queuePage = (cursor: string | null) =>
    f.t.run(({ db }) =>
      db
        .query("pending_messages")
        .withIndex("by_conversation_sequence", (q) =>
          q.eq("conversation_id", f.conversation),
        )
        .paginate({ cursor, numItems: 100 }),
    );
  const queue = async () => {
    let page = await queuePage(null);
    const rows = [...page.page];
    while (!page.isDone) {
      page = await queuePage(page.continueCursor);
      rows.push(...page.page);
    }
    return rows;
  };
  const announceReady = async (
    destination = device,
    token = bearer,
    epoch = 2,
    daemonBoot = targetBoot,
  ) => {
    const auth = {
      owner_device_id: destination,
      daemon_boot_id: daemonBoot,
      api_token: token,
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
        pendingEpoch: epoch,
        bindings: [{ state: "requested", request: { target: { epoch } } }],
      },
    ]);
    const address = { ...auth, conversation_id: f.conversation, epoch };
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
    targetToken: bearer,
    runner,
    target,
    force,
    readHead,
    next,
    pulse,
    nextBinding,
    announceReady,
    registerTarget,
    queue,
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
  const before = (await f.queue()).map(({ _id, delivery_id }) => ({
    _id,
    delivery_id,
  }));
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
  expect(await f.next(f.runner)).toMatchObject([
    { progress: "done", requestedDestination: "Studio" },
  ]);
  expect(
    (await f.queue()).map(
      ({
        _id,
        delivery_id,
        owner_user_id,
        execution_epoch,
        conversation_sequence,
      }) => ({
        _id,
        delivery_id,
        owner_user_id,
        execution_epoch,
        conversation_sequence,
      }),
    ),
  ).toEqual(
    before.map((row, i) => ({
      ...row,
      owner_user_id: f.runner,
      execution_epoch: 2,
      conversation_sequence: i + 1,
    })),
  );
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
  const retryTimes = (await scheduledJobs(f.t, run))
    .map((job) => job.scheduledTime)
    .sort((a, b) => a - b);
  expect(retryTimes.slice(6).map((at, i) => at - retryTimes[i + 5])).toEqual([
    30_000, 30_000, 30_000, 30_000,
  ]);
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
  const cursor = await f.t.run(async ({ db }) => {
    const binding = await db
      .query("execution_bindings")
      .withIndex("by_conversation_epoch", (q) =>
        q.eq("conversation_id", f.conversation).eq("epoch", 2),
      )
      .unique();
    if (!binding) throw new Error("Expected destination binding");
    return db.insert("run_event_cursors", {
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
  const stalled = (await f.readHead())?.device_move;
  if (!stalled?.driver || !stalled.move_id)
    throw new Error("Expected failed move");
  await expect(
    f.t.mutation(internal.edgeRunLease.activateMove, {
      conversation_id: f.conversation,
      move_id: stalled.move_id,
      bearer: f.targetToken,
      daemon_boot_id: targetBoot,
      runtime_id: "target-runtime",
      operation_id: "target-operation",
    }),
  ).rejects.toThrow("The session owner must choose");
  await f.t.run(({ db }) => db.delete(cursor));
  await f.t.finishAllScheduledFunctions(() => jest.runOnlyPendingTimers());
  expect((await f.readHead())?.device_move).toEqual(stalled);
  expect(await f.force()).toBe(stalled.move_id);
  expect((await f.readHead())?.device_move).toEqual(stalled);
  expect(
    await f.force(device, {
      move_id: stalled.move_id,
      revision: stalled.driver.revision,
    }),
  ).toBe(stalled.move_id);
  expect((await f.readHead())?.device_move?.driver).toMatchObject({
    step: "activate",
    revision: stalled.driver.revision + 1,
    retries: 0,
  });
  expect((await f.readHead())?.device_move?.driver?.last_error).toBeUndefined();
  await f.t.finishAllScheduledFunctions(() => jest.runOnlyPendingTimers());
  expect((await f.readHead())?.current_epoch).toBe(2);
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

test("the completed receipt requires session access and expires into the next device choice", async () => {
  const f = await fixture();
  const team = await f.t.run(async ({ db }) => {
    const rows = fixtureRows(db, "another move target");
    await rows.device(f.runner, {
      device_id: "next-target",
      label: "Next Mac",
    });
    const share = await db.query("device_shares").first();
    if (!share) throw new Error("Expected shared device");
    await db.patch(f.conversation, {
      team_id: share.team_id,
      is_private: true,
      team_visibility: "private",
    });
    return share.team_id;
  });
  await f.force();
  await f.pulse();
  await f.announceReady();
  await f.t.finishAllScheduledFunctions(() => jest.runOnlyPendingTimers());
  const receipt = (await f.readHead())?.last_device_move;
  if (!receipt) throw new Error("Expected activation receipt");
  expect(await f.next()).toEqual([]);
  await f.t.run(({ db }) =>
    db.patch(f.conversation, {
      team_id: team,
      is_private: false,
      team_visibility: "full",
    }),
  );
  expect(await f.next()).toMatchObject([
    { progress: "done", destinations: [] },
  ]);
  expect(await f.next(f.runner)).toMatchObject([
    { progress: "done", doneUntil: receipt.activated_at + 30_000 },
  ]);

  jest.setSystemTime(receipt.activated_at + 180_000);
  expect(await f.next()).toEqual([]);
  expect(await f.next(f.runner)).toMatchObject([
    {
      progress: null,
      requestedDestination: null,
      destinations: [{ id: "next-target", label: "Next Mac" }],
    },
  ]);
  const second = await asUser(f.t, f.runner).mutation(
    api.edgeRunLease.forceMove,
    {
      conversation_id: f.conversation,
      expected_source_epoch: 2,
      destination_device_id: "next-target",
      acknowledge_source_may_still_run: true,
    },
  );
  expect(second).not.toBe(receipt.move_id);
});

test.each(["prepare", "retarget"] as const)(
  "the owner's same-computer choice resumes a failed %s",
  async (step) => {
    const f = await fixture(step !== "prepare", false);
    const moveId = await f.force();
    if (step === "retarget") {
      await f.pulse();
      await f.t.run(({ db }) => db.patch(f.head, { pending_epoch: undefined }));
    }
    await f.t.finishAllScheduledFunctions(() => jest.runOnlyPendingTimers());
    const stalled = (await f.readHead())?.device_move?.driver;
    if (!stalled) throw new Error("Expected failed driver");
    expect(stalled.step).toBe("failed");
    if (step === "prepare") await f.registerTarget();
    else await f.t.run(({ db }) => db.patch(f.head, { pending_epoch: 2 }));
    await expect(
      f.t.mutation(internal.edgeRunLease.abortMove, {
        conversation_id: f.conversation,
        move_id: moveId,
        bearer: f.bearer,
      }),
    ).rejects.toThrow("Only the session owner");
    await f.pulse(30_000);
    expect((await f.readHead())?.device_move?.driver).toEqual(stalled);
    const retry = { move_id: moveId, revision: stalled.revision };
    expect(
      await f.force(device, { ...retry, revision: retry.revision - 1 }),
    ).toBe(moveId);
    expect((await f.readHead())?.device_move?.driver).toEqual(stalled);
    expect(
      await f.ownerClient.mutation(api.dispatch.dispatch, {
        action: "forceSessionMove",
        args: ["retry", f.conversation, 1, device, "Studio", true, retry],
      }),
    ).toBe(moveId);
    const resumed = (await f.readHead())?.device_move?.driver;
    expect(resumed).toMatchObject({
      step,
      revision: stalled.revision + 1,
      retries: 0,
    });
    expect(resumed?.last_error).toBeUndefined();
    if (step === "prepare") await f.pulse();
    await f.announceReady();
    await f.t.finishAllScheduledFunctions(() => jest.runOnlyPendingTimers());
    expect((await f.readHead())?.current_epoch).toBe(2);
  },
);

test.each(["unprepared", "ready"] as const)(
  "the owner can replace a failed %s destination while the source stays fenced",
  async (phase) => {
    const f = await fixture(phase === "ready");
    const replacement = "replacement-target";
    const replacementToken = presentToken(
      "move-replacement-token",
      replacement,
    );
    await f.t.run(async ({ db }) => {
      const rows = fixtureRows(db, "failed move replacement");
      await rows.device(f.owner, { device_id: replacement, label: "Backup" });
      const token = await rows.token(f.owner, "move-replacement-token");
      await db.patch(token, { device_id: replacement });
    });
    await f.t.mutation(api.executionBindings.registerExecutionDaemonBoot, {
      api_token: replacementToken,
      owner_device_id: replacement,
      daemon_boot_id: targetBoot,
    });
    const first = await f.force();
    let cursor;
    if (phase === "ready") {
      await f.pulse();
      await f.announceReady();
      const binding = await f.nextBinding();
      if (!binding) throw new Error("Expected destination binding");
      cursor = await f.t.run(({ db }) =>
        db.insert("run_event_cursors", {
          conversation_id: f.conversation,
          owner_user_id: f.runner,
          binding_id: binding._id,
          run: 2,
          last_event_seq: 0,
        }),
      );
    }
    await f.t.finishAllScheduledFunctions(() => jest.runOnlyPendingTimers());
    expect(await f.next()).toMatchObject([
      {
        progress: "failed",
        destinations: expect.arrayContaining([
          { id: replacement, label: "Backup" },
          { id: device, label: "Studio" },
        ]),
      },
    ]);
    const staged =
      phase === "ready"
        ? await f.t.run(async ({ db }) => {
            const original = await db.get(f.message);
            if (!original) throw new Error("Expected pending message");
            const { _id, _creationTime, ...fields } = original;
            const ids = [];
            for (let sequence = 2; sequence <= 102; sequence++)
              ids.push(
                await db.insert("pending_messages", {
                  ...fields,
                  client_id: `staged-${sequence}`,
                  delivery_id: `staged-${sequence}`,
                  conversation_sequence: sequence,
                  ...(sequence === 102 && {
                    status: "cancelled",
                    delivery_status: "cancelled-by-supersession",
                  }),
                }),
              );
            await db.patch(f.head, { next_conversation_sequence: 103 });
            return ids;
          })
        : [];
    await expect(
      asUser(f.t, f.runner).mutation(api.edgeRunLease.forceMove, {
        ...f.target,
        destination_device_id: replacement,
        acknowledge_source_may_still_run: true,
      }),
    ).rejects.toThrow("Only the current session owner");
    const failed = (await f.next())[0]?.failedMove;
    expect(failed?.move_id).toBe(first);
    await expect(f.force(replacement)).rejects.toThrow(
      "EXECUTION_DEVICE_MOVE_IN_PROGRESS",
    );
    const second = await f.force(replacement, failed);
    expect(second).not.toBe(first);
    expect(await f.force(replacement, failed)).toBe(second);
    expect((await f.readHead())?.current_epoch).toBe(1);
    if (phase === "ready") {
      expect(await f.nextBinding()).toMatchObject({
        state: "quarantined",
        move_id: first,
        abandoned_move: true,
      });
      await expect(
        f.t.mutation(internal.edgeRunLease.activateMove, {
          conversation_id: f.conversation,
          move_id: first,
          bearer: f.targetToken,
          daemon_boot_id: targetBoot,
          runtime_id: "target-runtime",
          operation_id: "target-operation",
        }),
      ).rejects.toThrow("The move record is missing or has changed");
      expect(
        await f.ownerClient.mutation(api.pendingMessages.sendMessageV2, {
          conversation_id: f.conversation,
          command_id: "delivery",
          client_id: "delivery",
          content: "queued",
        }),
      ).toMatchObject({ status: "acknowledged" });
      expect((await f.queue())[0]).toMatchObject({
        execution_epoch: 2,
        owner_user_id: f.runner,
      });
    }
    const source = await f.claim("while-replacing");
    expect(source.status).not.toBe("granted");
    const epoch = cursor ? 3 : 2;
    await f.pulse();
    if (cursor) {
      expect(await f.nextBinding(3)).toBeNull();
      expect(
        (await f.queue()).filter((row) => row.execution_epoch === 2),
      ).toHaveLength(2);
      await f.pulse(1);
      await f.pulse(1);
    }
    await f.announceReady(replacement, replacementToken, epoch);
    await f.t.finishAllScheduledFunctions(() => jest.runOnlyPendingTimers());
    expect(await f.readHead()).toMatchObject({
      current_epoch: epoch,
      last_device_move: {
        move_id: second,
        destination_device_id: replacement,
        moved: phase === "ready" ? 101 : 1,
      },
    });
    const queue = await f.queue();
    expect(queue.map(({ _id }) => _id)).toEqual([f.message, ...staged]);
    for (const [index, row] of queue.entries())
      expect(row).toMatchObject({
        delivery_id: index === 0 ? "delivery" : `staged-${index + 1}`,
        execution_epoch: index === 101 ? 1 : epoch,
        conversation_sequence: index + 1,
        owner_user_id: f.owner,
      });
  },
);

test.each([
  "boot change",
  "stopped",
  "quarantined",
  "start-ambiguous",
  "start-failed-before-effect",
  "retryable start failure",
] as const)("choosing the same device recovers after %s", async (failure) => {
  const f = await fixture(true, false);
  const first = await f.force();
  await f.pulse();
  const binding = await f.nextBinding();
  if (!binding) throw new Error("Expected a prepared binding");
  const currentBoot = failure === "boot change" ? "target-boot-2" : targetBoot;
  const retryable = failure === "retryable start failure";
  if (failure === "boot change") {
    await f.announceReady();
    await f.registerTarget(currentBoot);
  } else {
    await f.t.run(({ db }) =>
      db.patch(binding._id, {
        state: retryable ? "start-failed-before-effect" : failure,
        failure_retryable:
          failure === "start-failed-before-effect"
            ? false
            : retryable || undefined,
      }),
    );
  }
  await f.t.finishAllScheduledFunctions(() => jest.runOnlyPendingTimers());
  const retry = (await f.next())[0]?.failedMove;
  expect(retry?.move_id).toBe(first);
  const replacement = await f.force(device, retry);
  if (retryable) {
    expect(replacement).toBe(first);
    expect(await f.nextBinding()).toMatchObject({
      failure_retryable: true,
      move_id: first,
    });
    expect(await f.nextBinding(3)).toBeNull();
    expect((await f.readHead())?.device_move?.driver?.step).toBe("activate");
    return;
  }
  expect(replacement).not.toBe(first);
  expect(await f.force(device, retry)).toBe(replacement);
  expect(await f.nextBinding()).toMatchObject({
    move_id: first,
    abandoned_move: true,
  });
  expect(await f.readHead()).toMatchObject({
    current_epoch: 1,
    device_move: { driver: { step: "restore" } },
  });
  await f.pulse();
  expect(await f.queue()).toMatchObject([
    { _id: f.message, execution_epoch: 1, conversation_sequence: 1 },
  ]);
  await f.pulse(1);
  expect(await f.nextBinding(3)).toMatchObject({
    state: "requested",
    daemon_boot_id: currentBoot,
  });
  await f.announceReady(device, f.targetToken, 3, currentBoot);
  await f.t.finishAllScheduledFunctions(() => jest.runOnlyPendingTimers());
  expect(await f.readHead()).toMatchObject({
    current_epoch: 3,
    last_device_move: { move_id: replacement, destination_device_id: device },
  });
  expect(await f.queue()).toMatchObject([
    { _id: f.message, execution_epoch: 3, conversation_sequence: 1 },
  ]);
});
