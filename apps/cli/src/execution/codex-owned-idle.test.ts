import { expect, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { currentHeartbeatSessions } from "../daemon.js";
import { until } from "../../../../tests/codex-driver-parity/peers.js";
import { functionBlock } from "../test-helpers/sourceRegion.js";
import { fixture, item } from "./codex-owned-pilot-fixture.js";

const maintenance = new Bun.Transpiler({ loader: "ts" }).transformSync(
  functionBlock(
    readFileSync(new URL("../daemon.ts", import.meta.url), "utf8"),
    "runHeartbeatMaintenance",
  ).text,
);

function heartbeatFixture(
  thread: string,
  pilot: ReturnType<typeof fixture>["pilot"],
) {
  const probe = mock(async (_id: string) => {});
  const reconcile = mock(async (_id: string) => {});
  const deps = {
    syncServiceRef: {},
    conversationCacheRef: null,
    managedHeartbeatSessions: [thread, "legacy-pane"],
    appServerConversations: new Map(),
    persistedAppServerThreads: new Map(),
    currentHeartbeatSessions: (
      ...[sessions, cache, live, persisted, reverse]: Parameters<
        typeof currentHeartbeatSessions
      >
    ) =>
      currentHeartbeatSessions(
        sessions,
        cache,
        live,
        persisted,
        reverse,
        pilot,
      ),
    heartbeatMaintenanceCount: 1,
    HEALTH_CHECK_EVERY_N_HEARTBEATS: 1,
    heartbeatHealthCheckBucket: () => 0,
    runBounded: (
      ids: string[],
      _limit: number,
      run: (id: string) => Promise<void>,
    ) => Promise.all(ids.map(run)),
    reconcileStatusFromTranscript: reconcile,
    heartbeatHealthCheck: probe,
    REAP_EVERY_N_FLUSHES: Infinity,
    WIP_SNAPSHOT_EVERY_N_FLUSHES: Infinity,
    GIT_PLANE_EVERY_N_FLUSHES: Infinity,
    pollGitActivity: async () => {},
  };
  const run = new Function(
    ...Object.keys(deps),
    maintenance + "\nreturn runHeartbeatMaintenance",
  )(...Object.values(deps)) as () => Promise<void>;
  return { run, probe, reconcile };
}

function fakeTimers(...delays: number[]) {
  const schedule = globalThis.setTimeout;
  const clear = globalThis.clearTimeout;
  const pending = new Map<object, { delay: number; fire(): void }>();
  const cancel = spyOn(globalThis, "clearTimeout").mockImplementation(
    (timer) => {
      if (typeof timer === "object") pending.delete(timer);
      Reflect.apply(clear, globalThis, [timer]);
    },
  );
  const spy = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: (...args: unknown[]) => void,
    delay?: number,
    ...args: unknown[]
  ) => {
    const timer = schedule(callback, delay, ...args);
    if (delay !== undefined && delays.includes(delay)) {
      clear(timer);
      pending.set(timer, { delay, fire: () => callback(...args) });
    }
    return timer;
  }) as typeof setTimeout);
  return {
    count: (delay: number) =>
      [...pending.values()].filter((entry) => entry.delay === delay).length,
    tick(delay: number) {
      for (const [timer, entry] of [...pending]) {
        if (entry.delay !== delay || !pending.delete(timer)) continue;
        entry.fire();
      }
    },
    restore() {
      spy.mockRestore();
      cancel.mockRestore();
    },
  };
}

test.each(["empty inbox", "reconciled inbox"])(
  "an idle owned Codex thread uses no recurring probes or polls with %s",
  async (inbox) => {
    const f = fixture("pilot", true, "receipt");
    const timers = fakeTimers(2_000, 30_000);
    const tick = async () => {
      timers.tick(2_000);
      await f.runtime.processWorkUpdate([]);
    };
    try {
      if (inbox === "reconciled inbox") {
        f.enqueue(1);
        f.queue[0]!.state = "started";
      }
      f.initial([item(f.pilotRequest)]);
      await f.runtime.start();
      if (inbox === "reconciled inbox") {
        expect(timers.count(2_000)).toBe(1);
        f.queue.shift();
        await tick();
        expect(
          f.runtime.coordinator.getActiveDelivery("pilot"),
        ).toBeUndefined();
      }
      timers.tick(30_000);
      await until(() => f.actions.includes("edge:renew"), "idle lease renews");
      expect(f.providerRequests()).toEqual([]);
      const before = f.actions.length;
      const owned = f.ready(f.pilotRequest).runtimeId;
      const heartbeat = heartbeatFixture(owned, f.pilot);
      for (let elapsed = 0; elapsed < 12_000; elapsed += 2_000) {
        await tick();
        await heartbeat.run();
      }

      expect(
        f.actions
          .slice(before)
          .filter((action) => action === "edge:permits.next"),
      ).toEqual([]);
      const legacyCalls = Array<string>(6).fill("legacy-pane");
      expect(heartbeat.probe.mock.calls.map(([id]) => id)).toEqual(legacyCalls);
      expect(heartbeat.reconcile.mock.calls.map(([id]) => id)).toEqual(
        legacyCalls,
      );
      await f.sendFrame({
        frame: {
          method: "thread/status/changed",
          params: { threadId: owned, status: { type: "idle" } },
        },
      });
      await until(
        () =>
          f.events.some(
            (event) =>
              event.kind === "context" &&
              JSON.stringify(event.body.data) === '{"status":{"type":"idle"}}',
          ),
        "the idle status is appended from the provider stream",
      );
    } finally {
      timers.restore();
      await f.dispose();
    }
  },
);

