import { expect, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  currentHeartbeatSessions,
  runHeartbeatFlush,
  setSyncServiceForTests,
  trackSessionPaneForTests,
} from "../daemon.js";
import { strictStub } from "../test-helpers/strictStub.js";
import type { SyncService } from "../syncService.js";
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

test("stream activity skips the probe and one slow reply leaves the active session running", async () => {
  const f = fixture("pilot", true, "receipt");
  const timers = fakeTimers(2_000, 5_000, 30_000);
  const probes = () =>
    f.providerRequests().filter(({ method }) => method === "thread/read");
  const renewals = () =>
    f.actions.filter((action) => action === "edge:renew").length;
  const renewed = (count: number) =>
    until(
      () => renewals() === count && timers.count(30_000) === 1,
      `renewal ${count} finishes`,
    );
  try {
    await openTurn(f);
    timers.tick(30_000);
    await renewed(1);
    expect(probes()).toEqual([]);

    await f.sendFrame({ holdLiveness: true });
    timers.tick(30_000);
    await until(
      () => probes().length === 1 && timers.count(5_000) === 1,
      "the silent turn receives a check",
    );
    timers.tick(5_000);
    await renewed(2);
    expect(f.pilot!.ownsThread(f.deliveryThread)).toBe(true);
    expect(f.statuses).toEqual(["working"]);

    await f.sendFrame({
      frame: {
        method: "thread/status/changed",
        params: { threadId: f.deliveryThread, status: { type: "active" } },
      },
    });
    await until(() => f.statuses.length === 2, "new stream progress arrived");
    timers.tick(30_000);
    await renewed(3);
    expect(probes()).toHaveLength(1);

    await f.sendFrame({ holdLiveness: false });
    timers.tick(30_000);
    await renewed(4);
    expect(probes().at(-1)?.params).toEqual({
      threadId: f.deliveryThread,
      includeTurns: false,
    });
    expect(probes()).toHaveLength(2);
    await f.sendFrame({ holdLiveness: true });
    for (let attempt = 3; attempt <= 4; attempt++) {
      timers.tick(30_000);
      await until(
        () => probes().length === attempt && timers.count(5_000) === 1,
        "another check reaches the provider",
      );
      timers.tick(5_000);
      await renewed(attempt + 2);
      expect(f.pilot!.closed).toBe(false);
    }
  } finally {
    timers.restore();
    await f.dispose();
  }
});

async function openTurn(f: ReturnType<typeof fixture>) {
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
}

test("three consecutive missed checks stop renewal, publish stopped, and close the session", async () => {
  const f = fixture("pilot", true, "receipt");
  const timers = fakeTimers(2_000, 5_000, 30_000);
  const renewals = () =>
    f.actions.filter((action) => action === "edge:renew").length;
  try {
    await openTurn(f);
    await f.sendFrame({ holdLiveness: true });
    timers.tick(30_000);
    await until(
      () => renewals() === 1 && timers.count(30_000) === 1,
      "the active stream renews",
    );
    for (let attempt = 1; attempt <= 3; attempt++) {
      timers.tick(30_000);
      await until(
        () =>
          f.providerRequests().filter(({ method }) => method === "thread/read")
            .length === attempt && timers.count(5_000) === 1,
        `provider receives check ${attempt}`,
      );
      timers.tick(5_000);
      if (attempt < 3) {
        await until(
          () => renewals() === attempt + 1 && timers.count(30_000) === 1,
          "the lease is renewed through a missed check",
        );
        expect(f.pilot!.closed).toBe(false);
      }
    }
    await until(
      () => f.actions.includes("edge:release"),
      "the third miss closes the run",
    );
    expect(f.events.some(({ kind }) => kind === "session.ended")).toBe(false);
    expect(f.statuses.at(-1)).toBe("stopped");
    expect(f.pilot!.ownsThread(f.deliveryThread)).toBe(false);
    expect(renewals()).toBe(3);
    expect(timers.count(30_000)).toBe(0);
  } finally {
    timers.restore();
    await f.dispose();
  }
});

