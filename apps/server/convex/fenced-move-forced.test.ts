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

const forcedFlag = "CODECAST_FORCED_DEVICE_MOVE_V1";
const edgeFlag = "CODECAST_EDGE_DELIVERY_V1";
const previousForcedFlag = process.env[forcedFlag];
const previousEdgeFlag = process.env[edgeFlag];
const device = "forced-move-destination";
const destinationBoot = "destination-boot";
const runtime = "destination-runtime";
const operation = "destination-operation";

beforeEach(() => {
  jest.useFakeTimers({ now: start });
  process.env[forcedFlag] = "1";
  process.env[edgeFlag] = "1";
});

afterEach(() => {
  jest.useRealTimers();
  if (previousForcedFlag === undefined) delete process.env[forcedFlag];
  else process.env[forcedFlag] = previousForcedFlag;
  if (previousEdgeFlag === undefined) delete process.env[edgeFlag];
  else process.env[edgeFlag] = previousEdgeFlag;
});

async function fixture(crossAccount = false) {
  const f = await setupRunLease();
  const secret = "forced-move-target-token";
  const { outsider, runner } = await f.t.run(async ({ db }) => {
    const rows = fixtureRows(db, "forced device move");
    const outsider = await rows.user();
    const runner = crossAccount ? outsider : f.owner;
    const token = await rows.token(runner, secret);
    await db.patch(token, { device_id: device });
    return { outsider, runner };
  });
  const bearer = presentToken(secret, device);
  await f.t.mutation(api.executionBindings.registerExecutionDaemonBoot, {
    api_token: bearer,
    owner_device_id: device,
    daemon_boot_id: destinationBoot,
  });
  const target = {
    conversation_id: f.conversation,
    expected_source_epoch: 1,
    destination_runner_id: runner,
    destination_device_id: device,
  };
  const force = (user = f.owner) =>
    asUser(f.t, user).mutation(api.edgeRunLease.forceMove, {
      ...target,
      acknowledge_source_may_still_run: true,
    });
  const record = () => f.t.mutation(internal.edgeRunLease.recordMove, target);
  const move = (move_id: string) => {
    const address = { conversation_id: f.conversation, move_id, bearer };
    const binding = {
      conversation_id: f.conversation,
      move_id,
      api_token: bearer,
      epoch: 2,
      owner_device_id: device,
      daemon_boot_id: destinationBoot,
      protocol_version: 1,
    };
    return {
      prepare: () =>
        f.t.mutation(internal.edgeRunLease.prepareMove, {
          ...address,
          daemon_boot_id: destinationBoot,
        }),
      begin: () =>
        f.t.mutation(api.executionBindings.claimExecutionStart, {
          ...binding,
          configuration_revision: 2,
          proposed_operation_id: operation,
          required_capabilities: [...EXECUTION_PROTOCOL_CAPABILITIES],
        }),
      ready: () =>
        f.t.mutation(api.executionBindings.publishReadyBinding, {
          ...binding,
          requested_agent: "codex",
          actual_agent: "codex",
          transport: "app-server",
          handle: "destination-handle",
          runtime_id: runtime,
          operation_id: operation,
          applied_configuration_revision: 2,
          capabilities: [...EXECUTION_PROTOCOL_CAPABILITIES],
        }),
      retarget: () => f.t.mutation(internal.edgeRunLease.retargetMove, address),
      activate: () =>
        f.t.mutation(internal.edgeRunLease.activateMove, {
          ...address,
          daemon_boot_id: destinationBoot,
          runtime_id: runtime,
          operation_id: operation,
        }),
    };
  };
  const sourcePermit = async () => {
    const lease = await f.claim("source");
    if (lease.status !== "granted") throw new Error("Expected a source lease");
    const fence = {
      v: 1,
      session: f.conversation,
      run: 1,
      fencing_token: lease.fencing_token,
      bearer: f.bearer,
    } as const;
    const next = await f.t.mutation(internal.edgeDelivery.next, fence);
    if (next.status !== "permit") throw new Error("Expected a source permit");
    return {
      ...fence,
      delivery_id: next.delivery_id,
      attempt_id: next.attempt_id,
      seq: next.seq,
      intent: next.intent,
      sender: next.sender,
    };
  };
  return {
    ...f,
    bearer,
    outsider,
    runner,
    target,
    force,
    record,
    move,
    sourcePermit,
  };
}

