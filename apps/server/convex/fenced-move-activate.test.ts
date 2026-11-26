import { formatSessionMessage } from "@codecast/messages/machineMessages";
import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { presentToken } from "@platform/auth/tokenFormat";
import { asUser } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import {
  boot,
  leaseMs,
  machine,
  setupRunLease,
  start,
} from "../test-helpers/run-lease.testkit";
import { api, internal } from "./_generated/api";
import { EXECUTION_PROTOCOL_CAPABILITIES } from "./executionBindings";

const device = "move-destination";
const destinationBoot = "destination-boot";
const destinationRuntime = "destination-runtime";
const operation = "destination-operation";
const flag = "CODECAST_EDGE_DELIVERY_V1";
const previousFlag = process.env[flag];

beforeEach(() => {
  jest.useFakeTimers({ now: start });
  process.env[flag] = "1";
});

afterEach(() => {
  jest.useRealTimers();
  if (previousFlag === undefined) delete process.env[flag];
  else process.env[flag] = previousFlag;
});

async function fixture() {
  const f = await setupRunLease();
  const secret = "destination-token";
  const wrongDeviceSecret = "destination-other-device";
  const wrongRunnerSecret = "other-runner-destination";
  const unbound = "destination-unbound";
  const destination = await f.t.run(async ({ db }) => {
    const rows = fixtureRows(db, "move destination credentials");
    const destination = await rows.user();
    for (const [owner, token, targetDevice] of [
      [destination, secret, device],
      [destination, wrongDeviceSecret, "other"],
      [f.owner, wrongRunnerSecret, device],
    ] as const) {
      const id = await rows.token(owner, token);
      await db.patch(id, { device_id: targetDevice });
    }
    await rows.token(destination, unbound);
    return destination;
  });
  const bearer = presentToken(secret, device);
  const register = (
    api_token: string,
    owner_device_id: string,
    daemon_boot_id: string,
  ) =>
    f.t.mutation(api.executionBindings.registerExecutionDaemonBoot, {
      api_token,
      owner_device_id,
      daemon_boot_id,
    });
  await register(bearer, device, destinationBoot);
  const record = async () => {
    await f.t.mutation(internal.edgeRunLease.recordMove, {
      conversation_id: f.conversation,
      destination_device_id: device,
      destination_runner_id: destination,
      expected_source_epoch: 1,
    });
    const head = await f.t.run(({ db }) => db.get(f.head));
    if (!head?.device_move?.move_id) throw new Error("Expected a move record");
    const address = {
      conversation_id: f.conversation,
      move_id: head.device_move.move_id,
    };
    const sourceAddress = { ...address, bearer: f.bearer };
    const targetAddress = { ...address, bearer };
    const authorize = {
      ...address,
      api_token: bearer,
      epoch: 2,
      owner_device_id: device,
      daemon_boot_id: destinationBoot,
    };
    const startArgs = {
      ...authorize,
      configuration_revision: 2,
      protocol_version: 1,
      proposed_operation_id: operation,
      required_capabilities: [...EXECUTION_PROTOCOL_CAPABILITIES],
    };
    const readyArgs = {
      ...authorize,
      requested_agent: "codex" as const,
      actual_agent: "codex" as const,
      transport: "app-server" as const,
      handle: "destination-handle",
      runtime_id: destinationRuntime,
      operation_id: operation,
      applied_configuration_revision: 2,
      protocol_version: 1,
      capabilities: [...EXECUTION_PROTOCOL_CAPABILITIES],
    };
    const outcomeArgs = {
      ...authorize,
      configuration_revision: 2,
      operation_id: operation,
      failure_code: "fixture",
      failure_message: "provider reply was lost",
    };
    const disposeArgs = {
      ...authorize,
      expected_state: "starting" as const,
      configuration_revision: 2,
      operation_id: operation,
      inspection: "proven-no-effect" as const,
      evidence: "provider confirmed no start",
    };

    return {
      address,
      sourceAddress,
      targetAddress,
      prepare: (
        overrides: Partial<
          typeof targetAddress & { daemon_boot_id: string }
        > = {},
      ) =>
        f.t.mutation(internal.edgeRunLease.prepareMove, {
          ...targetAddress,
          daemon_boot_id: destinationBoot,
          ...overrides,
        }),
      begin: (overrides: Partial<typeof startArgs> = {}) =>
        f.t.mutation(api.executionBindings.claimExecutionStart, {
          ...startArgs,
          ...overrides,
        }),
      ready: (overrides: Partial<typeof readyArgs> = {}) =>
        f.t.mutation(api.executionBindings.publishReadyBinding, {
          ...readyArgs,
          ...overrides,
        }),
      failed: (overrides: Partial<typeof outcomeArgs> = {}) =>
        f.t.mutation(api.executionBindings.publishStartFailedBeforeEffect, {
          ...outcomeArgs,
          ...overrides,
        }),
      ambiguous: (overrides: Partial<typeof outcomeArgs> = {}) =>
        f.t.mutation(api.executionBindings.publishStartAmbiguous, {
          ...outcomeArgs,
          ...overrides,
        }),
      dispose: (overrides: Partial<typeof disposeArgs> = {}) =>
        f.t.mutation(api.executionBindings.disposePreReadyBinding, {
          ...disposeArgs,
          ...overrides,
        }),
      stop: (
        fencing_token: string,
        overrides: Partial<typeof sourceAddress & { runtime_id: string }> = {},
      ) =>
        f.t.mutation(internal.edgeRunLease.confirmMoveSourceStop, {
          ...sourceAddress,
          daemon_boot_id: boot,
          runtime_id: "runtime",
          fencing_token,
          ...overrides,
        }),
      replacement: (daemon_boot_id: string, bearer = f.bearer) =>
        f.t.mutation(internal.edgeRunLease.confirmMoveSourceReplacementBoot, {
          ...sourceAddress,
          daemon_boot_id,
          bearer,
        }),
      retarget: (bearer = targetAddress.bearer) =>
        f.t.mutation(internal.edgeRunLease.retargetMove, {
          ...targetAddress,
          bearer,
        }),
      abort: (bearer = sourceAddress.bearer) =>
        f.t.mutation(internal.edgeRunLease.abortMove, {
          ...sourceAddress,
          bearer,
        }),
      activate: (
        bearer = targetAddress.bearer,
        runtime_id = destinationRuntime,
      ) =>
        f.t.mutation(internal.edgeRunLease.activateMove, {
          ...targetAddress,
          bearer,
          runtime_id,
          daemon_boot_id: destinationBoot,
          operation_id: operation,
        }),
    };
  };

  const lease = async () => {
    const result = await f.claim("before-move");
    if (result.status !== "granted") throw new Error("Expected a source lease");
    return result.fencing_token;
  };
  const read = () =>
    f.t.run(async ({ db }) => ({
      head: await db.get(f.head),
      conversation: await db.get(f.conversation),
      source: await db.get(f.binding),
      destination: await db
        .query("execution_bindings")
        .withIndex("by_conversation_epoch", (q) =>
          q.eq("conversation_id", f.conversation).eq("epoch", 2),
        )
        .unique(),
      message: await db.get(f.message),
      cursors: await db.query("run_event_cursors").collect(),
      projections: await db.query("run_turn_projections").collect(),
    }));
  const send = (client_id: string) =>
    asUser(f.t, f.owner).mutation(api.pendingMessages.sendMessageV2, {
      conversation_id: f.conversation,
      command_id: client_id,
      client_id,
      content: "staged message",
    });
  const queued = () =>
    f.t.run(({ db }) =>
      db
        .query("pending_messages")
        .withIndex("by_conversation_sequence", (q) =>
          q.eq("conversation_id", f.conversation),
        )
        .collect(),
    );

  return {
    ...f,
    bearer,
    sourceBearer: f.bearer,
    destination,
    record,
    lease,
    read,
    send,
    queued,
    register,
    unbound,
    wrongDevice: presentToken(wrongDeviceSecret, "other"),
    wrongRunner: presentToken(wrongRunnerSecret, device),
  };
}