test.each(["on wake", "on poll"])(
  "an unexpected delivery failure stops polling %s",
  async (timing) => {
    const f = fixture("pilot", true, "receipt");
    const timers = fakeTimers(2_000);
    const reads = () =>
      f.actions.filter((action) => action === "edge:permits.next").length;
    try {
      f.initial([item(f.pilotRequest)]);
      await f.runtime.start();
      f.enqueue(1);
      f.queue[0]!.state = "started";
      if (timing === "on wake") f.setPermitReadStatus("takeover_fence");
      f.workSubscription().onUpdate([
        {
          ...item(f.pilotRequest, f.ready(f.pilotRequest)),
          nextDeliverySequence: 1,
        },
      ]);
      await f.runtime.processWorkUpdate([]);
      if (timing === "on poll") {
        expect(timers.count(2_000)).toBe(1);
        f.setPermitReadStatus("takeover_fence");
        timers.tick(2_000);
        await f.runtime.processWorkUpdate([]);
      }
      const afterFailure = reads();
      expect(timers.count(2_000)).toBe(0);
      for (let elapsed = 0; elapsed < 10_000; elapsed += 2_000) {
        timers.tick(2_000);
        await f.runtime.processWorkUpdate([]);
      }
      expect(reads()).toBe(afterFailure);
      expect(f.pilot!.closed).toBe(false);
      expect(f.logs.join("\n")).toContain(
        "cannot acknowledge a takeover fence",
      );
      f.setPermitReadStatus();
      f.workSubscription().onUpdate([
        {
          ...item(f.pilotRequest, f.ready(f.pilotRequest)),
          nextDeliverySequence: 2,
        },
      ]);
      await f.runtime.processWorkUpdate([]);
      expect(timers.count(2_000)).toBe(1);
    } finally {
      timers.restore();
      await f.dispose();
    }
  },
);

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

test.each([undefined, "1"])(
  "the relay flag %s preserves the owned lease and legacy heartbeat during an outage",
  async (flag) => {
    const outage = Promise.withResolvers<Response>();
    const grant = mock((signal: AbortSignal) => {
      signal.addEventListener("abort", () => outage.reject(signal.reason), {
        once: true,
      });
      return outage.promise;
    });
    const f = fixture("pilot", true, "receipt", { flag, grant });
    const timers = fakeTimers(30_000);
    const write = mock(
      async (
        _rows: Parameters<SyncService["heartbeatManagedSessionsBatch"]>[0],
      ) => ({ updated: 1 }),
    );
    trackSessionPaneForTests("legacy-pane", "fixture-pane");
    setSyncServiceForTests(
      strictStub<SyncService>("legacy heartbeat", {
        heartbeatManagedSessionsBatch: write,
      }),
    );
    try {
      f.initial([item(f.pilotRequest)]);
      await f.runtime.start();
      if (flag)
        await until(() => grant.mock.calls.length === 1, "relay grant begins");
      else await new Promise<void>((resolve) => setImmediate(resolve));

      timers.tick(30_000);
      await until(
        () => f.actions.includes("edge:renew"),
        "the Convex lease renews",
      );
      await runHeartbeatFlush();
      await f.runtime.processWorkUpdate([]);
      expect(write.mock.calls).toEqual([[[{ session_id: "legacy-pane" }]]]);
      expect(
        f.actions.filter((action) => action === "edge:renew"),
      ).toHaveLength(1);
      expect(
        f.actions.filter((action) => action === "edge:hello"),
      ).toHaveLength(flag ? 1 : 0);
      expect(grant).toHaveBeenCalledTimes(flag ? 1 : 0);
    } finally {
      trackSessionPaneForTests("legacy-pane", null);
      setSyncServiceForTests(null);
      timers.restore();
      await f.dispose();
    }
  },
);
