import { expect, spyOn, test } from "bun:test";
import { until } from "../../../../tests/codex-driver-parity/peers.js";
import { fixture, item } from "./codex-owned-pilot-fixture.js";
import {
  PILOT_RESUME_BUSY_ERROR,
  ParkedPilotRegistry,
} from "./codex-pilot-cleanup.js";

const retryAfterMs = 1_337;
const retryDelays = new Set([1_337, 2_674, 5_348, 10_696, 21_392, 30_000]);

function interceptTimers(match: (delay: number) => boolean) {
  const schedule = globalThis.setTimeout;
  const cancel = globalThis.clearTimeout;
  const scheduled: {
    delay: number;
    handle: ReturnType<typeof setTimeout>;
    run(): void;
  }[] = [];
  const active = new Set<ReturnType<typeof setTimeout>>();
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    const handle = schedule(callback, delay, ...args);
    if (delay !== undefined && match(delay)) {
      cancel(handle);
      active.add(handle);
      scheduled.push({
        delay,
        handle,
        run: () => {
          active.delete(handle);
          callback(...args);
        },
      });
    }
    return handle;
  }) as typeof setTimeout);
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation(((
    handle?: ReturnType<typeof setTimeout>,
  ) => {
    if (handle !== undefined) active.delete(handle);
    return cancel(handle);
  }) as typeof clearTimeout);
  return {
    scheduled,
    active,
    restore() {
      timer.mockRestore();
      clear.mockRestore();
    },
  };
}

function fakeNow() {
  const realNow = Date.now;
  let offsetMs = 0;
  const spy = spyOn(Date, "now").mockImplementation(() => realNow() + offsetMs);
  return {
    advance(ms: number) {
      offsetMs += ms;
    },
    restore() {
      spy.mockRestore();
    },
  };
}

async function exhaustResume(
  f: ReturnType<typeof fixture>,
  binding: ReturnType<ReturnType<typeof fixture>["ready"]>,
  clock: ReturnType<typeof interceptTimers>,
  busyRetryAfterMs = retryAfterMs,
) {
  for (let i = 0; i < 9; i++) {
    f.claimResponses.push(
      Response.json({ v: 1, status: "busy", retry_after_ms: busyRetryAfterMs }),
    );
  }
  await f.runtime.processWorkUpdate([
    {
      ...item(f.newRequest, binding),
      resumeGeneration: 1,
      nextDeliverySequence: 1,
    },
  ]);
  let executed = 0;
  while (executed < clock.scheduled.length) {
    clock.scheduled[executed++]!.run();
    await f.runtime.processWorkUpdate([]);
  }
  return executed;
}

test("exhaustion then 503 wake then busy wake makes at most one claim per wake with no retry storm", async () => {
  const f = fixture(null, true, "receipt", true);
  const now = fakeNow();
  let clock: ReturnType<typeof interceptTimers> | undefined;
  try {
    await f.runtime.processWorkUpdate([
      { ...item(f.newRequest), nextDeliverySequence: 1 },
    ]);
    const binding = f.ready(f.newRequest);
    await f.driver.stop(binding);
    clock = interceptTimers((delay) => retryDelays.has(delay));
    let executed = await exhaustResume(f, binding, clock);
    expect(clock.scheduled).toHaveLength(8);
    expect(f.pilot.parkedRecord("new", 1)?.failures).toBe(1);

    const claimsAfterExhaustion = f.actions.filter(
      (action) => action === "edge:claim",
    ).length;

    now.advance(5_000);
    f.claimResponses.push(new Response(null, { status: 503 }));
    await f.runtime.processWorkUpdate([
      {
        ...item(f.newRequest, binding),
        resumeGeneration: 1,
        nextDeliverySequence: 2,
      },
    ]);
    const claimsAfter503 = f.actions.filter(
      (action) => action === "edge:claim",
    ).length;
    expect(claimsAfter503 - claimsAfterExhaustion).toBe(1);
    expect(f.pilot.parkedRecord("new", 1)?.failures).toBe(2);

    now.advance(10_000);
    for (let i = 0; i < 12; i++) {
      f.claimResponses.push(
        Response.json({ v: 1, status: "busy", retry_after_ms: retryAfterMs }),
      );
    }
    await f.runtime.processWorkUpdate([
      {
        ...item(f.newRequest, binding),
        resumeGeneration: 1,
        nextDeliverySequence: 3,
      },
    ]);
    while (executed < clock.scheduled.length) {
      clock.scheduled[executed++]!.run();
      await f.runtime.processWorkUpdate([]);
    }
    const claimsAfterBusy = f.actions.filter(
      (action) => action === "edge:claim",
    ).length;
    expect(claimsAfterBusy - claimsAfter503).toBe(1);
    expect(clock.scheduled).toHaveLength(8);
    expect(f.pilot.parkedRecord("new", 1)?.failures).toBe(3);
  } finally {
    clock?.restore();
    now.restore();
    await f.dispose();
  }
});

