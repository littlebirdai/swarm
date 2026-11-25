import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { loadavg, tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DAEMON_BUILD_ID } from "../daemonBuildId.js";
import { execFileAsync } from "../proc.js";
import { pollUntil } from "../test-helpers/pollUntil.js";
import { percentile } from "./stats.js";
import { strictStub } from "../test-helpers/strictStub.js";
import type { WorkerHost } from "../workers/host.js";

const modes = ["off", "on"] as const;
type Mode = (typeof modes)[number];
const fleetSizes = [5, 20, 200];
const pairCount = 3;
const rounds = 12;
const intervalMs = 2000;
const eventsPerRound = new Map([
  [5, 3],
  [20, 10],
  [200, 17],
]);
const idleMs = 2000;
const tickMs = 10;
const runFile = import.meta.path;

function latency(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  assert.ok(sorted.length > 0);
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5)!,
    p95: percentile(sorted, 0.95)!,
    p99: percentile(sorted, 0.99)!,
    max: sorted.at(-1)!,
  };
}

type ProcessSample = { rssMiB: number; cpuSeconds: number };
type Processes = Record<string, ProcessSample>;

async function processSample(pids: Record<string, number>): Promise<Processes> {
  const { stdout } = await execFileAsync(
    "/bin/ps",
    ["-o", "pid=,rss=,time=", "-p", Object.values(pids).join(",")],
    { timeout: 5000 },
  );
  const byPid = new Map(
    stdout
      .trim()
      .split("\n")
      .map((line) => {
        const [pid, rss, time] = line.trim().split(/\s+/);
        const [days, clock] = time.includes("-")
          ? time.split("-")
          : ["0", time];
        const cpuSeconds =
          Number(days) * 86400 +
          clock.split(":").reduce((sum, part) => sum * 60 + Number(part), 0);
        assert.ok(Number.isFinite(cpuSeconds) && Number(rss) > 0);
        return [
          Number(pid),
          { rssMiB: Number(rss) / 1024, cpuSeconds },
        ] as const;
      }),
  );
  return Object.fromEntries(
    Object.entries(pids).map(([name, pid]) => {
      const sample = byPid.get(pid);
      assert.ok(sample, `missing ${name} PID ${pid}`);
      return [name, sample];
    }),
  );
}

async function measureProcesses(
  pids: Record<string, number>,
  work: () => Promise<void>,
) {
  const first = await processSample(pids);
  const begin = performance.now();
  const samples = [first];
  const stop = new AbortController();
  const sampler = (async () => {
    while (!stop.signal.aborted) {
      await delay(250, undefined, { signal: stop.signal }).catch(() => {});
      if (!stop.signal.aborted) samples.push(await processSample(pids));
    }
  })();
  const outcomes = await Promise.allSettled([
    work().finally(() => stop.abort()),
    sampler,
  ]);
  for (const outcome of outcomes)
    if (outcome.status === "rejected") throw outcome.reason;
  const last = await processSample(pids);
  const seconds = (performance.now() - begin) / 1000;
  samples.push(last);
  const processes = Object.fromEntries(
    Object.keys(pids).map((name) => [
      name,
      {
        peakMiB: Math.max(...samples.map((sample) => sample[name].rssMiB)),
        cpuCores: (last[name].cpuSeconds - first[name].cpuSeconds) / seconds,
      },
    ]),
  );
  return {
    samples: samples.length,
    processes,
    peakMiB: Math.max(
      ...samples.map((sample) =>
        Object.values(sample).reduce((sum, row) => sum + row.rssMiB, 0),
      ),
    ),
    cpuCores: Object.values(processes).reduce(
      (sum, row) => sum + row.cpuCores,
      0,
    ),
  };
}