test("only the recorded destination device, runner and registered boot can prepare the successor", async () => {
  const f = await fixture();
  const move = await f.record();
  for (const bearer of [f.wrongDevice, f.wrongRunner, f.unbound])
    await expect(move.prepare({ bearer })).rejects.toThrow();
  await expect(move.prepare({ move_id: "wrong move" })).rejects.toThrow(
    "move record",
  );
  await expect(
    move.prepare({ daemon_boot_id: "unregistered" }),
  ).rejects.toThrow("not registered");
  expect((await f.read()).destination).toBeNull();
  expect(await move.prepare()).toEqual({ epoch: 2 });
  expect(await move.prepare()).toEqual({ epoch: 2 });
  const state = await f.read();
  expect(state.destination).toMatchObject({
    epoch: 2,
    owner_user_id: f.destination,
    owner_device_id: device,
    daemon_boot_id: destinationBoot,
    move_id: move.address.move_id,
    state: "requested",
  });
  expect(state.head).toMatchObject({
    owner_user_id: f.owner,
    current_epoch: 1,
    pending_epoch: 2,
    admission_epoch: 2,
  });
  expect(state.conversation?.user_id).toBe(f.owner);
});

test("expiry and ordinary release do not prove a stop, but a confirmed new source boot does", async () => {
  const f = await fixture();
  const token = await f.lease();
  const move = await f.record();
  await move.prepare();
  expect(
    await f.t.mutation(internal.edgeRunLease.release, f.requestFence(token)),
  ).toMatchObject({ status: "released" });
  await expect(move.begin()).rejects.toThrow("source runtime");
  jest.setSystemTime(start + leaseMs + 1);
  await expect(move.begin()).rejects.toThrow("source runtime");
  await expect(move.stop(token)).rejects.toThrow("released or expired");
  await f.register(f.sourceBearer, machine, "replacement-source");
  await expect(move.begin()).rejects.toThrow("source runtime");
  await expect(
    move.replacement("replacement-source", f.bearer),
  ).rejects.toThrow("source device");
  await expect(move.replacement(boot)).rejects.toThrow("newly registered boot");
  await move.replacement("replacement-source");
  expect(await move.begin()).toMatchObject({ state: "claimed" });
});

