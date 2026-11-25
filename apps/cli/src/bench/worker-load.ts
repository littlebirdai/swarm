import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { writeSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { loadavg, tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { DAEMON_BUILD_ID } from "../daemonBuildId.js";
import { execFileAsync, spawn } from "../proc.js";
import { pollUntil } from "../test-helpers/pollUntil.js";
import { strictStub } from "../test-helpers/strictStub.js";
import type { WorkerHost } from "../workers/host.js";
import { percentile } from "./stats.js";
import type {
  WorkerPids,
  WorkerResourceMeasure,
} from "./worker-load-processes.js";

const modes = ["off", "on"] as const;
type Mode = (typeof modes)[number];

const profiles = {
  small: {
    fleet: 5,
    sessionsPerRound: 3,
    rounds: 12,
    intervalMs: 2000,
    concurrency: 4,
    rows: 1,
    bytes: 4 * 1024,
    dirs: 1,
    backlog: false,
  },
  normal: {
    fleet: 20,
    sessionsPerRound: 10,
    rounds: 12,
    intervalMs: 2000,
    concurrency: 4,
    rows: 1,
    bytes: 4 * 1024,
    dirs: 1,
    backlog: false,
  },
  fleet: {
    fleet: 200,
    sessionsPerRound: 17,
    rounds: 12,
    intervalMs: 2000,
    concurrency: 4,
    rows: 1,
    bytes: 4 * 1024,
    dirs: 1,
    backlog: false,
  },
  large: {
    fleet: 200,
    sessionsPerRound: 200,
    rounds: 1,
    intervalMs: 25_000,
    concurrency: 30,
    rows: 1,
    bytes: 1024 * 1024,
    dirs: 8,
    backlog: true,
  },
  backlog: {
    fleet: 200,
    sessionsPerRound: 30,
    rounds: 1,
    intervalMs: 35_000,
    concurrency: 30,
    rows: 240,
    bytes: 256,
    dirs: 8,
    backlog: true,
  },
} as const;
type Profile = keyof typeof profiles;
type Phase = "idle" | "load";
type Notice =
  | { phase: Phase; edge: "start"; pids: WorkerPids }
  | { phase: Phase; edge: "end" };

const tickMs = 10;
const trialTimeoutMs = 180_000;

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

async function phaseNotice(notice: Notice) {
  const acknowledgment = once(process, "message");
  assert.ok(process.send);
  process.send(notice);
  assert.deepEqual((await acknowledgment)[0], {
    phase: notice.phase,
    edge: notice.edge,
  });
}

async function trial(root: string, mode: Mode, profile: Profile) {
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

  const {
    fleet,
    sessionsPerRound,
    concurrency,
    rows,
    bytes,
    dirs,
    backlog,
    rounds,
    intervalMs,
  } = profiles[profile];
  const project = path.join(root, "project");
  const projects = Array.from({ length: dirs }, (_, i) =>
    path.join(root, ".claude", "projects", `synthetic-${i}`),
  );
  await Promise.all(
    [project, ...projects].map((dir) => mkdir(dir, { recursive: true })),
  );
  const sessions = Array.from({ length: fleet }, (_, i) => {
    const id = randomUUID();
    return {
      id,
      file: path.join(projects[i % dirs], id + ".jsonl"),
      size: 0,
      ack: 0,
    };
  });
  await Promise.all(sessions.map(({ file }) => Bun.write(file, "")));
  const conversations = Object.fromEntries(sessions.map(({ id }) => [id, id]));
  const pattern = "Synthetic transcript message. ";
  const payload = pattern
    .repeat(Math.ceil(bytes / pattern.length))
    .slice(0, bytes);
  const wire =
    payload.length > 100_000
      ? payload.slice(0, 100_000) +
        `\n... [truncated ${payload.length - 100_000} chars]`
      : payload;
  const pending = new Map<
    string,
    { session: (typeof sessions)[number]; end: number; content: string }
  >();
  const events: number[] = [];
  const holds: number[] = [];
  const missedRounds: number[] = [];
  let probes = 0;

  const backend = "https://worker-load.invalid";
  const reply: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(input, backend + "/api/mutation");
      assert.equal(init?.method, "POST");
      assert.equal(typeof init?.body, "string");
      const {
        path: mutation,
        args: [batch],
      } = JSON.parse(init!.body as string) as {
        path: string;
        args: [
          {
            api_token: string;
            conversation_id: string;
            messages: { message_uuid: string; content: string }[];
          },
        ];
      };
      assert.equal(mutation, "messages:addMessages");
      assert.equal(batch.api_token, "synthetic");
      const range = pending.get(batch.conversation_id);
      assert.ok(range, "unexpected conversation or duplicate delivery");
      assert.ok(batch.messages.length > 0);
      const ids: string[] = [];
      for (const message of batch.messages) {
        assert.ok(range.session.ack < range.end, "duplicate delivery");
        const expected: string = `${range.session.id}-${range.session.ack++}`;
        assert.equal(message.message_uuid, expected);
        assert.ok(message.content === range.content, "unexpected wire content");
        ids.push(expected);
      }
      if (range.session.ack === range.end) pending.delete(range.session.id);
      return Response.json({
        status: "success",
        value: { inserted: ids.length, ids },
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
  const enabled = mode === "on";
  let hosts: Record<string, WorkerHost | null> = {};
  const pids = () =>
    Object.fromEntries([
      ["daemon", process.pid],
      ...Object.entries(hosts).flatMap(([kind, host]) => {
        const pid = host?.state.pid;
        assert.equal(Boolean(pid), enabled, kind);
        return pid ? [[kind, pid] as const] : [];
      }),
    ]);
  const entry = path.join(import.meta.dir, "../main.ts");
  const probe = async () => {
    const { stdout } = await execFileAsync(
      "ps",
      backlog ? ["aux"] : ["-p", String(process.pid), "-o", "pid=,ppid="],
      { timeout: 5000, maxBuffer: 16 * 1024 * 1024 },
    );
    if (backlog) assert.match(stdout.split("\n")[0], /\bPID\b/);
    else
      assert.deepEqual(stdout.trim().split(/\s+/).map(Number), [
        process.pid,
        process.ppid,
      ]);
    probes++;
  };
  const writeRows = async (
    session: (typeof sessions)[number],
    count: number,
    content: string,
  ) => {
    const stamp = new Date().toISOString();
    const text =
      Array.from({ length: count }, (_, i) =>
        JSON.stringify({
          type: "user",
          uuid: `${session.id}-${session.ack + i}`,
          sessionId: session.id,
          cwd: project,
          timestamp: stamp,
          message: { role: "user", content },
        }),
      ).join("\n") + "\n";
    await appendFile(session.file, text);
    session.size += Buffer.byteLength(text);
  };
  const ingest = async (
    session: (typeof sessions)[number],
    count: number,
    content: string,
  ) => {
    const end = session.ack + count;
    pending.set(session.id, { session, end, content });
    await processSessionFile(
      session.file,
      session.id,
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
    assert.equal(session.ack, end);
    assert.equal(getPosition(session.file), session.size);
    assert.equal(getSyncRecord(session.file)?.lastSyncedPosition, session.size);
  };
  const churn = async (due: number, first: number) => {
    let next = 0;
    await Promise.all(
      Array.from(
        { length: Math.min(sessionsPerRound, concurrency) },
        async () => {
          while (next < sessionsPerRound) {
            const session = sessions[(first + next++) % fleet];
            if (!backlog) await writeRows(session, rows, payload);
            await ingest(session, rows, wire);
            const elapsed = performance.now() - due;
            for (let i = 0; i < rows; i++) events.push(elapsed);
          }
        },
      ),
    );
    assert.equal(pending.size, 0);
  };

  try {
    const probeHost = await configureDaemonWorkers(
      enabled,
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
    assert.equal(Boolean(probeHost?.state.pid), enabled);
    await writeRows(sessions[0], 1, pattern);
    await ingest(sessions[0], 1, pattern);
    assert.ok((await findStaleSessionFiles()).includes(sessions.at(-1)!.file));
    if (backlog)
      for (const session of sessions.slice(0, sessionsPerRound))
        await writeRows(session, rows, payload);
    await delay(1000);
    Bun.gc(true);
    await delay(250);
    const baseline = pids();
    await phaseNotice({ phase: "idle", edge: "start", pids: baseline });
    await delay(2000);
    await phaseNotice({ phase: "idle", edge: "end" });

    const firstProbe = probes;
    await phaseNotice({ phase: "load", edge: "start", pids: baseline });
    let nextTick = performance.now() + tickMs;
    const timer = setInterval(() => {
      const now = performance.now();
      holds.push(Math.max(0, now - nextTick));
      nextTick = now + tickMs;
    }, tickMs);
    try {
      const start = performance.now();
      for (let round = 0; round < rounds; round++) {
        const due = start + round * intervalMs;
        if (performance.now() < due) await delay(due - performance.now());
        const stopProbes = new AbortController();
        const observe = async () => {
          do {
            await Promise.all([probe(), findStaleSessionFiles()]);
            if (backlog && !stopProbes.signal.aborted)
              await delay(2000, undefined, { signal: stopProbes.signal }).catch(
                () => {},
              );
          } while (backlog && !stopProbes.signal.aborted);
        };
        const results = await Promise.allSettled([
          observe(),
          churn(due, round * sessionsPerRound).finally(() =>
            stopProbes.abort(),
          ),
        ]);
        for (const result of results)
          if (result.status === "rejected") throw result.reason;
        if (performance.now() >= due + intervalMs) missedRounds.push(round);
      }
      const end = start + rounds * intervalMs;
      if (performance.now() < end) await delay(end - performance.now());
    } finally {
      clearInterval(timer);
      await phaseNotice({ phase: "load", edge: "end" });
    }
    assert.deepEqual(pids(), baseline);
    assert.equal(events.length, sessionsPerRound * rows * rounds);
    assert.equal(
      sessions.filter(({ ack }, i) => ack > (i === 0 ? 1 : 0)).length,
      Math.min(fleet, sessionsPerRound * rounds),
    );
    return {
      profile,
      fleet,
      mode,
      holds: latency(holds),
      events: latency(events),
      missedRounds,
      probes: probes - firstProbe,
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

type Trial = Awaited<ReturnType<typeof trial>> &
  Record<Phase, WorkerResourceMeasure>;

async function freshTrial(mode: Mode, profile: Profile): Promise<Trial> {
  const { sampleWorkerResources } = await import("./worker-load-processes.js");
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "worker-load-")),
  );
  try {
    const child = spawn(
      process.execPath,
      ["--no-env-file", import.meta.path, "--trial", root, mode, profile],
      {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: {
          HOME: root,
          CODECAST_DIR: path.join(root, ".codecast"),
          TMPDIR: root,
          TMUX_TMPDIR: root,
          LC_ALL: "C",
          PATH: "/usr/bin:/bin",
          NODE_ENV: "test",
        },
        timeout: trialTimeoutMs,
        killSignal: "SIGKILL",
      },
    );
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    let stdout = "",
      stderr = "";
    child.stdout!.on("data", (chunk: string) => {
      stdout = (stdout + chunk).slice(-1_000_000);
    });
    child.stderr!.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-1_000_000);
    });
    const metrics: Partial<Record<Phase, WorkerResourceMeasure>> = {};
    let active: Phase | undefined;
    let sample: Awaited<ReturnType<typeof sampleWorkerResources>> | undefined;
    let error: unknown;
    let handling = Promise.resolve();
    child.on("message", (message: Notice) => {
      handling = handling
        .then(async () => {
          const { phase, edge } = message;
          assert.ok(phase === "idle" || phase === "load");
          if (edge === "start") {
            assert.equal(active, undefined);
            assert.equal(metrics[phase], undefined);
            assert.equal(message.pids.daemon, child.pid);
            assert.ok(
              Object.values(message.pids).every(
                (pid) => Number.isSafeInteger(pid) && pid > 1,
              ),
            );
            sample = await sampleWorkerResources(message.pids);
            active = phase;
          } else {
            assert.equal(edge, "end");
            assert.equal(active, phase);
            assert.ok(sample);
            const report = await sample();
            assert.ok(report);
            metrics[phase] = report;
            sample = undefined;
            active = undefined;
          }
          if (child.connected) child.send({ phase, edge });
        })
        .catch((reason) => {
          error = reason;
          child.kill("SIGKILL");
        });
    });
    try {
      const [code, signal] = await once(child, "close");
      await handling;
      if (error) throw error;
      assert.equal(
        code,
        0,
        `${profile} workers=${mode} exit ${code ?? signal}\n${stderr}`,
      );
      assert.ok(metrics.idle && metrics.load, "missing sampled phases");
      return { ...JSON.parse(stdout.trim().split("\n").at(-1)!), ...metrics };
    } finally {
      await handling;
      await sample?.(false);
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const tolerances = {
  holds: { p50: 5, p95: 5, p99: 5, max: 20 },
  events: { p50: 10, p95: 10, p99: 10, max: 25 },
  idle: {
    physicalPeakMiB: 16,
    cpuCores: 0.05,
    daemonPhysicalPeakMiB: 16,
    daemonCpuCores: 0.05,
  },
  load: {
    physicalPeakMiB: 16,
    cpuCores: 0.05,
    daemonPhysicalPeakMiB: 16,
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
          if (metric === "daemonPhysicalPeakMiB")
            return sample.processes.daemon.physicalPeakMiB;
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
  const args = process.argv.slice(2);
  if (args[0] === "--trial") {
    const [, root, mode, profile] = args;
    assert.ok(
      root && modes.includes(mode as Mode) && Object.hasOwn(profiles, profile),
    );
    try {
      writeSync(
        1,
        JSON.stringify(await trial(root, mode as Mode, profile as Profile)) +
          "\n",
      );
      process.exit(0);
    } catch (error) {
      writeSync(2, String(error instanceof Error ? error.stack : error) + "\n");
      process.exit(1);
    }
  } else {
    const { values } = parseArgs({
      args,
      options: {
        case: { type: "string" },
        pairs: { type: "string", default: "3" },
      },
    });
    assert.ok(
      !values.case || Object.hasOwn(profiles, values.case),
      "invalid case",
    );
    const pairCount = Number(values.pairs);
    assert.ok(
      Number.isInteger(pairCount) && pairCount >= 1 && pairCount <= 3,
      "invalid pair count",
    );
    let passed = true;
    console.log(
      JSON.stringify({
        bun: Bun.version,
        daemonBuild: DAEMON_BUILD_ID,
        platform: process.platform,
        arch: process.arch,
        initialLoad: loadavg(),
        pairCount,
      }),
    );
    for (const profile of values.case
      ? [values.case as Profile]
      : (Object.keys(profiles) as Profile[])) {
      const pairs: { on: Trial; off: Trial }[] = [];
      for (let pair = 0; pair < pairCount; pair++) {
        const pairTrials = {} as { on: Trial; off: Trial };
        for (const mode of pair % 2 ? [...modes].reverse() : modes) {
          pairTrials[mode] = await freshTrial(mode, profile);
          console.log(
            JSON.stringify({
              pair: pair + 1,
              ...pairTrials[mode],
              machineLoad: loadavg(),
            }),
          );
        }
        pairs.push(pairTrials);
      }
      const result = compare(pairs);
      console.log(
        JSON.stringify({ profile, fleet: profiles[profile].fleet, ...result }),
      );
      passed &&= result.failures.length === 0;
    }
    process.exitCode = passed ? 0 : 1;
  }
}
