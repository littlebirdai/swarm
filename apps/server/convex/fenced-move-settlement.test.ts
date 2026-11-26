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
  return { ...f, lease, record, read, expire, settle };
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
  await f.t.run(async ({ db }) => {
    const lease = await db.query("run_leases").unique();
    if (!lease) throw new Error("Expected a stored lease");
    await db.patch(lease._id, { expires_at: start + 120_000 });
  });
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

test.each(["released", "expired"] as const)(
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
    } else {
      jest.setSystemTime(start + leaseMs + 1);
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
    const address = {
      conversation_id: f.conversation,
      bearer: f.bearer,
      move_id: await f.record(),
    };
    const closedAt = start + 4_000;
    jest.setSystemTime(closedAt);
    if (proof === "stop") {
      await f.t.mutation(internal.edgeRunLease.confirmMoveSourceStop, {
        ...address,
        daemon_boot_id: boot,
        runtime_id: "runtime",
        fencing_token: f.lease.fencing_token,
      });
    } else {
      const replacement = "replacement-source";
      await f.t.mutation(api.executionBindings.registerExecutionDaemonBoot, {
        api_token: f.bearer,
        owner_device_id: machine,
        daemon_boot_id: replacement,
      });
      await f.t.mutation(
        internal.edgeRunLease.confirmMoveSourceReplacementBoot,
        {
          ...address,
          daemon_boot_id: replacement,
        },
      );
    }
    expect(await f.read()).toMatchObject({
      device_move: { settlement_deadline: closedAt },
      active_delivery_state: "ambiguous",
    });
    jest.setSystemTime(closedAt - 1);
    expect(await f.settle()).toMatchObject({ status: "stale" });
  },
);

test("the flag off keeps the old window and expiry schedule", async () => {
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
  jest.setSystemTime(recordedAt + 1_000);
  await f.t.mutation(internal.edgeRunLease.confirmMoveSourceStop, {
    conversation_id: f.conversation,
    move_id: moveId,
    bearer: f.bearer,
    daemon_boot_id: boot,
    runtime_id: "runtime",
    fencing_token: f.lease.fencing_token,
  });
  expect((await f.read())?.device_move?.settlement_deadline).toBe(deadline);
});