async function trial(root: string, mode: Mode, fleet: number) {
  assert.equal(process.env.HOME, root);
  assert.equal(process.cwd(), root);
  const offline = () => {
    throw new Error("offline worker benchmark attempted a network request");
  };
  globalThis.fetch = Object.assign(offline, { preconnect: offline });
  const { processSessionFile, findStaleSessionFiles } =
    await import("../daemon.js");
  const {
    configureDaemonWorkers,
    closeDaemonWorkers,
    ingestWorkerHost,
    scanWorkerHost,
  } = await import("../workers/bridge.js");
  const { workerInvocation } = await import("../workers/invocation.js");
  const { SyncService } = await import("../syncService.js");
  const { getSyncRecord } = await import("../syncLedger.js");
  const { getPosition } = await import("../positionTracker.js");
  const project = path.join(root, "project");
  const transcripts = path.join(root, ".claude", "projects", "synthetic");
  await mkdir(project);
  await mkdir(transcripts, { recursive: true });
  const ids = Array.from({ length: fleet }, () => randomUUID());
  const files = ids.map((id) => path.join(transcripts, id + ".jsonl"));
  await Promise.all(files.map((file) => Bun.write(file, "")));
  const conversations = Object.fromEntries(ids.map((id) => [id, id]));
  const payload = "Synthetic transcript message. ".repeat(140);
  const pending = new Map<string, { id: string; uuid: string }>();
  const accepted = new Map<string, string>();
  const sizes = new Map<string, number>();
  const events: number[] = [];
  const holds: number[] = [];
  const missedRounds: number[] = [];
  const backend = "https://worker-load.invalid";
  const reply: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(input, backend + "/api/mutation");
      assert.equal(init?.method, "POST");
      assert.equal(typeof init?.body, "string");
      const {
        path: mutation,
        args: [batch],
      } = JSON.parse(init!.body as string);
      assert.equal(mutation, "messages:addMessages");
      assert.equal(batch.api_token, "synthetic");
      const event = pending.get(batch.conversation_id);
      assert.ok(event, "unexpected conversation or duplicate delivery");
      assert.deepEqual(
        batch.messages.map(
          (message: { message_uuid: string }) => message.message_uuid,
        ),
        [event.uuid],
      );
      assert.equal(batch.messages[0].content, payload);
      accepted.set(event.id, event.uuid);
      pending.delete(event.id);
      return Response.json({
        status: "success",
        value: { inserted: 1, ids: [event.uuid] },
      });
    },
    { preconnect: offline },
  );
  globalThis.fetch = reply;
  const sync = new SyncService({ convexUrl: backend, authToken: "synthetic" });
  const queue = strictStub<Parameters<typeof processSessionFile>[7]>(
    "retry queue",
    {
      hasPendingConversation: () => false,
      getPendingOperations: () => [],
    },
  );
  const pendingMessages = {};
  const titles = {};
  const observable = mode === "on";
  let hosts: Record<string, WorkerHost | null> = {};
  const pids = () =>
    Object.fromEntries([
      ["daemon", process.pid],
      ...Object.entries(hosts).flatMap(([kind, host]) => {
        const pid = host?.state.pid;
        assert.equal(pid !== null && pid !== undefined, observable, kind);
        return pid ? [[kind, pid] as const] : [];
      }),
    ]);
  const entry = path.join(import.meta.dir, "../main.ts");
  const probe = async () => {
    const { stdout } = await execFileAsync(
      "ps",
      ["-p", String(process.pid), "-o", "pid=,ppid="],
      { timeout: 5000 },
    );
    assert.deepEqual(stdout.trim().split(/\s+/).map(Number), [
      process.pid,
      process.ppid,
    ]);
  };
  const churn = async (start: number, first: number, count: number) => {
    const expectations = Array.from({ length: count }, (_, i) => {
      const index = (first + i) % fleet;
      return { id: ids[index], uuid: randomUUID(), file: files[index] };
    });
    for (let offset = 0; offset < count; offset += 4) {
      await Promise.all(
        expectations.slice(offset, offset + 4).map(async (event) => {
          const { file } = event;
          const row =
            JSON.stringify({
              type: "user",
              uuid: event.uuid,
              sessionId: event.id,
              cwd: project,
              timestamp: new Date().toISOString(),
              message: { role: "user", content: payload },
            }) + "\n";
          pending.set(event.id, event);
          await appendFile(file, row);
          await processSessionFile(
            file,
            event.id,
            project,
            sync,
            "synthetic",
            undefined,
            conversations,
            queue,
            pendingMessages,
            titles,
            () => {},
          );
          assert.equal(accepted.get(event.id), event.uuid);
          const size = (sizes.get(file) ?? 0) + Buffer.byteLength(row);
          assert.equal(getPosition(file), size);
          assert.equal(getSyncRecord(file)?.lastSyncedPosition, size);
          sizes.set(file, size);
          events.push(performance.now() - start);
        }),
      );
    }
    assert.equal(pending.size, 0);
  };

  try {
    const probeHost = await configureDaemonWorkers(
      observable,
      { invocation: workerInvocation("probe", process.execPath, entry) },
      { invocation: workerInvocation("scan", process.execPath, entry) },
      { invocation: workerInvocation("ingest", process.execPath, entry) },
    );
    hosts = {
      probe: probeHost,
      scan: scanWorkerHost(),
      ingest: ingestWorkerHost(),
    };
    await probe();
    assert.equal(Boolean(probeHost?.state.pid), observable);
    await churn(performance.now(), 0, 1);
    events.length = 0;
    assert.ok((await findStaleSessionFiles()).includes(files.at(-1)!));
    const baseline = pids();
    const idle = await measureProcesses(baseline, () => delay(idleMs));
    let nextTick = performance.now() + tickMs;
    const timer = setInterval(() => {
      const now = performance.now();
      holds.push(Math.max(0, now - nextTick));
      nextTick = now + tickMs;
    }, tickMs);
    const rate = eventsPerRound.get(fleet)!;
    let load: Awaited<ReturnType<typeof measureProcesses>>;
    try {
      load = await measureProcesses(baseline, async () => {
        const start = performance.now();
        for (let round = 0; round < rounds; round++) {
          const due = start + round * intervalMs;
          if (performance.now() < due) await delay(due - performance.now());
          await Promise.all([
            probe(),
            findStaleSessionFiles(),
            churn(due, round * rate, rate),
          ]);
          if (performance.now() >= due + intervalMs) missedRounds.push(round);
        }
        const end = start + rounds * intervalMs;
        if (performance.now() < end) await delay(end - performance.now());
      });
    } finally {
      clearInterval(timer);
    }
    assert.deepEqual(pids(), baseline);
    assert.equal(events.length, rate * rounds);
    assert.equal(accepted.size, fleet);
    return {
      fleet,
      mode,
      holds: latency(holds),
      events: latency(events),
      idle,
      load,
      missedRounds,
    };
  } finally {
    const children = Object.values(hosts).flatMap(
      (host) => host?.state.pid ?? [],
    );
    closeDaemonWorkers();
    await pollUntil(
      () =>
        children.every((pid) => {
          try {
            process.kill(pid, 0);
            return false;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
            return true;
          }
        }),
      "worker exit",
    );
  }
}