test("a burst of 100 messages within backoff makes zero extra claims and one claim when notBeforeMs passes", async () => {
  const f = fixture(null, true, "receipt", true);
  const now = fakeNow();
  let clock: ReturnType<typeof interceptTimers> | undefined;
  try {
    await f.runtime.processWorkUpdate([
      { ...item(f.newRequest), nextDeliverySequence: 1 },
    ]);
    const binding = f.ready(f.newRequest);
    await f.driver.stop(binding);
    clock = interceptTimers((delay) => delay >= 1_000);
    await exhaustResume(f, binding, clock);
    expect(clock.scheduled).toHaveLength(8);
    const claimsAfterExhaustion = f.actions.filter(
      (action) => action === "edge:claim",
    ).length;

    for (let i = 0; i < 10; i++) {
      f.claimResponses.push(
        Response.json({ v: 1, status: "busy", retry_after_ms: retryAfterMs }),
      );
    }
    for (let seq = 2; seq <= 101; seq++) {
      await f.runtime.processWorkUpdate([
        {
          ...item(f.newRequest, binding),
          resumeGeneration: 1,
          nextDeliverySequence: seq,
        },
      ]);
    }
    expect(f.actions.filter((action) => action === "edge:claim").length).toBe(
      claimsAfterExhaustion,
    );
    expect(clock.scheduled).toHaveLength(9);
    expect(clock.active.size).toBe(1);

    now.advance(2_500);
    clock.scheduled[8]!.run();
    await f.runtime.processWorkUpdate([]);
    expect(f.actions.filter((action) => action === "edge:claim").length).toBe(
      claimsAfterExhaustion + 1,
    );
    expect(f.pilot.parkedRecord("new", 1)?.deliverySequence).toBe(101);
  } finally {
    clock?.restore();
    now.restore();
    await f.dispose();
  }
});

test("retry_after_ms from the server is respected by park backoff", async () => {
  const f = fixture(null, true, "receipt", true);
  const now = fakeNow();
  const serverRetryAfterMs = 15_000;
  let clock: ReturnType<typeof interceptTimers> | undefined;
  try {
    await f.runtime.processWorkUpdate([
      { ...item(f.newRequest), nextDeliverySequence: 1 },
    ]);
    const binding = f.ready(f.newRequest);
    await f.driver.stop(binding);
    clock = interceptTimers((delay) => delay >= 1_000);
    await exhaustResume(f, binding, clock, serverRetryAfterMs);
    const claimsAfterExhaustion = f.actions.filter(
      (action) => action === "edge:claim",
    ).length;

    f.claimResponses.push(
      Response.json({ v: 1, status: "busy", retry_after_ms: 1_000 }),
    );
    now.advance(5_000);
    await f.runtime.processWorkUpdate([
      {
        ...item(f.newRequest, binding),
        resumeGeneration: 1,
        nextDeliverySequence: 2,
      },
    ]);
    expect(f.actions.filter((action) => action === "edge:claim").length).toBe(
      claimsAfterExhaustion,
    );
    const deferred = clock.scheduled.at(-1)!;
    expect(deferred.delay).toBeGreaterThanOrEqual(9_500);

    now.advance(10_500);
    deferred.run();
    await f.runtime.processWorkUpdate([]);
    expect(f.actions.filter((action) => action === "edge:claim").length).toBe(
      claimsAfterExhaustion + 1,
    );
  } finally {
    clock?.restore();
    now.restore();
    await f.dispose();
  }
});

test("a pre-restart session_error clears on resume with retry while unrelated errors are kept", async () => {
  const f = fixture(null, true, "receipt", true);
  let clock: ReturnType<typeof interceptTimers> | undefined;
  try {
    await f.runtime.processWorkUpdate([item(f.newRequest)]);
    const binding = f.ready(f.newRequest);
    await f.driver.stop(binding);
    clock = interceptTimers(
      (delay) => retryDelays.has(delay) || delay === 1_000,
    );
    await exhaustResume(f, binding, clock);
    expect(f.currentSessionError("new")).toBe(PILOT_RESUME_BUSY_ERROR);

    await f.runtime.stop();
    clock.restore();
    clock = interceptTimers((delay) => delay === 1_000);
    const restarted = f.createRuntime("restarted-boot");
    const restartedBinding = { ...binding, daemonBootId: "restarted-boot" };
    f.ready(f.newRequest, restartedBinding);
    const restartedRequest = {
      ...f.newRequest,
      daemonBootId: "restarted-boot",
    };

    f.failNextErrorClears(1);
    await restarted.runtime.processWorkUpdate([
      {
        ...item(restartedRequest, restartedBinding),
        resumeGeneration: 2,
      },
    ]);
    expect(f.currentSessionError("new")).toBe(PILOT_RESUME_BUSY_ERROR);
    expect(clock.scheduled.length).toBeGreaterThanOrEqual(1);

    for (const entry of clock.scheduled) entry.run();
    await until(
      () => f.currentSessionError("new") === undefined,
      "retried clear removes pre-restart pilot error",
    );

    await restarted.runtime.stop();
    const third = f.createRuntime("third-boot");
    const thirdBinding = { ...binding, daemonBootId: "third-boot" };
    f.ready(f.newRequest, thirdBinding);
    f.seedSessionError("new", "Unrelated subsystem error");
    await third.runtime.processWorkUpdate([
      {
        ...item({ ...f.newRequest, daemonBootId: "third-boot" }, thirdBinding),
        resumeGeneration: 3,
      },
    ]);
    expect(f.currentSessionError("new")).toBe("Unrelated subsystem error");
  } finally {
    clock?.restore();
    await f.dispose();
  }
});