test.each(["delivery-started", "ambiguous"] as const)(
  "a forced move carries a source %s delivery to the destination in doubt",
  async (state) => {
    const f = await fixture(true);
    const permit = await f.sourcePermit();
    await f.t.mutation(internal.edgeDelivery.start, permit);
    if (state === "ambiguous")
      await f.t.mutation(internal.edgeDelivery.settle, {
        ...permit,
        outcome: "in_doubt",
      });
    jest.setSystemTime(start + leaseMs + 1);
    const moveId = await f.force();
    const move = f.move(moveId);
    const forced = { by_user_id: f.owner, at: Date.now() };
    expect(await f.t.run(({ db }) => db.get(f.head))).toMatchObject({
      device_move: { forced, settlement_deadline: forced.at },
      active_delivery_state: "ambiguous",
    });
    expect(await f.force()).toBe(moveId);
    await move.prepare();
    await expect(move.activate()).rejects.toThrow("must be ready");
    await move.begin();
    await move.ready();
    expect(await move.retarget()).toEqual({ moved: 0, done: true });
    expect(await move.activate()).toEqual({ epoch: 2 });
    const snapshot = await f.t.run(async ({ db }) => ({
      source: await db.get(f.binding),
      head: await db.get(f.head),
      row: await db.get(f.message),
      attempt: await db.get(
        db.normalizeId("delivery_attempts", permit.attempt_id)!,
      ),
      lease: await db.query("run_leases").first(),
    }));
    expect(snapshot.source).toMatchObject({
      state: "quarantined",
      forced_device_move: { ...forced, move_id: moveId, destination_epoch: 2 },
    });
    expect(snapshot.lease?.released_at).toBe(Date.now());
    expect(snapshot.head).toMatchObject({
      current_epoch: 2,
      owner_user_id: f.runner,
      active_delivery_attempt_id: permit.attempt_id,
      active_delivery_state: "ambiguous",
    });
    expect(snapshot.head?.device_move).toBeUndefined();
    expect(snapshot.row).toMatchObject({
      _id: f.message,
      owner_user_id: f.runner,
      delivery_id: permit.delivery_id,
      conversation_sequence: permit.seq,
      execution_epoch: 2,
      delivery_status: "ambiguous",
    });
    expect(snapshot.attempt).toMatchObject({
      _id: permit.attempt_id,
      execution_epoch: 2,
      forced_move_source_epoch: 1,
      state: "ambiguous",
      owner_user_id: f.runner,
      owner_device_id: device,
      daemon_boot_id: destinationBoot,
      runtime_id: runtime,
      configuration_revision: 2,
    });

    const lease = await f.t.mutation(internal.edgeRunLease.claim, {
      conversation_id: f.conversation,
      bearer: f.bearer,
      machine: device,
      boot: destinationBoot,
      claim_id: "destination",
    });
    if (lease.status !== "granted")
      throw new Error("Expected a destination lease");
    const { delivery_id, attempt_id, seq, intent, sender, ...run } = permit;
    const destinationFence = {
      ...run,
      bearer: f.bearer,
      run: 2,
      fencing_token: lease.fencing_token,
    };
    expect(
      await f.t.mutation(internal.edgeDelivery.next, destinationFence),
    ).toMatchObject({
      status: "permit",
      state: "started",
      attempt_id,
      delivery_id,
      seq,
    });
    const destinationPermit = {
      ...destinationFence,
      delivery_id,
      attempt_id,
      seq,
      intent,
      sender,
    };
    expect(
      await f.t.mutation(internal.edgeDelivery.start, destinationPermit),
    ).toMatchObject({ status: "rejected" });
    await expect(
      f.t.mutation(internal.edgeDelivery.settle, {
        ...destinationPermit,
        outcome: "applied",
      }),
    ).rejects.toThrow("resolution_evidence_required");
    expect(
      await f.t.mutation(internal.edgeDelivery.settle, {
        ...destinationPermit,
        outcome: "applied",
        resolution_evidence:
          "provider recovered a receipt for the original delivery",
      }),
    ).toMatchObject({ status: "recorded" });
    expect(
      await f.t.mutation(internal.edgeDelivery.next, destinationFence),
    ).toMatchObject({ status: "empty" });
  },
);