type Trial = Awaited<ReturnType<typeof trial>>;

async function freshTrial(mode: Mode, fleet: number): Promise<Trial> {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "worker-load-")),
  );
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--no-env-file", runFile, root, mode, String(fleet)],
      {
        cwd: root,
        env: {
          HOME: root,
          CODECAST_DIR: path.join(root, ".codecast"),
          TMPDIR: root,
          TMUX_TMPDIR: root,
          LC_ALL: "C",
          PATH: "/usr/bin:/bin",
          NODE_ENV: "test",
        },
        timeout: 120_000,
      },
    );
    return JSON.parse(stdout.trim().split("\n").at(-1)!);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const tolerances = {
  holds: { p50: 5, p95: 5, p99: 5, max: 20 },
  events: { p50: 10, p95: 10, p99: 10, max: 25 },
  idle: {
    peakMiB: 16,
    cpuCores: 0.05,
    daemonPeakMiB: 16,
    daemonCpuCores: 0.05,
  },
  load: {
    peakMiB: 16,
    cpuCores: 0.05,
    daemonPeakMiB: 16,
    daemonCpuCores: 0.05,
  },
} as const;

function compare(pairs: { on: Trial; off: Trial }[]) {
  const median = (values: number[]) =>
    percentile(
      values.sort((a, b) => a - b),
      0.5,
    )!;
  const rows: {
    metric: string;
    off: number;
    on: number;
    delta: number;
    limit: number;
  }[] = [];
  for (const category of ["holds", "events", "idle", "load"] as const) {
    for (const [metric, absolute] of Object.entries(tolerances[category])) {
      const read = (trial: Trial): number => {
        const sample = trial[category];
        if ("processes" in sample) {
          if (metric === "daemonPeakMiB")
            return sample.processes.daemon.peakMiB;
          if (metric === "daemonCpuCores")
            return sample.processes.daemon.cpuCores;
        }
        return Reflect.get(sample, metric);
      };
      const off = median(pairs.map((pair) => read(pair.off)));
      rows.push({
        metric: `${category}.${metric}`,
        off,
        on: median(pairs.map((pair) => read(pair.on))),
        delta: median(pairs.map((pair) => read(pair.on) - read(pair.off))),
        limit: Math.max(absolute, off * 0.1),
      });
    }
  }
  return {
    rows,
    failures: [
      ...rows.filter((row) => row.delta > row.limit).map((row) => row.metric),
      ...pairs.flatMap(({ on, off }, index) => [
        ...(on.holds.p99 > 100 || on.holds.max >= 1000
          ? [`pair ${index + 1} loop budget`]
          : []),
        ...(on.missedRounds.length || off.missedRounds.length
          ? [`pair ${index + 1} round deadline`]
          : []),
      ]),
    ],
  };
}

if (import.meta.main) {
  const [root, mode, count] = process.argv.slice(2);
  if (root) {
    assert.ok(
      modes.includes(mode as Mode) && fleetSizes.includes(Number(count)),
    );
    try {
      writeSync(
        1,
        JSON.stringify(await trial(root, mode as Mode, Number(count))) + "\n",
      );
      process.exit(0);
    } catch (error) {
      writeSync(2, String(error instanceof Error ? error.stack : error) + "\n");
      process.exit(1);
    }
  } else {
    let passed = true;
    console.log(
      JSON.stringify({
        bun: Bun.version,
        daemonBuild: DAEMON_BUILD_ID,
        platform: process.platform,
        arch: process.arch,
        initialLoad: loadavg(),
      }),
    );
    for (const fleet of fleetSizes) {
      const pairs: { on: Trial; off: Trial }[] = [];
      for (let pair = 0; pair < pairCount; pair++) {
        const pairTrials = {} as { on: Trial; off: Trial };
        for (const setting of pair % 2 ? [...modes].reverse() : modes) {
          pairTrials[setting] = await freshTrial(setting, fleet);
          console.log(
            JSON.stringify({
              pair: pair + 1,
              ...pairTrials[setting],
              machineLoad: loadavg(),
            }),
          );
        }
        pairs.push(pairTrials);
      }
      const result = compare(pairs);
      console.log(JSON.stringify({ fleet, ...result }));
      passed &&= result.failures.length === 0;
    }
    process.exitCode = passed ? 0 : 1;
  }
}
