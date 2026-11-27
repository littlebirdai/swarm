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

test.each(["empty inbox", "reconciled inbox"])(
  "an idle owned Codex thread uses no recurring probes or polls with %s",
  async (inbox) => {
    const f = fixture("pilot", true, "receipt");
    const schedule = globalThis.setTimeout;
    const polls: (() => void)[] = [];
    const timers = spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: (...args: unknown[]) => void,
      delay?: number,
      ...args: unknown[]
    ) => {
      const timer = schedule(callback, delay, ...args);
      if (delay === 2_000) {
        clearTimeout(timer);
        polls.push(() => callback(...args));
      }
      return timer;
    }) as typeof setTimeout);
    const tick = async () => {
      for (const poll of polls.splice(0)) poll();
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
        expect(polls).toHaveLength(1);
        f.queue.shift();
        await tick();
        expect(
          f.runtime.coordinator.getActiveDelivery("pilot"),
        ).toBeUndefined();
      }
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
      timers.mockRestore();
      await f.dispose();
    }
  },
);