test("a forced move refuses the old device after it reconnects on the same account", async () => {
  const f = await fixture();
  const blob = await f.t.run(async ({ db, storage }) => {
    const id = await storage.store(new Blob(["image"], { type: "image/png" }));
    const patch = db.patch as (
      table: "_storage",
      storageId: typeof id,
      fields: { contentType: string },
    ) => Promise<void>;
    await patch("_storage", id, { contentType: "image/png" });
    await db.patch(f.message, { image_storage_id: id });
    return id;
  });
  const permit = await f.sourcePermit();
  const revokedDevice = permit.bearer;
  const { v, session, run, fencing_token, bearer, attempt_id } = permit;
  const readBlob = () =>
    f.t.query(internal.edgeDelivery.getBlob, {
      v,
      session,
      run,
      fencing_token,
      bearer,
      attempt_id,
      blob_id: blob,
    });
  await f.t.mutation(internal.edgeDelivery.start, permit);
  expect(await readBlob()).toEqual({
    storageId: blob,
    contentType: "image/png",
  });
  const move = f.move(await f.force());
  expect(
    await f.t.mutation(internal.edgeDelivery.settle, {
      ...permit,
      outcome: "applied",
    }),
  ).toMatchObject({ status: "stale" });
  await move.prepare();
  await move.begin();
  await move.ready();
  await move.retarget();
  await move.activate();
  const newBoot = "reconnected-source";
  await f.t.mutation(api.executionBindings.registerExecutionDaemonBoot, {
    api_token: revokedDevice,
    owner_device_id: machine,
    daemon_boot_id: newBoot,
  });
  const destinationClaim = {
    conversation_id: f.conversation,
    bearer: f.bearer,
    machine: device,
    boot: destinationBoot,
    claim_id: "destination-after-move",
  };
  const destinationLease = await f.t.mutation(
    internal.edgeRunLease.claim,
    destinationClaim,
  );
  if (destinationLease.status !== "granted")
    throw new Error("Expected a destination lease");
  delete process.env[forcedFlag];
  const snapshot = () =>
    f.t.run(async ({ db }) => ({
      head: await db.get(f.head),
      message: await db.get(f.message),
      binding: await db.get(f.binding),
      cursors: await db.query("run_event_cursors").collect(),
      leases: await db.query("run_leases").collect(),
    }));
  const before = await snapshot();
  const fence = f.requestFence(permit.fencing_token);
  const stale = { status: "stale" };
  expect(await f.claim("source-reconnect", { boot: newBoot })).toMatchObject(
    stale,
  );
  expect(
    await f.t.mutation(internal.edgeRunLease.claim, {
      ...destinationClaim,
      bearer: revokedDevice,
    }),
  ).toMatchObject(stale);
  expect(
    await f.t.mutation(internal.edgeDelivery.settle, {
      ...permit,
      run: 2,
      fencing_token: destinationLease.fencing_token,
      outcome: "applied",
      resolution_evidence: "old device claims receipt",
    }),
  ).toMatchObject(stale);
  expect(await f.t.mutation(internal.edgeRunLease.renew, fence)).toMatchObject(
    stale,
  );
  expect(
    await f.t.mutation(internal.edgeRunLease.release, fence),
  ).toMatchObject(stale);
  expect(
    await f.t.mutation(internal.edgeRunLease.append, {
      ...fence,
      events_json: "[]",
    }),
  ).toMatchObject(stale);
  expect(
    await f.t.mutation(internal.edgeDelivery.next, {
      v: 1,
      session: f.conversation,
      run: 1,
      bearer: revokedDevice,
      fencing_token: permit.fencing_token,
    }),
  ).toMatchObject(stale);
  expect(await f.t.mutation(internal.edgeDelivery.start, permit)).toMatchObject(
    { status: "rejected", reason: "stale" },
  );
  expect(
    await f.t.mutation(internal.edgeDelivery.settle, {
      ...permit,
      outcome: "applied",
      resolution_evidence: "old device claims receipt",
    }),
  ).toMatchObject(stale);
  expect(await readBlob()).toBeNull();

  const source = {
    conversation_id: f.conversation,
    api_token: revokedDevice,
    epoch: 1,
    owner_device_id: machine,
    daemon_boot_id: newBoot,
    configuration_revision: 1,
  };
  await expect(
    f.t.mutation(api.executionBindings.claimExecutionStart, {
      ...source,
      proposed_operation_id: "restart-source",
      protocol_version: 1,
      required_capabilities: [...EXECUTION_PROTOCOL_CAPABILITIES],
    }),
  ).rejects.toThrow("EXECUTION_DEVICE_FORCE_FENCED");
  await expect(
    f.t.mutation(api.executionBindings.publishRuntimeDisposition, {
      ...source,
      runtime_id: "runtime",
      disposition: "stopped",
      reason: "reconnected",
    }),
  ).rejects.toThrow("EXECUTION_DEVICE_FORCE_FENCED");
  await expect(
    f.t.mutation(api.executionBindings.publishRuntimeDisposition, {
      ...source,
      api_token: f.wrongUser,
      runtime_id: "runtime",
      disposition: "stopped",
      reason: "reconnected",
    }),
  ).rejects.toThrow("EXECUTION_NOT_OWNER");
  await expect(
    f.t.mutation(api.executionBindings.claimNextDelivery, {
      conversation_id: f.conversation,
      api_token: revokedDevice,
      execution_epoch: 2,
      owner_device_id: device,
      daemon_boot_id: destinationBoot,
      runtime_id: runtime,
      configuration_revision: 2,
    }),
  ).rejects.toThrow("EXECUTION_DEVICE_FORCE_FENCED");
  await expect(
    f.t.mutation(internal.edgeRunLease.recordMove, {
      ...f.target,
      expected_source_epoch: 2,
      destination_device_id: machine,
    }),
  ).rejects.toThrow("EXECUTION_DEVICE_FORCE_FENCED");
  expect(await snapshot()).toEqual(before);
});