test("an expired but unreleased source lease cannot confirm a stop", async () => {
  const f = await fixture();
  const token = await f.lease();
  const move = await f.record();
  await move.prepare();
  jest.setSystemTime(start + leaseMs + 1);
  await expect(move.stop(token)).rejects.toThrow("released or expired");
  await expect(move.begin()).rejects.toThrow("source runtime");
});

test.each(["ready", "failed", "ambiguous", "dispose"] as const)(
  "move %s requires the exact destination credential, move, and boot",
  async (route) => {
    const f = await fixture();
    const token = await f.lease();
    const move = await f.record();
    await move.prepare();
    await expect(move.stop("wrong token")).rejects.toThrow("recorded lease");
    await expect(move.stop(token, { bearer: f.bearer })).rejects.toThrow(
      "source device",
    );
    await move.stop(token);
    expect(await move.begin()).toMatchObject({ state: "claimed" });
    const publish = move[route];
    for (const api_token of [f.unbound, f.wrongDevice, f.wrongRunner])
      await expect(publish({ api_token })).rejects.toThrow();
    await expect(publish({ move_id: "wrong move" })).rejects.toThrow(
      "move record",
    );
    await expect(publish({ daemon_boot_id: "wrong boot" })).rejects.toThrow(
      "exact move binding",
    );
    expect((await f.read()).destination?.state).toBe("starting");
    if (route === "dispose")
      expect(await move.dispose()).toEqual({ state: "stopped" });
    else expect(await move[route]()).toMatchObject({ accepted: true });
  },
);