test("stop during an ensureBinding await makes no new child or timer", async () => {
  const f = fixture(null, true, "receipt", true);
  let clock: ReturnType<typeof interceptTimers> | undefined;
  try {
    clock = interceptTimers((delay) => delay >= 1_000);
    const paused = f.pauseNextClaimStart();
    const update = f.runtime.processWorkUpdate([item(f.newRequest)]);
    await paused.started;

    const stopping = f.runtime.stop();
    paused.release();
    await Promise.all([update, stopping]);

    expect(f.pilot.pilotFor(f.newRequest)).toBeUndefined();
    expect(f.actions.filter((action) => action === "edge:claim")).toEqual([]);
    expect(clock.active.size).toBe(0);
  } finally {
    clock?.restore();
    await f.dispose();
  }
});

test("a binding that moves to stopped clears its poll timer", async () => {
  const f = fixture(null, true, "receipt", true);
  let clock: ReturnType<typeof interceptTimers> | undefined;
  try {
    clock = interceptTimers((delay) => delay === 2_000);
    f.enqueue(1, false, "new");
    f.rejectSettlements(true);
    await f.runtime.processWorkUpdate([
      { ...item(f.newRequest), nextDeliverySequence: 1 },
    ]);
    const binding = f.ready(f.newRequest);
    expect(clock.active.size).toBe(1);

    await f.runtime.processWorkUpdate([
      {
        conversationId: "new",
        currentEpoch: 1,
        bindings: [
          {
            request: f.newRequest,
            state: "stopped",
            daemonBootMatch: true,
            binding,
          },
        ],
      },
    ]);
    expect(clock.active.size).toBe(0);
  } finally {
    clock?.restore();
    await f.dispose();
  }
});

test("park records are pruned on close, on epoch advance, and capped in size", async () => {
  const f = fixture(null, true, "receipt", true);
  let clock: ReturnType<typeof interceptTimers> | undefined;
  try {
    await f.runtime.processWorkUpdate([
      { ...item(f.newRequest), nextDeliverySequence: 1 },
    ]);
    const binding = f.ready(f.newRequest);
    await f.driver.stop(binding);
    clock = interceptTimers((delay) => retryDelays.has(delay));
    await exhaustResume(f, binding, clock);
    expect(f.pilot.parkedRecord("new", 1)?.failures).toBe(1);

    const epoch2Request = {
      ...f.newRequest,
      target: { ...f.newRequest.target, epoch: 2 },
    };
    const epoch2Binding = { ...binding, epoch: 2 };
    await f.runtime.processWorkUpdate([
      {
        conversationId: "new",
        currentEpoch: 2,
        bindings: [
          {
            request: epoch2Request,
            state: "ready",
            daemonBootMatch: true,
            binding: epoch2Binding,
          },
        ],
      },
    ]);
    expect(f.pilot.parkedRecord("new", 1)).toBeUndefined();
    expect(f.pilot.parkedCount()).toBe(0);

    await f.runtime.processWorkUpdate([
      {
        ...item(f.newRequest, binding),
        resumeGeneration: 2,
        nextDeliverySequence: 2,
      },
    ]);
    await f.driver.stop(binding);
    expect(f.pilot.parkedRecord("new", 1)).toBeDefined();

    await f.runtime.processWorkUpdate([
      {
        conversationId: "new",
        currentEpoch: 1,
        bindings: [
          {
            request: f.newRequest,
            state: "stopped",
            daemonBootMatch: true,
            binding,
          },
        ],
      },
    ]);
    expect(f.pilot.parkedRecord("new", 1)).toBeUndefined();

    const registry = new ParkedPilotRegistry(3);
    for (let i = 1; i <= 5; i++) {
      registry.parkFailure(`conv-${i}`, 1, 1, 1, 1_000, i * 1_000);
    }
    expect(registry.size).toBe(3);
    expect(registry.get("conv-1", 1)).toBeUndefined();
    expect(registry.get("conv-2", 1)).toBeUndefined();
    expect(registry.get("conv-5", 1)?.failures).toBe(1);
  } finally {
    clock?.restore();
    await f.dispose();
  }
});
