import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { scheduledJobs } from "../test-helpers/database.testkit";
import {
  boot,
  leaseMs,
  machine,
  setupRunLease,
  start,
} from "../test-helpers/run-lease.testkit";
import { api, internal } from "./_generated/api";

const flag = "CODECAST_FORCED_DEVICE_MOVE_V1";
const previous = process.env[flag];
const expires = internal.edgeRunLease.expireMove;
const replacementBoot = "replacement-source";

beforeEach(() => {
  jest.useFakeTimers({ now: start });
  process.env[flag] = "1";
});

afterEach(() => {
  jest.useRealTimers();
  if (previous === undefined) delete process.env[flag];
  else process.env[flag] = previous;
});

async function fixture() {
  const f = await setupRunLease();
  const lease = await f.claim("source");
  if (lease.status !== "granted") throw new Error("Expected a source lease");
  const run = {
    v: 1,
    session: f.conversation,
    run: 1,
    bearer: f.bearer,
    fencing_token: lease.fencing_token,
  } as const;
  const next = await f.t.mutation(internal.edgeDelivery.next, run);
  if (next.status !== "permit") throw new Error("Expected a source permit");
  const permit = {
    ...run,
    attempt_id: next.attempt_id,
    seq: next.seq,
    delivery_id: next.delivery_id,
    intent: next.intent,
    sender: next.sender,
  };
  expect(await f.t.mutation(internal.edgeDelivery.start, permit)).toMatchObject(
    {
      status: "started",
    },
  );
  const record = () =>
    f.t.mutation(internal.edgeRunLease.recordMove, {
      conversation_id: f.conversation,
      expected_source_epoch: 1,
      destination_device_id: "destination",
      destination_runner_id: f.owner,
    });
  const read = () => f.t.run(({ db }) => db.get(f.head));
  const expire = () =>
    f.t.mutation(expires, { head_id: f.head, source_epoch: 1 });
  const settle = () =>
    f.t.mutation(internal.edgeDelivery.settle, {
      ...permit,
      outcome: "applied",
    });
  const confirm = async (
    proof: "stop" | "replacement boot",
    moveId: string,
  ) => {
    const address = {
      conversation_id: f.conversation,
      bearer: f.bearer,
      move_id: moveId,
    };
    if (proof === "stop") {
      await f.t.mutation(internal.edgeRunLease.confirmMoveSourceStop, {
        ...address,
        daemon_boot_id: boot,
        runtime_id: "runtime",
        fencing_token: lease.fencing_token,
      });
      return;
    }
    await f.t.mutation(api.executionBindings.registerExecutionDaemonBoot, {
      api_token: f.bearer,
      owner_device_id: machine,
      daemon_boot_id: replacementBoot,
    });
    await f.t.mutation(internal.edgeRunLease.confirmMoveSourceReplacementBoot, {
      ...address,
      daemon_boot_id: replacementBoot,
    });
  };
  return { ...f, lease, record, read, expire, settle, confirm };
}

async function extendSourceLease(f: Awaited<ReturnType<typeof fixture>>) {
  await f.t.run(async ({ db }) => {
    const lease = await db.query("run_leases").unique();
    if (!lease) throw new Error("Expected a stored lease");
    await db.patch(lease._id, { expires_at: start + 120_000 });
  });
}

test.each([5_000, 24_000])(
  "the unrenewed lease sets the settlement deadline after %d ms",
  async (elapsed) => {
    const f = await fixture();
    const deadline = start + leaseMs;
    jest.setSystemTime(start + elapsed);
    await f.record();
    expect((await f.read())?.device_move?.settlement_deadline).toBe(deadline);
    expect(await scheduledJobs(f.t, expires)).toMatchObject([
      { scheduledTime: deadline },
    ]);
    jest.setSystemTime(deadline - 1);
    await f.expire();
    expect((await f.read())?.active_delivery_state).toBe("delivery-started");
    jest.setSystemTime(deadline);
    expect(await f.settle()).toMatchObject({ status: "stale" });
    await f.expire();
    expect((await f.read())?.active_delivery_state).toBe("ambiguous");
  },
);