test("retargeting changes at most 100 old rows per call and activates the new runner together with its queue and event run", async () => {
  const f = await fixture();
  const token = await f.lease();
  const trigger = await f.t.run(async ({ db }) => {
    const cursor = await db.query("run_event_cursors").first();
    if (cursor) await db.patch(cursor._id, { last_event_seq: 7 });
    for (let seq = 2; seq <= 121; seq++) {
      await db.insert("pending_messages", {
        conversation_id: f.conversation,
        from_user_id: f.owner,
        owner_user_id: f.owner,
        status: "pending",
        created_at: start,
        retry_count: 0,
        content: "queued",
        client_id: "send-" + seq,
        delivery_id: "send-" + seq,
        delivery_protocol_version: 1,
        conversation_sequence: seq,
        execution_epoch: 1,
        delivery_status: "pending",
      });
    }
    await db.patch(f.head, { next_conversation_sequence: 122 });
    const role = await db.insert("org_roles", {
      short_id: "or-move",
      scope_type: "user",
      scope_user_id: f.owner,
      host_user_id: f.owner,
      name: "Mover",
      handle: "mover",
      scope: { project_ids: [], plan_ids: [] },
      reports_to: { kind: "user", user_id: f.owner },
      status: "active",
      created_by: f.owner,
      created_at: start,
      updated_at: start,
    });
    const anchor = await db.insert("anchors", {
      scope_type: "user",
      scope_user_id: f.owner,
      bot_user_id: f.owner,
      host_user_id: f.owner,
      conversation_id: f.conversation,
      name: "Mover",
      status: "active",
      org_role_id: role,
      created_at: start,
    });
    await db.patch(role, { anchor_id: anchor });
    return db.insert("agent_tasks", {
      user_id: f.owner,
      role_id: role,
      originating_conversation_id: f.conversation,
      title: "Role schedule",
      prompt: "Check",
      schedule_type: "once",
      mode: "propose",
      status: "scheduled",
      retry_count: 0,
      run_count: 0,
      created_at: start,
    });
  });
  const move = await f.record();
  await move.prepare();
  expect(await f.send("move-staged-send")).toMatchObject({
    status: "acknowledged",
  });
  const initial = await f.queued();
  expect(initial.at(-1)).toMatchObject({
    execution_epoch: 2,
    owner_user_id: f.destination,
    conversation_sequence: 122,
  });
  await expect(move.retarget(f.sourceBearer)).rejects.toThrow(
    "destination device",
  );
  expect(await move.retarget()).toEqual({ moved: 100, done: false });
  expect(
    (await f.queued()).filter((row) => row.execution_epoch === 1),
  ).toHaveLength(21);
  await expect(move.activate()).rejects.toThrow("must be ready");
  await move.stop(token);
  await expect(move.abort()).rejects.toThrow("stopped source");
  await move.begin();
  await move.ready();
  await expect(move.activate()).rejects.toThrow("still needs retargeting");
  expect(await move.retarget()).toEqual({ moved: 21, done: true });
  const before = await f.read();
  expect(before.conversation?.user_id).toBe(f.owner);
  expect(before.cursors.map((row) => row.owner_user_id)).toEqual([f.owner]);
  expect(await f.t.run(({ db }) => db.get(trigger))).toMatchObject({
    user_id: f.owner,
  });
  await expect(move.activate(f.wrongRunner)).rejects.toThrow(
    "destination device",
  );
  await expect(move.activate(f.bearer, "wrong runtime")).rejects.toThrow(
    "must be ready",
  );
  const candidate = before.destination!;
  await f.t.run(({ db }) => db.patch(candidate._id, { state: "quarantined" }));
  await expect(move.activate()).rejects.toThrow("must be ready");
  await f.t.run(({ db }) => db.patch(candidate._id, { state: "ready" }));
  await f.register(f.bearer, device, "replaced-destination-boot");
  await expect(move.activate()).rejects.toThrow("must be ready");
  await f.register(f.bearer, device, destinationBoot);

  expect(await move.activate()).toEqual({ epoch: 2 });
  const after = await f.read();
  expect(after.head).toMatchObject({
    owner_user_id: f.destination,
    current_epoch: 2,
    admission_epoch: 2,
  });
  expect(after.head?.device_move).toBeUndefined();
  expect(after.conversation).toMatchObject({
    user_id: f.destination,
    author_user_id: f.owner,
    owner_device_id: device,
  });
  expect(after.source?.state).toBe("stopped");
  expect(after.cursors).toMatchObject([
    { owner_user_id: f.owner, last_event_seq: 7 },
    { owner_user_id: f.destination, run: 2, last_event_seq: 7 },
  ]);
  expect(after.projections.at(-1)).toMatchObject({
    owner_user_id: f.destination,
    run: 2,
  });
  expect(await f.t.run(({ db }) => db.get(trigger))).toMatchObject({
    user_id: f.destination,
  });
  expect(await f.queued()).toEqual(
    initial.map((row) => ({
      ...row,
      owner_user_id: f.destination,
      execution_epoch: 2,
    })),
  );
  expect(await f.claim("source-after-activation")).toMatchObject({
    status: "stale",
  });
  expect(
    await f.claim("destination-lease", {
      bearer: f.bearer,
      machine: device,
      boot: destinationBoot,
    }),
  ).toMatchObject({ status: "granted", run: 2 });
});

