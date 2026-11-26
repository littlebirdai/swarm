import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RecursiveWatcher } from "../recursiveWatcher.js";
import { transcriptDirWatcherConfig } from "../transcriptDirWatcher.js";
import { watchDirFilter, watchFilter } from "../syncScope.js";
import { scanPredicates } from "./scanPolicy.js";
import {
  configureDaemonWorkers,
  closeDaemonWorkers,
  scanWorkerHost,
} from "./bridge.js";
import type { ScanPolicy } from "./scanTypes.js";
const dirs: string[] = [];
const watchers: RecursiveWatcher[] = [];
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const root = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "f2-watch-"));
  dirs.push(d);
  return d;
};
const write = (base: string, rel: string) => {
  const p = path.join(base, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "{}\n");
  return p;
};
const workerClock = {
  wall: Date.now.bind(Date),
  mono: performance.now.bind(performance),
};
const start = (enabled: boolean) =>
  configureDaemonWorkers(
    enabled,
    {},
    {
      clock: workerClock,
      invocation: {
        command: process.execPath,
        args: [path.resolve(import.meta.dir, "../main.ts"), "_worker", "scan"],
      },
    },
  );
async function until(f: () => boolean) {
  const until = Date.now() + 5000;
  while (!f()) {
    if (Date.now() > until) throw new Error("watcher event timeout");
    await pause(30);
  }
}
afterEach(async () => {
  for (const w of watchers.splice(0)) w.stop();
  closeDaemonWorkers();
  await pause(40);
  for (const d of dirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
const id = "12345678-1234-1234-1234-123456789abc";
for (const mode of ["native", "chokidar"] as const)
  for (const enabled of [false, true])
    test.skipIf(mode === "native" && process.platform !== "darwin")(
      `${mode} worker=${enabled} primes sorted, observes real changes and preserves pruning across restart`,
      async () => {
        const base = root();
        const cfg = transcriptDirWatcherConfig("gemini", base);
        write(base, "hash/chats/old.json");
        write(base, "hash/checkpoints/no.json");
        const seen: string[] = [];
        let primes = 0,
          existing: string[] = [];
        await start(enabled);
        const w = new RecursiveWatcher({
          path: base,
          mode,
          filter: cfg.watchFilter,
          dirFilter: cfg.dirFilter,
          scanPolicy: cfg.scanPolicy,
          maxDepth: cfg.maxDepth,
          debounceMs: 30,
          rescanIntervalMs: 150,
          onExisting: (files) => {
            primes++;
            existing = files
              .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
              .map((f) => f.rel);
          },
          callback: (f, event) =>
            seen.push(`${event}:${path.relative(base, f)}`),
        });
        watchers.push(w);
        w.start();
        await w.whenPrimed();
        expect(primes).toBe(1);
        expect(existing).toEqual(["hash/chats/old.json"]);
        if (enabled) expect(scanWorkerHost()!.state.pid).toBeGreaterThan(1);
        await pause(250);
        seen.length = 0;
        write(base, "hash/checkpoints/rejected.json");
        write(base, "hash/chats/new.json");
        await until(() => seen.includes("add:hash/chats/new.json"));
        fs.appendFileSync(path.join(base, "hash/chats/old.json"), "changed\n");
        await until(() => seen.includes("change:hash/chats/old.json"));
        expect(seen.some((e) => e.includes("checkpoints"))).toBe(false);
        w.stop();
        const before = seen.length;
        write(base, "hash/chats/stopped.json");
        await pause(250);
        expect(seen.length).toBe(before);
        await w.restart();
        await w.whenPrimed();
        expect(primes).toBe(2);
        expect(existing).toContain("hash/chats/stopped.json");
      },
      15000,
    );

test("both watcher backends discard delayed priming after stop; crash fallback publishes existing files once", async () => {
  for (const mode of ["native", "chokidar"] as const) {
    if (mode === "native" && process.platform !== "darwin") continue;
    const base = root();
    for (let i = 0; i < 350; i++) write(base, `p/${i}.jsonl`);
    await start(true);
    let primes = 0;
    let existing: string[] = [];
    const policy: ScanPolicy = { files: "jsonl" };
    const w = new RecursiveWatcher({
      path: base,
      mode,
      ...{ filter: scanPredicates(base, policy).fileFilter },
      scanPolicy: policy,
      callback: () => {},
      onExisting: (files) => {
        primes++;
        existing = files.map((f) => f.path);
      },
      rescanIntervalMs: 5000,
    });
    watchers.push(w);
    w.start();
    w.stop();
    await w.whenPrimed();
    expect(primes).toBe(0);
    const host = scanWorkerHost()!;
    const request = host.request.bind(host);
    let killed = false;
    host.request = async (...args: Parameters<typeof host.request>) => {
      const result: any = await request(...args);
      if (args[0] === "scan" && result.rows.length && !killed) {
        killed = true;
        process.kill(host.state.pid!, "SIGKILL");
      }
      return result;
    };
    await w.restart();
    await w.whenPrimed();
    expect(primes).toBe(1);
    expect(existing).toHaveLength(350);
    expect(new Set(existing).size).toBe(350);
    w.stop();
    closeDaemonWorkers();
  }
}, 20000);

test("production Claude, Codex, Pi, Grok and vault policies prime actual watcher scans", async () => {
  const layouts: Array<{
    policy: ScanPolicy;
    depth: number;
    good: string;
    bad: string;
  }> = [
    {
      policy: { dirs: "claudeWatch", files: "claudeWatch" },
      depth: 6,
      good: `p/${id}/subagents/agent-a.jsonl`,
      bad: `p/${id}/tool-results/x.jsonl`,
    },
    {
      policy: transcriptDirWatcherConfig("codex").scanPolicy!,
      depth: 4,
      good: "2026/09/05/a.jsonl",
      bad: "scratch/09/05/x.jsonl",
    },
    {
      policy: transcriptDirWatcherConfig("pi").scanPolicy!,
      depth: 2,
      good: "slug/a.jsonl",
      bad: "slug/deeper/x.jsonl",
    },
    {
      policy: transcriptDirWatcherConfig("grok").scanPolicy!,
      depth: 3,
      good: `slug/${id}/updates.jsonl`,
      bad: "slug/not-uuid/updates.jsonl",
    },
    {
      policy: { dirs: "vault", files: "vault" },
      depth: 6,
      good: "notes/a.md",
      bad: "node_modules/a.md",
    },
  ];
  for (const layout of layouts) {
    const base = root();
    write(base, layout.good);
    write(base, layout.bad);
    await start(true);
    const predicates = scanPredicates(base, layout.policy);
    let rows: string[] = [];
    const w = new RecursiveWatcher({
      path: base,
      filter: predicates.fileFilter,
      dirFilter: predicates.dirFilter,
      scanPolicy: layout.policy,
      maxDepth: layout.depth,
      callback: () => {},
      onExisting: (files) => {
        rows = files.map((f) => f.rel);
      },
    });
    watchers.push(w);
    w.start();
    await w.whenPrimed();
    expect(rows).toEqual([layout.good]);
    expect(scanWorkerHost()!.state.pid).toBeGreaterThan(1);
    w.stop();
    closeDaemonWorkers();
  }
}, 15000);

test.skipIf(process.platform !== "darwin")(
  "native idle cadence stays serial; rejected events cannot accelerate it; stop removes all work",
  async () => {
    const rescanIntervalMs = 180;
    for (const enabled of [false, true]) {
      const base = root();
      write(base, "hash/chats/a.json");
      write(base, "hash/checkpoints/a.json");
      await start(enabled);
      const cfg = transcriptDirWatcherConfig("gemini", base);
      const w = new RecursiveWatcher({
        path: base,
        mode: "native",
        filter: cfg.watchFilter,
        dirFilter: cfg.dirFilter,
        scanPolicy: cfg.scanPolicy,
        maxDepth: cfg.maxDepth,
        callback: () => {},
        rescanIntervalMs,
        debounceMs: 10,
      });
      watchers.push(w);
      const internals = w as any;
      const onNativeEvent = internals.onNativeEvent.bind(w);
      internals.onNativeEvent = () => {};
      const walk = internals.walkTree.bind(w);
      const runRescan = internals.runRescan.bind(w);
      const requestRescan = internals.requestRescan.bind(w);
      let schedulingRescan = false;
      internals.requestRescan = (...args: unknown[]) => {
        schedulingRescan = true;
        try {
          return requestRescan(...args);
        } finally {
          schedulingRescan = false;
        }
      };
      const rescans: Promise<void>[] = [];
      let walkStarted = Promise.withResolvers<void>();
      let releaseWalk = Promise.withResolvers<void>();
      let active = 0;
      let maxActive = 0;
      const starts: number[] = [];
      const ends: number[] = [];
      internals.walkTree = async (...args: [number, boolean]) => {
        starts.push(Date.now());
        active++;
        maxActive = Math.max(active, maxActive);
        try {
          if (args[1]) {
            walkStarted.resolve();
            await releaseWalk.promise;
          }
          await walk(...args);
        } finally {
          active--;
          ends.push(Date.now());
        }
      };
      internals.runRescan = () => {
        const rescan = runRescan();
        rescans.push(rescan);
        return rescan;
      };

      let now = Date.now();
      let timerId = 0;
      const timers = new Map<number, { at: number; run: () => void }>();
      const time = spyOn(Date, "now").mockImplementation(() => now);
      const realSet = globalThis.setTimeout;
      const realClear = globalThis.clearTimeout;
      const schedule = spyOn(globalThis, "setTimeout").mockImplementation(((
        run: (...args: unknown[]) => void,
        ms = 0,
        ...args: unknown[]
      ) => {
        if (!schedulingRescan) return realSet(run, ms, ...args);
        const id = --timerId;
        timers.set(id, { at: now + ms, run: () => run(...args) });
        return id;
      }) as typeof setTimeout);
      const cancel = spyOn(globalThis, "clearTimeout").mockImplementation(((
        id: ReturnType<typeof setTimeout> | number | undefined,
      ) => {
        if (typeof id !== "number" || !timers.delete(id)) realClear(id);
      }) as typeof clearTimeout);
      const advance = (ms: number) => {
        const target = now + ms;
        for (;;) {
          const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
          if (!next || next[1].at > target) break;
          now = next[1].at;
          timers.delete(next[0]);
          next[1].run();
        }
        now = target;
      };
      try {
        w.start();
        await w.whenPrimed();
        for (let i = 0; i < 4; i++) {
          for (let burst = 0; burst < 9; burst++) {
            onNativeEvent("hash/checkpoints/a.json");
            advance(18);
          }
          onNativeEvent("hash/checkpoints/a.json");
          advance(17);
          expect(rescans).toHaveLength(i);
          expect(internals.probeTimers.size).toBe(0);
          advance(1);
          expect(rescans).toHaveLength(i + 1);
          await walkStarted.promise;
          expect(starts[i + 1] - ends[i]).toBe(rescanIntervalMs);

          internals.requestRescan(true);
          advance(2 * rescanIntervalMs);
          await Promise.resolve();
          expect(rescans).toHaveLength(i + 1);
          expect(active).toBe(1);
          releaseWalk.resolve();
          await rescans[i];
          walkStarted = Promise.withResolvers<void>();
          releaseWalk = Promise.withResolvers<void>();
        }
        expect(maxActive).toBe(1);
        expect(internals.rescanTimer).not.toBeNull();
        const beforeStop = rescans.length;
        w.stop();
        expect(internals.rescanTimer).toBeNull();
        expect(timers.size).toBe(0);
        expect(internals.probeTimers.size).toBe(0);
        advance(2 * rescanIntervalMs);
        expect(rescans).toHaveLength(beforeStop);
        expect(starts).toHaveLength(5);
        expect(active).toBe(0);
      } finally {
        w.stop();
        releaseWalk.resolve();
        cancel.mockRestore();
        schedule.mockRestore();
        time.mockRestore();
        await Promise.allSettled(rescans);
        closeDaemonWorkers();
      }
    }
  },
  10000,
);

test("stop during restart delay cannot reopen a watcher", async () => {
  const base = root();
  const w = new RecursiveWatcher({
    path: base,
    filter: () => true,
    callback: () => {},
  });
  watchers.push(w);
  w.start();
  await w.whenPrimed();
  const restarting = w.restart();
  w.stop();
  await restarting;
  expect(w.isWatching).toBe(false);
});