test("a stored lease longer than the settlement limit cannot extend the window", async () => {
  const f = await fixture();
  const recordedAt = start + 2_000;
  await extendSourceLease(f);
  jest.setSystemTime(recordedAt);
  await f.record();
  const deadline = recordedAt + 30_000;
  expect((await f.read())?.device_move?.settlement_deadline).toBe(deadline);
  expect(await scheduledJobs(f.t, expires)).toMatchObject([
    { scheduledTime: deadline },
  ]);
  jest.setSystemTime(deadline);
  expect(await f.settle()).toMatchObject({ status: "stale" });
  await f.expire();
  expect((await f.read())?.active_delivery_state).toBe("ambiguous");
});

test("the source can settle its recorded attempt after the old ten-second limit", async () => {
  const f = await fixture();
  await f.record();
  jest.setSystemTime(start + 15_000);
  expect(await f.settle()).toMatchObject({ status: "recorded" });
});

test.each(["released", "expired", "missing"] as const)(
  "settlement stays closed when the source lease is %s",
  async (state) => {
    const f = await fixture();
    if (state === "released") {
      jest.setSystemTime(start + 5_000);
      expect(
        await f.t.mutation(
          internal.edgeRunLease.release,
          f.requestFence(f.lease.fencing_token),
        ),
      ).toMatchObject({ status: "released" });
    } else if (state === "expired") {
      jest.setSystemTime(start + leaseMs + 1);
    } else {
      await f.t.run(async ({ db }) => {
        const lease = await db.query("run_leases").unique();
        if (!lease) throw new Error("Expected a stored lease");
        await db.delete(lease._id);
      });
    }
    await f.record();
    expect(await f.read()).toMatchObject({
      device_move: { settlement_deadline: Date.now() },
      active_delivery_state: "ambiguous",
    });
    expect(await scheduledJobs(f.t, expires)).toEqual([]);
  },
);

test.each(["stop", "replacement boot"] as const)(
  "a confirmed %s shortens the deadline and closes settlement",
  async (proof) => {
    const f = await fixture();
    const moveId = await f.record();
    const closedAt = start + 4_000;
    jest.setSystemTime(closedAt);
    await f.confirm(proof, moveId);
    expect(await f.read()).toMatchObject({
      device_move: { settlement_deadline: closedAt },
      active_delivery_state: "ambiguous",
    });
    jest.setSystemTime(closedAt - 1);
    expect(await f.settle()).toMatchObject({ status: "stale" });
  },
);

test.each(["stop", "replacement boot"] as const)(
  "the flag off keeps the old window and expiry schedule after %s",
  async (proof) => {
    delete process.env[flag];
    const f = await fixture();
    const recordedAt = start + 5_000;
    jest.setSystemTime(recordedAt);
    const moveId = await f.record();
    const deadline = recordedAt + 10_000;
    expect((await f.read())?.device_move?.settlement_deadline).toBe(deadline);
    expect(await scheduledJobs(f.t, expires)).toMatchObject([
      { scheduledTime: deadline },
    ]);
    const confirmedAt = recordedAt + 1_000;
    jest.setSystemTime(confirmedAt);
    await f.confirm(proof, moveId);
    expect((await f.read())?.device_move).toMatchObject({
      settlement_deadline: deadline,
      ...(proof === "stop"
        ? { source_stopped_at: confirmedAt }
        : { source_replacement_boot_id: replacementBoot }),
    });
  },
);

test("a replacement boot after the settlement cap cannot extend the deadline", async () => {
  const f = await fixture();
  await extendSourceLease(f);
  const moveId = await f.record();
  const deadline = start + 30_000;
  expect((await f.read())?.device_move?.settlement_deadline).toBe(deadline);
  jest.setSystemTime(deadline + 1_000);
  await f.confirm("replacement boot", moveId);
  expect(await f.read()).toMatchObject({
    device_move: {
      settlement_deadline: deadline,
      source_replacement_boot_id: replacementBoot,
    },
    active_delivery_state: "ambiguous",
  });
});

test("a stale epoch stop cannot shorten the settlement window", async () => {
  const f = await fixture();
  const moveId = await f.record();
  await f.t.run(({ db }) => db.patch(f.head, { current_epoch: 2 }));
  const head = await f.read();
  jest.setSystemTime(start + 4_000);
  await expect(f.confirm("stop", moveId)).rejects.toThrow(
    "The move record is missing or has changed",
  );
  expect(await f.read()).toEqual(head);
});
