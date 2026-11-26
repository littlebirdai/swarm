import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { scheduledJobs } from "../test-helpers/database.testkit";
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
import type { Id } from "./_generated/dataModel";
import {
  assertMoveSettlement,
  DEVICE_MOVE_FENCE,
} from "./lib/edge/device-move.state";

const flag = "CODECAST_EDGE_DELIVERY_V1";
const previousFlag = process.env[flag];
const stale = { v: 1, status: "stale" };
const staleStart = { v: 1, status: "rejected", reason: "stale" };
const windowMs = 10_000;

beforeEach(() => {
  process.env[flag] = "1";
  jest.useFakeTimers({ now: start });
});

afterEach(() => {
  if (previousFlag === undefined) delete process.env[flag];
  else process.env[flag] = previousFlag;
  jest.useRealTimers();
});

async function fixture() {
  const f = await setupRunLease();
  const destination = await f.t.run(({ db }) =>
    fixtureRows(db, "destination runner").user(),
  );
  const moveArgs = {
    conversation_id: f.conversation,
    expected_source_epoch: 1,
    destination_device_id: "destination",
    destination_runner_id: destination,
  };
  const record = () => f.t.mutation(internal.edgeRunLease.recordMove, moveArgs);
  const grant = async () => {
    const result = await f.claim("source");
    if (result.status !== "granted") throw new Error("Expected a lease");
    const { v, session, run, fencing_token } = result;
    return { v, session, run, fencing_token, bearer: f.bearer };
  };
  const permit = async (fence: Awaited<ReturnType<typeof grant>>) => {
    const result = await f.t.mutation(internal.edgeDelivery.next, fence);
    if (result.status !== "permit") throw new Error("Expected a permit");
    const { delivery_id, attempt_id, seq, intent, sender } = result;
    return { ...fence, delivery_id, attempt_id, seq, intent, sender };
  };
  const rows = (attemptId?: string) =>
    f.t.run(async ({ db }) => ({
      head: await db.get(f.head),
      conversation: await db.get(f.conversation),
      message: await db.get(f.message),
      lease: await db.query("run_leases").first(),
      cursor: await db.query("run_event_cursors").unique(),
      attempt: attemptId
        ? await db.get(attemptId as Id<"delivery_attempts">)
        : null,
    }));
  const verifyMoveSettlement = (delivery: Awaited<ReturnType<typeof permit>>) =>
    f.t.run(async (ctx) => {
      const head = await ctx.db.get(f.head);
      const attemptId = ctx.db.normalizeId(
        "delivery_attempts",
        delivery.attempt_id,
      );
      const attempt = attemptId && (await ctx.db.get(attemptId));
      if (!head || !attempt) throw new Error("Expected a started attempt");
      await assertMoveSettlement(ctx, head, attempt, {
        conversationId: f.conversation,
        executionEpoch: delivery.run,
        configurationRevision: attempt.configuration_revision,
        ownerDeviceId: attempt.owner_device_id,
        daemonBootId: attempt.daemon_boot_id,
        runtimeId: attempt.runtime_id,
        attemptId: attempt._id,
        messageId: f.message,
        deliveryId: delivery.delivery_id,
        conversationSequence: delivery.seq,
        fencingToken: delivery.fencing_token,
        now: Date.now(),
      });
    });
  const accountFence = {
    conversation_id: f.conversation,
    execution_epoch: 1,
    configuration_revision: 1,
    owner_device_id: machine,
    daemon_boot_id: boot,
    runtime_id: "runtime",
  };
  return {
    ...f,
    moveArgs,
    record,
    grant,
    permit,
    rows,
    verifyMoveSettlement,
    accountFence,
    api_token: f.bearer,
  };
}