test("product sends replay from staged and historical epoch ownership", async () => {
  const f = await fixture();
  const staged = "move-staged-replay";
  await f.t.run(async ({ db }) => {
    await db.patch(f.conversation, { owner_user_id: f.owner });
    await db.patch(f.message, {
      content: "staged message",
      status: "delivered",
      delivery_status: "delivered",
    });
  });
  const token = await f.lease();
  const move = await f.record();
  await move.prepare();
  expect(await f.send(staged)).toMatchObject({ status: "acknowledged" });
  const withoutReceipt = () =>
    f.t.run(async ({ db }) => {
      const receipt = await db
        .query("local_command_receipts")
        .withIndex("by_principal_command", (q) =>
          q.eq("principal_id", f.owner).eq("command_id", staged),
        )
        .unique();
      if (!receipt) throw new Error("Expected a send receipt");
      await db.delete(receipt._id);
    });
  const before = await f.queued();
  expect(before.at(-1)).toMatchObject({
    execution_epoch: 2,
    owner_user_id: f.destination,
  });
  await withoutReceipt();
  expect(await f.send(staged)).toMatchObject({ status: "acknowledged" });
  expect(await f.queued()).toEqual(before);

  await move.stop(token);
  await move.begin();
  await move.ready();
  await move.activate();
  expect((await f.read()).conversation?.user_id).toBe(f.destination);
  await withoutReceipt();
  expect(await f.send(staged)).toMatchObject({ status: "acknowledged" });
  expect(await f.send("delivery")).toMatchObject({ status: "acknowledged" });
  expect(await f.queued()).toEqual(before);
});

test("a ready destination cannot activate while the recorded source attempt is ambiguous", async () => {
  const f = await fixture();
  const token = await f.lease();
  const fence = {
    v: 1,
    session: f.conversation,
    run: 1,
    fencing_token: token,
    bearer: f.sourceBearer,
  } as const;
  const next = await f.t.mutation(internal.edgeDelivery.next, fence);
  if (next.status !== "permit") throw new Error("Expected a source permit");
  const permit = {
    ...fence,
    delivery_id: next.delivery_id,
    attempt_id: next.attempt_id,
    seq: next.seq,
    intent: next.intent,
    sender: next.sender,
  };
  expect(await f.t.mutation(internal.edgeDelivery.start, permit)).toMatchObject(
    { status: "started" },
  );
  const move = await f.record();
  await move.prepare();
  await move.stop(token);
  await move.begin();
  await move.ready();
  expect((await f.read()).head?.active_delivery_state).toBe("ambiguous");
  await expect(move.activate()).rejects.toThrow(
    "source delivery attempt is not terminal",
  );
  expect((await f.read()).head?.owner_user_id).toBe(f.owner);
});