test("a live delivery wake restarts polling until the server settles the delivery", async () => {
  const f = fixture("pilot", true, "receipt");
  const timers = fakeTimers(2_000);
  try {
    f.initial([item(f.pilotRequest)]);
    await f.runtime.start();
    expect(timers.count(2_000)).toBe(0);
    f.enqueue(1);
    f.queue[0]!.state = "started";
    f.workSubscription().onUpdate([
      {
        ...item(f.pilotRequest, f.ready(f.pilotRequest)),
        nextDeliverySequence: 1,
      },
    ]);
    await f.runtime.processWorkUpdate([]);
    expect(f.runtime.coordinator.getActiveDelivery("pilot")).toMatchObject({
      attemptId: "attempt-1",
    });
    expect(timers.count(2_000)).toBe(1);
    timers.tick(2_000);
    await f.runtime.processWorkUpdate([]);
    expect(timers.count(2_000)).toBe(1);
    f.queue.shift();
    timers.tick(2_000);
    await f.runtime.processWorkUpdate([]);
    expect(f.runtime.coordinator.getActiveDelivery("pilot")).toBeUndefined();
    expect(timers.count(2_000)).toBe(0);
  } finally {
    timers.restore();
    await f.dispose();
  }
});

test.each(["stale lease at wake", "stale lease at poll", "closed session"])(
  "the delivery poll stops on %s",
  async (event) => {
    const f = fixture("pilot", true, "receipt");
    const timers = fakeTimers(2_000);
    try {
      f.initial([item(f.pilotRequest)]);
      await f.runtime.start();
      f.enqueue(1);
      f.queue[0]!.state = "started";
      if (event === "stale lease at wake") f.setPermitReadStatus("stale");
      f.workSubscription().onUpdate([
        {
          ...item(f.pilotRequest, f.ready(f.pilotRequest)),
          nextDeliverySequence: 1,
        },
      ]);
      await f.runtime.processWorkUpdate([]);
      if (event !== "stale lease at wake") {
        expect(timers.count(2_000)).toBe(1);
        if (event === "closed session") await f.pilot!.close();
        else f.setPermitReadStatus("stale");
        timers.tick(2_000);
        await f.runtime.processWorkUpdate([]);
      }
      expect(f.pilot!.closed).toBe(true);
      expect(f.pilot!.ownsThread(f.deliveryThread)).toBe(false);
      expect(timers.count(2_000)).toBe(0);
      expect(f.actions).not.toContain("claim-delivery:pilot:1");
      if (event === "stale lease at wake") {
        expect(f.logs.join("\n")).toContain(
          "Owned Codex delivery lease is stale",
        );
      }
    } finally {
      timers.restore();
      await f.dispose();
    }
  },
);

test("an open silent turn renews while responsive and closes when the app-server stops answering", async () => {
  const f = fixture("pilot", true, "receipt");
  const timers = fakeTimers(2_000, 5_000, 30_000);
  try {
    f.initial([item(f.pilotRequest)]);
    await f.runtime.start();
    f.enqueue(1);
    await f.runtime.processWorkUpdate([
      item(f.pilotRequest, f.ready(f.pilotRequest)),
    ]);
    await until(
      () => f.statuses.includes("working"),
      "the provider started a turn",
    );
    timers.tick(30_000);
    await until(
      () => f.actions.includes("edge:renew") && timers.count(30_000) === 1,
      "a responsive silent turn renews",
    );
    expect(
      f
        .providerRequests()
        .filter(({ method }) => method === "thread/read")
        .map(({ params }) => params),
    ).toEqual([{ threadId: f.deliveryThread, includeTurns: false }]);
    expect(f.actions.filter((action) => action === "edge:renew")).toHaveLength(
      1,
    );
    await f.sendFrame({ holdLiveness: true });
    timers.tick(30_000);
    await until(
      () =>
        f.providerRequests().filter(({ method }) => method === "thread/read")
          .length === 2,
      "the unresponsive process receives the next check",
    );
    timers.tick(5_000);
    await until(
      () => f.actions.includes("edge:release"),
      "the timeout closes and releases the session",
    );
    expect(f.pilot!.ownsThread(f.deliveryThread)).toBe(false);
    expect(f.actions.filter((action) => action === "edge:renew")).toHaveLength(
      1,
    );
    expect(timers.count(30_000)).toBe(0);
  } finally {
    timers.restore();
    await f.dispose();
  }
});

test("the app-server exit sends stopped status and releases ownership", async () => {
  const f = fixture("pilot", true, "receipt");
  try {
    f.initial([item(f.pilotRequest)]);
    await f.runtime.start();
    expect(f.pilot!.ownsThread(f.deliveryThread)).toBe(true);
    f.exitProvider();
    await until(
      () => f.actions.includes("edge:release"),
      "provider exit closes its run",
    );
    expect(f.events.at(-1)?.kind).toBe("session.ended");
    expect(f.statuses.at(-1)).toBe("stopped");
    expect(f.pilot!.ownsThread(f.deliveryThread)).toBe(false);
  } finally {
    await f.dispose();
  }
});