test("record preserves source and destination identity and clears an unstarted claim", async () => {
  const f = await fixture();
  const permit = await f.permit(await f.grant());
  const before = await f.rows(permit.attempt_id);
  await f.record();
  jest.setSystemTime(start + 1);
  await f.record();
  const after = await f.rows(permit.attempt_id);
  expect(after.head?.device_move).toEqual({
    source_epoch: 1,
    source_lease_id: before.lease?._id,
    attempt_id: permit.attempt_id,
    destination_device_id: f.moveArgs.destination_device_id,
    destination_runner_id: f.moveArgs.destination_runner_id,
    next_epoch: 2,
    settlement_deadline: start,
  });
  expect(after.head).toMatchObject({
    owner_user_id: f.owner,
    current_epoch: 1,
    admission_epoch: 1,
    next_nonterminal_sequence: permit.seq,
  });
  expect(after.head?.active_delivery_attempt_id).toBeUndefined();
  expect(after.head?.active_delivery_state).toBeUndefined();
  expect(after.attempt?.state).toBe("failed-before-effect");
  expect(after.message).toMatchObject({
    _id: f.message,
    delivery_status: "pending",
    delivery_id: permit.delivery_id,
    conversation_sequence: permit.seq,
  });
  expect(after.message?.active_delivery_attempt_id).toBeUndefined();
  expect(after.conversation).toEqual(before.conversation);
  expect(
    await f.t.mutation(internal.edgeDelivery.settle, {
      ...permit,
      outcome: "failed",
    }),
  ).toEqual(stale);
  expect(
    await scheduledJobs(f.t, internal.edgeRunLease.expireMove),
  ).toHaveLength(0);
  await expect(
    f.t.mutation(internal.edgeRunLease.recordMove, {
      ...f.moveArgs,
      destination_device_id: "different",
    }),
  ).rejects.toThrow(DEVICE_MOVE_FENCE);
});

test("lease claim rejects replay and a fresh claim after the move", async () => {
  const f = await fixture();
  await f.grant();
  await f.record();
  expect(await f.claim("source")).toEqual(stale);
  jest.setSystemTime(start + leaseMs);
  expect(await f.claim("replacement")).toEqual(stale);
});

test("lease renew leaves the source lease deadline intact", async () => {
  const f = await fixture();
  const { fencing_token } = await f.grant();
  const request = f.requestFence(fencing_token);
  await f.record();
  jest.setSystemTime(start + 1);
  expect(await f.t.mutation(internal.edgeRunLease.renew, request)).toEqual(
    stale,
  );
  expect((await f.rows()).lease?.expires_at).toBe(start + leaseMs);
});

test("event append rejects the source before the cursor advances", async () => {
  const f = await fixture();
  const { fencing_token } = await f.grant();
  const request = f.requestFence(fencing_token);
  const append = (seq: number) =>
    f.t.mutation(internal.edgeRunLease.append, {
      ...request,
      events_json: JSON.stringify([
        {
          v: 1,
          session: f.conversation,
          run: 1,
          turn: "turn",
          source: "provider",
          kind: "turn.started",
          at: start,
          seq,
          body: {},
        },
      ]),
    });
  expect(await append(1)).toMatchObject({ status: "appended", through_seq: 1 });
  await f.record();
  expect(await append(2)).toEqual({ session: f.conversation, status: "stale" });
  expect((await f.rows()).cursor?.last_event_seq).toBe(1);
});

test("permits next rejects the source even when a pending row is available", async () => {
  const f = await fixture();
  const fence = await f.grant();
  await f.record();
  expect(await f.t.mutation(internal.edgeDelivery.next, fence)).toEqual(stale);
  const after = await f.rows();
  expect(after.head?.active_delivery_attempt_id).toBeUndefined();
  expect(after.message?.delivery_status).toBe("pending");
});

test("delivery start rejects replay of the source's started permit", async () => {
  const f = await fixture();
  const permit = await f.permit(await f.grant());
  expect(await f.t.mutation(internal.edgeDelivery.start, permit)).toMatchObject(
    { status: "started" },
  );
  await f.record();
  expect(await f.t.mutation(internal.edgeDelivery.start, permit)).toEqual(
    staleStart,
  );
});