test("abort pauses sends, restores staged rows, and requires a fresh source lease", async () => {
  const f = await fixture();
  const token = await f.lease();
  const move = await f.record();
  await move.prepare();
  expect(await move.retarget()).toEqual({ moved: 1, done: true });
  await f.send("before-abort");
  const staged = await f.queued();
  expect(staged.map((message) => message.execution_epoch)).toEqual([2, 2]);
  await expect(move.abort(f.bearer)).rejects.toThrow("source device");
  expect(await move.abort()).toEqual({ done: false });
  await expect(f.send("paused-send")).rejects.toThrow(
    "fenced by a device move",
  );
  await expect(move.retarget()).rejects.toThrow("source device");
  expect(await move.retarget(f.sourceBearer)).toEqual({ moved: 2, done: true });
  const state = await f.read();
  expect(state.head).toMatchObject({
    owner_user_id: f.owner,
    current_epoch: 1,
    admission_epoch: 1,
  });
  expect(state.destination).toBeNull();
  expect(state.head?.device_move).toBeUndefined();
  expect(await f.queued()).toEqual(
    staged.map((row) => ({
      ...row,
      owner_user_id: f.owner,
      execution_epoch: 1,
    })),
  );
  expect(await f.claim("before-move")).toMatchObject({ status: "stale" });
  expect(
    await f.t.mutation(internal.edgeRunLease.renew, f.requestFence(token)),
  ).toMatchObject({ status: "stale" });
  await expect(f.deliver()).rejects.toThrow("STALE_RUN_LEASE");
  const renewed = await f.claim("source-new-claim");
  expect(renewed).toMatchObject({ status: "granted", run: 1 });
  if (renewed.status !== "granted")
    throw new Error("Expected a new source lease");
  expect(renewed.fencing_token).not.toBe(token);
  expect(await f.deliver(renewed.fencing_token)).toMatchObject({
    state: "claimed",
  });
});

test("aborting a move that had no source claim still requires a lease before delivery", async () => {
  const f = await fixture();
  const move = await f.record();
  expect(await move.abort()).toEqual({ done: true });
  await expect(f.deliver()).rejects.toThrow("STALE_RUN_LEASE");
});

test("staged queue ownership grants the destination no reader or echo authority before activation", async () => {
  const f = await fixture();
  const third = await f.t.run(async ({ db }) => {
    const rows = fixtureRows(db, "fenced move queue authority");
    const third = await rows.user();
    await db.patch(f.message, {
      from_user_id: third,
      content: formatSessionMessage("sender", "waiting for the move"),
    });
    return { writer: await rows.conversation(f.destination) };
  });
  const token = await f.lease();
  const move = await f.record();
  await move.prepare();
  await move.retarget();
  const status = (user: typeof f.owner) =>
    asUser(f.t, user).query(api.pendingMessages.getMessageStatus, {
      message_id: f.message,
    });
  const links = () =>
    asUser(f.t, f.destination).query(api.sessionThreads.listSessionThreads, {});
  expect(await status(f.owner)).toMatchObject({ status: "pending" });
  await expect(status(f.destination)).rejects.toThrow("Unauthorized");
  expect((await links()).links).toEqual([]);

  await asUser(f.t, f.destination).mutation(api.messages.addMessages, {
    conversation_id: third.writer,
    echo_ids: true,
    messages: [
      {
        role: "user",
        content: "unrelated echo",
        message_uuid: "other-echo",
        delivery_ids: [f.message],
      },
    ],
  });
  expect((await f.read()).message?.echo_message_id).toBeUndefined();
  await move.stop(token);
  await move.begin();
  await move.ready();
  await move.activate();
  await expect(status(f.owner)).rejects.toThrow("Unauthorized");
  expect(await status(f.destination)).toMatchObject({ status: "pending" });
  expect((await links()).links).toMatchObject([{ _id: f.message }]);
});

