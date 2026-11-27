import { expect, spyOn, test } from "bun:test";
import { until } from "../../../../tests/codex-driver-parity/peers.js";
import { fixture, item } from "./codex-owned-pilot-fixture.js";

const retryAfterMs = 1_337;
const expectedRetryDelays = new Set([
  1_337, 2_674, 5_348, 10_696, 21_392, 30_000,
]);

function interceptRetries(delays: ReadonlySet<number> = expectedRetryDelays) {
  const schedule = globalThis.setTimeout;
  const cancel = globalThis.clearTimeout;
  const retries: {
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
    if (delay !== undefined && delays.has(delay)) {
      cancel(handle);
      active.add(handle);
      retries.push({
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
    retries,
    active,
    restore() {
      timer.mockRestore();
      clear.mockRestore();
    },
  };
}

test("three messages after exhaustion bound claims and keep one exhaustion error and log", async () => {
  const f = fixture(null, true, "receipt", true);
  let clock: ReturnType<typeof interceptRetries> | undefined;
  const realNow = Date.now;
  let offsetMs = 0;
  const nowSpy = spyOn(Date, "now").mockImplementation(
    () => realNow() + offsetMs,
  );
  try {
    await f.runtime.processWorkUpdate([
      { ...item(f.newRequest), nextDeliverySequence: 1 },
    ]);
    const binding = f.ready(f.newRequest);
    await f.driver.stop(binding);
    f.logs.length = 0;
    f.sessionErrors.length = 0;
    clock = interceptRetries();
    for (let i = 0; i < 9; i++) {
      f.claimResponses.push(
        Response.json({ v: 1, status: "busy", retry_after_ms: retryAfterMs }),
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
    while (executed < clock.retries.length) {
      clock.retries[executed++]!.run();
      await f.runtime.processWorkUpdate([]);
    }
    expect(clock.retries).toHaveLength(8);
    const claimsAfterExhaustion = f.actions.filter(
      (action) => action === "edge:claim",
    ).length;
    const exhaustedLogs = () =>
      f.logs.filter((line) => line.includes("resume lease retry exhausted"));
    expect(exhaustedLogs()).toHaveLength(1);
    expect(f.sessionErrors).toHaveLength(1);

    for (let i = 0; i < 30; i++) {
      f.claimResponses.push(
        Response.json({ v: 1, status: "busy", retry_after_ms: retryAfterMs }),
      );
    }
    for (const seq of [2, 3, 4]) {
      offsetMs += 5 * 60_000;
      await f.runtime.processWorkUpdate([
        {
          ...item(f.newRequest, binding),
          resumeGeneration: 1,
          nextDeliverySequence: seq,
        },
      ]);
      while (executed < clock.retries.length) {
        clock.retries[executed++]!.run();
        await f.runtime.processWorkUpdate([]);
      }
    }
    const claimsAfterMessages = f.actions.filter(
      (action) => action === "edge:claim",
    ).length;
    expect(claimsAfterMessages - claimsAfterExhaustion).toBe(3);
    expect(clock.retries).toHaveLength(8);
    expect(exhaustedLogs()).toHaveLength(1);
    expect(f.sessionErrors).toHaveLength(1);

    offsetMs += 5 * 60_000;
    await f.runtime.processWorkUpdate([
      {
        ...item(f.newRequest, binding),
        resumeGeneration: 1,
        nextDeliverySequence: 4,
      },
    ]);
    expect(f.actions.filter((action) => action === "edge:claim").length).toBe(
      claimsAfterMessages,
    );
  } finally {
    nowSpy.mockRestore();
    clock?.restore();
    await f.dispose();
  }
});

test("an unchanged update after a failed wake claim makes zero claims", async () => {
  const f = fixture(null, true, "receipt", true);
  const realNow = Date.now;
  let offsetMs = 0;
  const nowSpy = spyOn(Date, "now").mockImplementation(
    () => realNow() + offsetMs,
  );
  try {
    await f.runtime.processWorkUpdate([
      { ...item(f.newRequest), nextDeliverySequence: 1 },
    ]);
    const binding = f.ready(f.newRequest);
    const crashed = f.pilot.pilotFor(f.newRequest)!;
    const pid = crashed.getProcessId();
    expect(pid).toBeNumber();
    process.kill(pid!, "SIGTERM");
    await until(() => crashed.closed, "crashed child closes and parks");

    f.logs.length = 0;
    f.claimResponses.push(new Response(null, { status: 503 }));
    const wake = [{ ...item(f.newRequest, binding), nextDeliverySequence: 2 }];
    await f.runtime.processWorkUpdate(wake);
    const claimsAfterFailedWake = f.actions.filter(
      (action) => action === "edge:claim",
    ).length;
    const workFailedLogs = () =>
      f.logs.filter((line) => line.includes("[owned-codex] work failed"));
    expect(workFailedLogs()).toHaveLength(1);

    offsetMs += 10_000;
    for (let i = 0; i < 3; i++) {
      await f.runtime.processWorkUpdate(wake);
    }
    expect(f.actions.filter((action) => action === "edge:claim").length).toBe(
      claimsAfterFailedWake,
    );
    expect(workFailedLogs()).toHaveLength(1);

    f.claimResponses.push(
      Response.json({ v: 1, status: "busy", retry_after_ms: retryAfterMs }),
    );
    const busyWake = [
      { ...item(f.newRequest, binding), nextDeliverySequence: 3 },
    ];
    await f.runtime.processWorkUpdate(busyWake);
    const claimsAfterBusyWake = f.actions.filter(
      (action) => action === "edge:claim",
    ).length;
    expect(claimsAfterBusyWake).toBe(claimsAfterFailedWake + 1);
    offsetMs += 10_000;
    await f.runtime.processWorkUpdate(busyWake);
    expect(f.actions.filter((action) => action === "edge:claim").length).toBe(
      claimsAfterBusyWake,
    );
  } finally {
    nowSpy.mockRestore();
    await f.dispose();
  }
});

test("a queued generation advance invalidates an already-fired retry timer and leaves one live timer", async () => {
  const f = fixture(null, true, "receipt", true);
  let clock: ReturnType<typeof interceptRetries> | undefined;
  try {
    await f.runtime.processWorkUpdate([item(f.newRequest)]);
    const binding = f.ready(f.newRequest);
    await f.driver.stop(binding);
    clock = interceptRetries(new Set([...expectedRetryDelays, 2_000]));
    for (let i = 0; i < 4; i++) {
      f.claimResponses.push(
        Response.json({ v: 1, status: "busy", retry_after_ms: retryAfterMs }),
      );
    }
    await f.runtime.processWorkUpdate([
      { ...item(f.newRequest, binding), resumeGeneration: 1 },
    ]);
    expect(clock.retries).toHaveLength(1);
    expect(clock.active.size).toBe(1);

    const claimsBeforeGen2 = f.actions.filter(
      (action) => action === "edge:claim",
    ).length;
    const gen2 = f.runtime.processWorkUpdate([
      { ...item(f.newRequest, binding), resumeGeneration: 2 },
    ]);
    clock.retries[0]!.run();
    await gen2;
    await f.runtime.processWorkUpdate([]);

    expect(
      f.actions.filter((action) => action === "edge:claim").length -
        claimsBeforeGen2,
    ).toBe(1);
    expect(clock.active.size).toBe(1);
    expect(clock.retries).toHaveLength(2);
  } finally {
    clock?.restore();
    await f.dispose();
  }
});

test("a fresh start and clean resume do not clear an unrelated session error", async () => {
  const f = fixture(null, true, "receipt", true);
  try {
    await f.runtime.processWorkUpdate([item(f.newRequest)]);
    const binding = f.ready(f.newRequest);
    expect(f.sessionErrors).toEqual([]);

    await f.driver.stop(binding);
    await f.runtime.processWorkUpdate([
      { ...item(f.newRequest, binding), resumeGeneration: 1 },
    ]);
    expect(f.sessionErrors).toEqual([]);
  } finally {
    await f.dispose();
  }
});

test("a provider error emitted during resume survives after the pilot clears its own failure", async () => {
  const f = fixture(null, true, "receipt", true);
  let clock: ReturnType<typeof interceptRetries> | undefined;
  try {
    await f.runtime.processWorkUpdate([item(f.newRequest)]);
    const binding = f.ready(f.newRequest);
    await f.driver.stop(binding);
    f.sessionErrors.length = 0;
    clock = interceptRetries();
    for (let i = 0; i < 9; i++) {
      f.claimResponses.push(
        Response.json({ v: 1, status: "busy", retry_after_ms: retryAfterMs }),
      );
    }
    await f.runtime.processWorkUpdate([
      { ...item(f.newRequest, binding), resumeGeneration: 1 },
    ]);
    let executed = 0;
    while (executed < clock.retries.length) {
      clock.retries[executed++]!.run();
      await f.runtime.processWorkUpdate([]);
    }
    expect(f.sessionErrors).toHaveLength(1);
    clock.restore();
    clock = undefined;

    f.setResumedTurn("resume-turn");
    const clearPause = f.pauseErrorClear();
    const resuming = f.runtime.processWorkUpdate([
      { ...item(f.newRequest, binding), resumeGeneration: 2 },
    ]);
    await clearPause.started;

    await f.sendFrame({
      frame: {
        method: "turn/completed",
        params: {
          threadId: f.deliveryThread,
          turn: {
            id: "resume-turn",
            status: "failed",
            items: [],
            error: { message: "Provider failed during resume" },
          },
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    clearPause.release();
    await resuming;

    await until(
      () =>
        f.sessionErrors.some(
          (entry) => entry.error === "Provider failed during resume",
        ),
      "provider error during resume is published",
    );
    expect(f.sessionErrors).toEqual([
      {
        conversationId: "new",
        error:
          "Could not resume Codex session: the previous run still holds its lease.",
        force: true,
      },
      {
        conversationId: "new",
        error: undefined,
        force: true,
      },
      {
        conversationId: "new",
        error: "Provider failed during resume",
        force: true,
      },
    ]);
  } finally {
    clock?.restore();
    await f.dispose();
  }
});