test("blob reads stop for the same started permit as soon as the move exists", async () => {
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
  const permit = await f.permit(await f.grant());
  const { attempt_id, v, session, run, fencing_token, bearer } = permit;
  const read = () =>
    f.t.query(internal.edgeDelivery.getBlob, {
      v,
      session,
      run,
      fencing_token,
      bearer,
      attempt_id,
      blob_id: blob,
    });
  expect(await f.t.mutation(internal.edgeDelivery.start, permit)).toMatchObject(
    { status: "started" },
  );
  expect(await read()).toEqual({ storageId: blob, contentType: "image/png" });
  await f.record();
  expect(await read()).toBeNull();
});

test("execution start claim rejects a valid source request", async () => {
  const f = await fixture();
  const {
    conversation_id,
    configuration_revision,
    owner_device_id,
    daemon_boot_id,
  } = f.accountFence;
  const claim = () =>
    f.t.mutation(api.executionBindings.claimExecutionStart, {
      conversation_id,
      configuration_revision,
      owner_device_id,
      daemon_boot_id,
      epoch: 1,
      protocol_version: 1,
      required_capabilities: [...EXECUTION_PROTOCOL_CAPABILITIES],
      proposed_operation_id: "operation",
      api_token: f.api_token,
    });
  expect(await claim()).toMatchObject({ state: "ready" });
  await f.record();
  await expect(claim()).rejects.toThrow(DEVICE_MOVE_FENCE);
});

test("execution delivery claim and head rejection cannot bypass the move fence", async () => {
  const f = await fixture();
  await f.record();
  await expect(
    f.t.mutation(api.executionBindings.claimNextDelivery, {
      ...f.accountFence,
      api_token: f.api_token,
    }),
  ).rejects.toThrow(DEVICE_MOVE_FENCE);
  await expect(
    f.t.mutation(api.executionBindings.rejectHeadDelivery, {
      conversation_id: f.conversation,
      message_id: f.message,
      delivery_id: "delivery",
      conversation_sequence: "1",
      execution_epoch: 1,
      reason: "refuse delivery",
      api_token: f.api_token,
    }),
  ).rejects.toThrow(DEVICE_MOVE_FENCE);
  expect((await f.rows()).message?.delivery_status).toBe("pending");
});

async function accountPermit(f: Awaited<ReturnType<typeof fixture>>) {
  const result = await f.t.mutation(api.executionBindings.claimNextDelivery, {
    ...f.accountFence,
    api_token: f.api_token,
  });
  expect(result.state).toBe("claimed");
  return {
    ...f.accountFence,
    message_id: f.message,
    delivery_id: "delivery",
    conversation_sequence: "1",
    attempt_id: result.permit.attemptId as Id<"delivery_attempts">,
  };
}

test("execution claim release rejects replay after the move cleared the claim", async () => {
  const f = await fixture();
  const permit = await accountPermit(f);
  await f.record();
  await expect(
    f.t.mutation(api.executionBindings.releaseClaimBeforeEffect, {
      permit,
      api_token: f.api_token,
      reason: "release",
      evidence: "no effect",
    }),
  ).rejects.toThrow(DEVICE_MOVE_FENCE);
  expect((await f.rows(permit.attempt_id)).attempt?.failure_code).toBe(
    DEVICE_MOVE_FENCE,
  );
});

test("execution permit start cannot replay without the source lease after a move", async () => {
  const f = await fixture();
  const permit = await accountPermit(f);
  expect(
    await f.t.mutation(api.executionBindings.startDelivery, {
      permit,
      api_token: f.api_token,
    }),
  ).toMatchObject({ state: "delivery-started" });
  await f.record();
  await expect(
    f.t.mutation(api.executionBindings.startDelivery, {
      permit,
      api_token: f.api_token,
    }),
  ).rejects.toThrow(DEVICE_MOVE_FENCE);
  expect((await f.rows(permit.attempt_id)).attempt?.state).toBe("ambiguous");
});