test("activation requires the recorded attempt even after the active slot is clear", async () => {
  const f = await fixture();
  const token = await f.lease();
  const fence = {
    v: 1,
    session: f.conversation,
    run: 1,
    fencing_token: token,
    bearer: f.sourceBearer,
  } as const;
  const next = await f.t.mutation(internal.edgeDelivery.next, fence);
  if (next.status !== "permit") throw new Error("Expected a source permit");
  const permit = {
    ...fence,
    delivery_id: next.delivery_id,
    attempt_id: next.attempt_id,
    seq: next.seq,
    intent: next.intent,
    sender: next.sender,
  };
  await f.t.mutation(internal.edgeDelivery.start, permit);
  const move = await f.record();
  await move.prepare();
  expect(
    await f.t.mutation(internal.edgeDelivery.settle, {
      ...permit,
      outcome: "applied",
    }),
  ).toMatchObject({ status: "recorded" });
  await move.stop(token);
  await move.begin();
  await move.ready();

  const attempt = await f.t.run(async ({ db }) => {
    const id = db.normalizeId("delivery_attempts", next.attempt_id)!;
    const row = await db.get(id);
    if (!row) throw new Error("Expected recorded attempt");
    await db.patch(id, { completed_at: undefined });
    return row;
  });
  await expect(move.activate()).rejects.toThrow(
    "source delivery attempt is not terminal",
  );
  await f.t.run(({ db }) =>
    db.patch(attempt._id, { completed_at: attempt.completed_at }),
  );
  expect(await move.activate()).toEqual({ epoch: 2 });
});

test("abort refuses a started destination and accepts an exact pre-effect disposal", async () => {
  const f = await fixture();
  await f.lease();
  const move = await f.record();
  await move.prepare();
  jest.setSystemTime(start + 1);
  await f.register(f.sourceBearer, machine, "source-next-boot");
  await move.replacement("source-next-boot");
  await move.begin();
  await expect(move.abort()).rejects.toThrow("must be disposed");
  await move.dispose();
  expect(await move.abort()).toEqual({ done: false });
  expect(await move.retarget(f.sourceBearer)).toEqual({ moved: 0, done: true });
  expect(await f.claim("old-boot-new-claim")).toMatchObject({
    status: "stale",
  });
});

test("activation rechecks boot proof if the source registers another boot", async () => {
  const f = await fixture();
  const move = await f.record();
  await move.prepare();
  jest.setSystemTime(start + 1);
  await f.register(f.sourceBearer, machine, "source-next-boot");
  await move.replacement("source-next-boot");
  await move.begin();
  await move.ready();
  await move.retarget();
  jest.setSystemTime(start + 2);
  await f.register(f.sourceBearer, machine, "source-later-boot");
  await expect(move.activate()).rejects.toThrow("source runtime");
  await move.replacement("source-later-boot");
  expect(await move.activate()).toEqual({ epoch: 2 });
  expect((await f.read()).source?.state).toBe("quarantined");
});

test("a recorded step-one move can acquire its identity without resetting settlement", async () => {
  const f = await fixture();
  await f.record();
  const prior = (await f.read()).head!.device_move!;
  await f.t.run(({ db }) =>
    db.patch(f.head, {
      device_move: { ...prior, move_id: undefined, recorded_at: undefined },
    }),
  );
  jest.setSystemTime(start + 1);
  const upgraded = await f.record();
  expect((await f.read()).head?.device_move).toEqual({
    ...prior,
    move_id: upgraded.address.move_id,
    recorded_at: start + 1,
  });
  expect((await f.record()).address.move_id).toBe(upgraded.address.move_id);
  expect(await upgraded.prepare()).toEqual({ epoch: 2 });
});