test("force requeues an unstarted claim and refuses its old replay", async () => {
  const f = await fixture();
  const permit = await f.sourcePermit();
  const move = f.move(await f.force());
  await move.prepare();
  await move.begin();
  await move.ready();
  await expect(move.activate()).rejects.toThrow(
    "queue still needs retargeting",
  );
  expect(await move.retarget()).toEqual({ moved: 1, done: true });
  await move.activate();

  const { row, attempt } = await f.t.run(async ({ db }) => ({
    row: await db.get(f.message),
    attempt: await db.get(
      db.normalizeId("delivery_attempts", permit.attempt_id)!,
    ),
  }));
  expect(row).toMatchObject({
    delivery_id: permit.delivery_id,
    conversation_sequence: permit.seq,
    execution_epoch: 2,
    delivery_status: "pending",
  });
  expect(attempt).toMatchObject({
    state: "failed-before-effect",
    execution_epoch: 1,
  });
  const release = (api_token: string) =>
    f.t.mutation(api.executionBindings.releaseClaimBeforeEffect, {
      api_token,
      reason: "lease lost",
      evidence: "this attempt never started",
      permit: {
        conversation_id: f.conversation,
        message_id: f.message,
        attempt_id: attempt!._id,
        delivery_id: permit.delivery_id,
        conversation_sequence: String(permit.seq),
        execution_epoch: 1,
        configuration_revision: 1,
        owner_device_id: machine,
        daemon_boot_id: boot,
        runtime_id: "runtime",
      },
    });
  await expect(release(permit.bearer)).rejects.toThrow(
    "EXECUTION_DEVICE_FORCE_FENCED",
  );
  await expect(release(f.bearer)).rejects.toThrow(
    "EXECUTION_DEVICE_FORCE_FENCED",
  );
});

test("a historical head rejection cannot be replayed for a force-fenced epoch", async () => {
  const f = await fixture();
  const reject = () =>
    f.t.mutation(api.executionBindings.rejectHeadDelivery, {
      api_token: f.unbound,
      conversation_id: f.conversation,
      message_id: f.message,
      delivery_id: "delivery",
      conversation_sequence: "1",
      execution_epoch: 1,
      reason: "queued content was rejected",
    });
  expect(await reject()).toEqual({ rejected: true });
  expect(await reject()).toEqual({ rejected: true });
  const move = f.move(await f.force());
  await move.prepare();
  await move.begin();
  await move.ready();
  await move.activate();
  await expect(reject()).rejects.toThrow("delivery epoch was force-fenced");
});

test("a non-owner cannot force a move and the flag defaults to off", async () => {
  const f = await fixture();
  await expect(f.force(f.outsider)).rejects.toThrow(
    "Only the current session owner",
  );
  delete process.env[forcedFlag];
  await expect(f.force()).rejects.toThrow("Forced device moves are disabled");
  expect(
    (await f.t.run(({ db }) => db.get(f.head)))?.device_move,
  ).toBeUndefined();
});

test("the force flag does not turn lease expiry into normal move proof", async () => {
  const f = await fixture();
  const lease = await f.claim("before-normal-move");
  expect(lease.status).toBe("granted");
  jest.setSystemTime(start + leaseMs + 1);
  const move = f.move(await f.record());
  await move.prepare();
  await expect(move.begin()).rejects.toThrow(
    "source runtime has not been stopped",
  );
});

test("forcing an already prepared move closes settlement and the flag gates activation", async () => {
  const f = await fixture();
  const permit = await f.sourcePermit();
  await f.t.mutation(internal.edgeDelivery.start, permit);
  const moveId = await f.record();
  const move = f.move(moveId);
  await move.prepare();
  expect(await f.force()).toBe(moveId);
  expect(
    (await f.t.run(({ db }) => db.get(f.head)))?.active_delivery_state,
  ).toBe("ambiguous");
  await move.begin();
  await move.ready();
  delete process.env[forcedFlag];
  await expect(move.activate()).rejects.toThrow(
    "Forced device moves are disabled",
  );
  expect((await f.t.run(({ db }) => db.get(f.head)))?.current_epoch).toBe(1);
});