test("execution ambiguity and risk resend cannot bypass the move fence", async () => {
  const f = await fixture();
  const permit = await accountPermit(f);
  await f.t.mutation(api.executionBindings.startDelivery, {
    permit,
    api_token: f.api_token,
  });
  await f.record();
  await expect(
    f.t.mutation(api.executionBindings.abandonAmbiguousAndResend, {
      permit,
      api_token: f.api_token,
      new_client_id: "resend",
      resolution_evidence: "risk accepted",
    }),
  ).rejects.toThrow(DEVICE_MOVE_FENCE);
  await expect(
    f.t.mutation(api.executionBindings.resolveAmbiguousDelivery, {
      permit,
      api_token: f.api_token,
      resolution: "proven-no-effect",
      resolution_evidence: "daemon report",
    }),
  ).rejects.toThrow(DEVICE_MOVE_FENCE);
  expect((await f.rows(permit.attempt_id)).message?.delivery_status).toBe(
    "ambiguous",
  );
});

test("only the recorded started attempt can settle during the window", async () => {
  const f = await fixture();
  const fence = await f.grant();
  const old = await f.permit(fence);
  await f.t.mutation(internal.edgeDelivery.start, old);
  await f.t.mutation(internal.edgeDelivery.settle, {
    ...old,
    outcome: "failed",
  });
  const current = await f.permit(fence);
  expect(current.attempt_id).not.toBe(old.attempt_id);
  expect(current.delivery_id).toBe(old.delivery_id);
  expect(current.seq).toBe(old.seq);
  await f.t.mutation(internal.edgeDelivery.start, current);
  await f.record();
  jest.setSystemTime(start + windowMs - 1);
  expect(
    await f.t.mutation(internal.edgeDelivery.settle, {
      ...old,
      outcome: "failed",
    }),
  ).toEqual(stale);
  expect(
    await f.t.mutation(internal.edgeDelivery.settle, {
      ...current,
      outcome: "applied",
    }),
  ).toEqual({ v: 1, status: "recorded" });
  const after = await f.rows(current.attempt_id);
  expect(after.attempt?.state).toBe("delivered");
  expect(after.message?.delivery_status).toBe("delivered");
  expect(after.head?.active_delivery_attempt_id).toBeUndefined();
  await f.t.finishAllScheduledFunctions(() => jest.runAllTimers());
  expect((await f.rows(current.attempt_id)).attempt?.state).toBe("delivered");
});

test("a different current lease cannot settle the recorded attempt", async () => {
  const f = await fixture();
  const permit = await f.permit(await f.grant());
  await f.t.mutation(internal.edgeDelivery.start, permit);
  await f.record();
  const replacementToken = "replacement-token";
  await f.t.run(async ({ db }) => {
    const lease = await db.query("run_leases").unique();
    if (!lease) throw new Error("Expected the source lease");
    const { _id, _creationTime, ...fields } = lease;
    await db.insert("run_leases", {
      ...fields,
      claim_id: "replacement-claim",
      fencing_token: replacementToken,
    });
    await db.patch(f.binding, { claim_id: "replacement-claim" });
  });
  expect(
    await f.t.mutation(internal.edgeDelivery.settle, {
      ...permit,
      fencing_token: replacementToken,
      outcome: "applied",
    }),
  ).toEqual(stale);
  expect((await f.rows(permit.attempt_id)).attempt?.state).toBe(
    "delivery-started",
  );
});

test.each(["before", "during"] as const)(
  "source settlement leaves delivery evidence for an attempt that became ambiguous %s the move",
  async (when) => {
    const f = await fixture();
    const permit = await f.permit(await f.grant());
    await f.t.mutation(internal.edgeDelivery.start, permit);
    if (when === "during") await f.record();
    expect(
      await f.t.mutation(internal.edgeDelivery.settle, {
        ...permit,
        outcome: "in_doubt",
      }),
    ).toEqual({ v: 1, status: "recorded" });
    jest.setSystemTime(start + 1);
    if (when === "before") await f.record();
    const before = await f.rows(permit.attempt_id);
    expect(before.head?.device_move?.settlement_deadline).toBe(
      when === "before" ? start + 1 : start + windowMs,
    );
    expect(before.head?.active_delivery_state).toBe("ambiguous");
    for (const outcome of ["failed", "applied", "rejected"] as const) {
      expect(
        await f.t.mutation(internal.edgeDelivery.settle, {
          ...permit,
          outcome,
          resolution_evidence: "source report",
        }),
      ).toEqual(stale);
    }
    expect(await f.rows(permit.attempt_id)).toEqual(before);
  },
);

test.each(["applied", "failed", "in_doubt"] as const)(
  "an exact %s replay is read-only and needs a live move window",
  async (outcome) => {
    const f = await fixture();
    const permit = await f.permit(await f.grant());
    await f.t.mutation(internal.edgeDelivery.start, permit);
    await f.record();
    const settle = (args: {
      outcome: "applied" | "failed" | "in_doubt";
      resolution_evidence?: string;
    }) => f.t.mutation(internal.edgeDelivery.settle, { ...permit, ...args });
    expect(await settle({ outcome })).toEqual({ v: 1, status: "recorded" });
    const recorded = await f.rows(permit.attempt_id);
    jest.setSystemTime(start + 1);
    expect(await settle({ outcome })).toEqual({ v: 1, status: "duplicate" });
    const different = outcome === "applied" ? "failed" : "applied";
    expect(await settle({ outcome: different })).toEqual(stale);
    expect(
      await settle({
        outcome: different,
        resolution_evidence: "source report",
      }),
    ).toEqual(stale);
    expect(await f.rows(permit.attempt_id)).toEqual(recorded);

    jest.setSystemTime(start + windowMs);
    expect(await settle({ outcome })).toEqual(stale);
    expect(await f.rows(permit.attempt_id)).toEqual(recorded);
  },
);

test("an exact settlement replay is stale after release of the recorded lease", async () => {
  const f = await fixture();
  const permit = await f.permit(await f.grant());
  await f.t.mutation(internal.edgeDelivery.start, permit);
  await f.record();
  const settle = () =>
    f.t.mutation(internal.edgeDelivery.settle, {
      ...permit,
      outcome: "applied",
    });
  expect(await settle()).toEqual({ v: 1, status: "recorded" });
  jest.setSystemTime(start + 1);
  expect(
    await f.t.mutation(
      internal.edgeRunLease.release,
      f.requestFence(permit.fencing_token),
    ),
  ).toEqual({ v: 1, status: "released" });
  const released = await f.rows(permit.attempt_id);
  expect(await settle()).toEqual(stale);
  expect(await f.rows(permit.attempt_id)).toEqual(released);
});

test.each(["attempt", "slot", "recorded attempt"] as const)(
  "the settlement rule refuses a mismatch in the %s",
  async (field) => {
    const f = await fixture();
    const permit = await f.permit(await f.grant());
    await f.t.mutation(internal.edgeDelivery.start, permit);
    await f.record();
    await f.verifyMoveSettlement(permit);
    await f.t.run(async ({ db }) => {
      const head = await db.get(f.head);
      if (!head?.device_move || !head.active_delivery_attempt_id)
        throw new Error("Expected a recorded attempt");
      if (field === "attempt")
        await db.patch(head.active_delivery_attempt_id, { state: "ambiguous" });
      else if (field === "slot")
        await db.patch(f.head, { active_delivery_state: "ambiguous" });
      else
        await db.patch(f.head, {
          device_move: { ...head.device_move, attempt_id: undefined },
        });
    });
    await expect(f.verifyMoveSettlement(permit)).rejects.toThrow(
      DEVICE_MOVE_FENCE,
    );
  },
);

test("releasing the source lease closes settlement and permits immediate expiry", async () => {
  const f = await fixture();
  const permit = await f.permit(await f.grant());
  await f.t.mutation(internal.edgeDelivery.start, permit);
  await f.record();
  jest.setSystemTime(start + 1);
  expect(
    await f.t.mutation(
      internal.edgeRunLease.release,
      f.requestFence(permit.fencing_token),
    ),
  ).toEqual({ v: 1, status: "released" });
  const released = await f.rows(permit.attempt_id);
  expect(released.lease?.released_at).toBe(start + 1);
  expect(
    await f.t.mutation(internal.edgeDelivery.settle, {
      ...permit,
      outcome: "applied",
    }),
  ).toEqual(stale);
  expect(await f.claim("replacement")).toEqual(stale);
  expect(await f.rows(permit.attempt_id)).toEqual(released);

  await expect(f.verifyMoveSettlement(permit)).rejects.toThrow(
    DEVICE_MOVE_FENCE,
  );

  await f.t.mutation(internal.edgeRunLease.expireMove, {
    head_id: f.head,
    source_epoch: 1,
  });
  expect(await f.rows(permit.attempt_id)).toMatchObject({
    head: {
      active_delivery_state: "ambiguous",
      active_delivery_attempt_id: permit.attempt_id,
    },
    message: { delivery_status: "ambiguous" },
    attempt: { state: "ambiguous", failure_code: "MOVE_SETTLEMENT_EXPIRED" },
  });
});

test("expiry leaves a live window alone and applies only once after the deadline", async () => {
  const f = await fixture();
  const permit = await f.permit(await f.grant());
  await f.t.mutation(internal.edgeDelivery.start, permit);
  await f.record();
  const expire = (source_epoch: number) =>
    f.t.mutation(internal.edgeRunLease.expireMove, {
      head_id: f.head,
      source_epoch,
    });
  const before = await f.rows(permit.attempt_id);
  jest.setSystemTime(start + windowMs - 1);
  await expire(1);
  expect(await f.rows(permit.attempt_id)).toEqual(before);

  jest.setSystemTime(start + windowMs + 1);
  await expire(2);
  expect(await f.rows(permit.attempt_id)).toEqual(before);
  await expire(1);
  const expired = await f.rows(permit.attempt_id);
  expect(expired).toMatchObject({
    head: {
      active_delivery_state: "ambiguous",
      active_delivery_attempt_id: permit.attempt_id,
    },
    message: { delivery_status: "ambiguous" },
    attempt: { state: "ambiguous", failure_code: "MOVE_SETTLEMENT_EXPIRED" },
  });
  jest.setSystemTime(start + windowMs + 2);
  await expire(1);
  expect(await f.rows(permit.attempt_id)).toEqual(expired);
});

test.each([
  { boundary: "move deadline", recordAt: start, expiresAt: start + windowMs },
  {
    boundary: "lease expiry",
    recordAt: start + leaseMs - 1_000,
    expiresAt: start + leaseMs,
  },
])(
  "settlement closes and becomes ambiguous at the $boundary",
  async ({ recordAt, expiresAt }) => {
    const f = await fixture();
    const permit = await f.permit(await f.grant());
    await f.t.mutation(internal.edgeDelivery.start, permit);
    jest.setSystemTime(recordAt);
    await f.record();
    const jobs = await scheduledJobs(f.t, internal.edgeRunLease.expireMove);
    expect(jobs.map((job) => job.scheduledTime)).toEqual([expiresAt]);
    jest.setSystemTime(expiresAt);
    expect(
      await f.t.mutation(internal.edgeDelivery.settle, {
        ...permit,
        outcome: "applied",
      }),
    ).toEqual(stale);
    jest.setSystemTime(recordAt);
    await f.t.finishAllScheduledFunctions(() =>
      jest.advanceTimersByTime(expiresAt - recordAt),
    );
    const after = await f.rows(permit.attempt_id);
    expect(after.head?.active_delivery_state).toBe("ambiguous");
    expect(after.head?.active_delivery_attempt_id).toBe(permit.attempt_id);
    expect(after.message?.delivery_status).toBe("ambiguous");
    expect(after.attempt).toMatchObject({
      state: "ambiguous",
      failure_code: "MOVE_SETTLEMENT_EXPIRED",
    });
    expect(
      await f.t.mutation(internal.edgeDelivery.settle, {
        ...permit,
        outcome: "applied",
        resolution_evidence: "late daemon report",
      }),
    ).toEqual(stale);
  },
);
