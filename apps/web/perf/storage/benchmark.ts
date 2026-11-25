import {
  closeDexie,
  dexieBoot,
  dexieRetention,
  dexieVerify,
  dexieWrite,
  seedDexie,
} from "./dexie-baseline";
import {
  check,
  EVENT_COUNT,
  eventRow,
  liveIds,
  READ_BATCH_SIZE,
  MESSAGE_COUNT,
  PAINT_SESSIONS,
  SESSION_COUNT,
  writeRows,
} from "./fixture";
import { handlePeer, openPeer, storageLock } from "./peer";
import {
  MEMORY_PHASES,
  stats,
  type MemoryPhase,
  type MemoryCheckpoint,
  type MemoryStats,
} from "./samples";
import { startWorker } from "./worker-client";
import type { sampleWorkerHeap } from "./worker-heap";

const params = new URLSearchParams(location.search);
const sampleCount = Number(params.get("trials"));
const canSampleHeap = params.get("heap") === "worker";

async function post(path: string, value?: unknown) {
  const response = await fetch(path, {
    method: "POST",
    body: JSON.stringify(value),
  });
  check(response.ok, `${path} returned ${response.status}`);
  return response.json();
}

async function handoff(
  engine: "dexie" | "sqlite",
  peer: ReturnType<typeof openPeer>,
  revision: number,
  writeAndClose: () => Promise<() => Promise<void>>,
) {
  let started = 0;
  await navigator.locks.request(storageLock, async () => {
    const close = await writeAndClose();
    peer.command({ action: "handoff", engine, revision });
    await peer.reply("queued");
    started = performance.now();
    await close();
  });
  const intact = (await peer.reply("visible")) === true;
  const ms = performance.now() - started;
  await peer.reply("released");
  return { ms, intact };
}

async function benchmarkDexie(peer: ReturnType<typeof openPeer>) {
  await seedDexie();
  const results = {
    readyMs: [] as number[],
    paintMs: [] as number[],
    fullBootMs: [] as number[],
    mainWriteMs: [] as number[],
    savedMs: [] as number[],
    retentionMs: [] as number[],
    handoffMs: [] as number[],
  };
  let handoffIntact = true;
  for (let trial = 0; trial < sampleCount; trial++) {
    const { openMs, paintMs, fullBootMs, externalEvents } = await dexieBoot();
    results.readyMs.push(openMs);
    results.paintMs.push(paintMs);
    results.fullBootMs.push(fullBootMs);
    const revision = trial + 1;
    const { ms, intact } = await handoff("dexie", peer, revision, async () => {
      const { mainMs, savedMs } = await dexieWrite(externalEvents, revision);
      results.mainWriteMs.push(mainMs);
      results.savedMs.push(savedMs);
      results.retentionMs.push(
        await dexieRetention(10_000 + 2000 * (trial % 50)),
      );
      return async () => closeDexie();
    });
    results.handoffMs.push(ms);
    handoffIntact &&= intact;
  }
  const crashPeer = openPeer();
  let crashIntact: boolean;
  try {
    await crashPeer.reply("ready");
    crashPeer.command({
      action: "crash",
      engine: "dexie",
      revision: sampleCount + 1,
    });
    await crashPeer.reply("staged");
    crashPeer.kill();
    crashIntact = await dexieVerify(sampleCount);
  } finally {
    crashPeer.close();
    closeDexie();
  }
  return {
    ...summarize(results),
    handoffIntact,
    crashIntact,
    databaseBytes: null,
  };
}

function summarize<K extends string>(
  samples: Record<K, number[]>,
): Record<K, ReturnType<typeof stats>> {
  return Object.fromEntries(
    Object.entries<number[]>(samples).map(([key, values]) => [
      key,
      stats(values),
    ]),
  ) as Record<K, ReturnType<typeof stats>>;
}

async function sqliteFileBytes() {
  const root = await navigator.storage.getDirectory();
  async function size(directory: FileSystemDirectoryHandle): Promise<number> {
    let total = 0;
    for await (const entry of directory.values()) {
      total +=
        entry.kind === "directory"
          ? await size(entry as FileSystemDirectoryHandle)
          : (await (entry as FileSystemFileHandle).getFile()).size;
    }
    return total;
  }
  return size(await root.getDirectoryHandle("storage-bench"));
}

type SQLiteWorker = ReturnType<typeof startWorker>;

async function readSQLiteBoot(
  worker: SQLiteWorker,
  checkpoint?: (phase: MemoryPhase) => Promise<void>,
) {
  const paint = await worker.call("paint");
  const paintAt = performance.now();
  check(
    paint.sessions.length === PAINT_SESSIONS &&
      paint.messages.length === MESSAGE_COUNT,
    "SQLite paint rows missing",
  );
  await checkpoint?.("paint");

  async function collect(
    collection: "sessions" | "externalEvents",
    first: { _id: string }[],
    after = "",
  ) {
    const rows = new Map(first.map((row) => [row._id, row]));
    while (true) {
      const batch = await worker.call("readBatch", collection, after);
      for (const row of batch) rows.set(row._id, row);
      if (batch.length < READ_BATCH_SIZE) return rows;
      after = batch[batch.length - 1]._id;
    }
  }

  const sessions = await collect(
    "sessions",
    paint.sessions,
    liveIds[liveIds.length - 1],
  );
  check(sessions.size === SESSION_COUNT, "SQLite boot sessions missing");
  await checkpoint?.("critical");
  const events = await collect("externalEvents", []);
  const bootAt = performance.now();
  check(events.size === EVENT_COUNT, "SQLite boot events missing");
  await checkpoint?.("boot");
  return { paintAt, bootAt };
}

type MemoryPoint = {
  wasmBytes: number;
  liveBytes: number | null;
  transientBytes: number | null;
};

function memoryStats(points: MemoryPoint[]): MemoryStats {
  const complete = (key: "liveBytes" | "transientBytes") => {
    const values = points.map((point) => point[key]);
    return values.every((value): value is number => value !== null)
      ? stats(values)
      : null;
  };
  return {
    wasmBytes: stats(points.map((point) => point.wasmBytes)),
    liveBytes: complete("liveBytes"),
    transientBytes: complete("transientBytes"),
  };
}

async function benchmarkWorkerMemory(retentionBatch: number) {
  const checkpointSamples: Record<MemoryPhase, MemoryPoint[]> = {
    open: [],
    paint: [],
    critical: [],
    boot: [],
    retention: [],
  };
  const maxima: MemoryPoint[] = [];
  for (let trial = 0; trial < sampleCount; trial++) {
    const worker = startWorker();
    const phaseSamples: MemoryPoint[] = [];
    async function checkpoint(phase: MemoryPhase) {
      const { wasmBytes } = await worker.call("size");
      const heap: Awaited<ReturnType<typeof sampleWorkerHeap>> = canSampleHeap
        ? await post("/worker-heap", worker.name)
        : null;
      const total = (usage: NonNullable<typeof heap>["live"]) =>
        wasmBytes +
        usage.usedSize +
        (usage.embedderHeapUsedSize ?? 0) +
        (usage.backingStorageSize ?? 0);
      const point = {
        wasmBytes,
        liveBytes: heap === null ? null : total(heap.live),
        transientBytes: heap === null ? null : total(heap.transient),
      };
      phaseSamples.push(point);
      checkpointSamples[phase].push(point);
    }
    try {
      await worker.call("open");
      await checkpoint("open");
      await readSQLiteBoot(worker, checkpoint);
      const start = 10_000 + retentionBatch * trial;
      await worker.call("retain", start, retentionBatch);
      await checkpoint("retention");
      await worker.call(
        "write",
        Array.from({ length: retentionBatch }, (_, index) =>
          eventRow(start + index),
        ),
      );
    } finally {
      await worker.close();
    }
    const summary = memoryStats(phaseSamples);
    maxima.push({
      wasmBytes: summary.wasmBytes.max,
      liveBytes: summary.liveBytes?.max ?? null,
      transientBytes: summary.transientBytes?.max ?? null,
    });
  }
  return {
    capability: canSampleHeap
      ? ("worker-heap" as const)
      : ("wasm-only" as const),
    ...memoryStats(maxima),
    checkpoints: Object.fromEntries(
      MEMORY_PHASES.map((phase) => {
        const metrics = Object.entries(memoryStats(checkpointSamples[phase]));
        const checkpoint = Object.fromEntries(
          metrics.map(([key, value]) => {
            if (value === null) return [key, null];
            const { count, p50, p95, max } = value;
            return [key, { count, p50, p95, max }];
          }),
        );
        return [phase, checkpoint];
      }),
    ) as Record<MemoryPhase, MemoryCheckpoint>,
  };
}

async function benchmarkSQLite(peer: ReturnType<typeof openPeer>) {
  const seed = startWorker();
  const { journal, sqliteVersion } = await seed.call("open");
  await seed.call("seed");
  const { databaseBytes } = await seed.call("size");
  await seed.close();
  const opfsBytes = await sqliteFileBytes();
  const results = {
    readyMs: [] as number[],
    paintMs: [] as number[],
    fullBootMs: [] as number[],
    mainWriteMs: [] as number[],
    savedMs: [] as number[],
    retentionMs: [] as number[],
    handoffMs: [] as number[],
  };
  const retentionBatch = 2000;
  let handoffIntact = true;
  for (let trial = 0; trial < sampleCount; trial++) {
    const revision = trial + 1;
    const { ms, intact } = await handoff("sqlite", peer, revision, async () => {
      const started = performance.now();
      const worker = startWorker();
      await worker.call("open");
      const ready = performance.now();
      const { paintAt, bootAt } = await readSQLiteBoot(worker);
      results.readyMs.push(ready - started);
      results.paintMs.push(paintAt - ready);
      results.fullBootMs.push(bootAt - started);
      const rows = writeRows(revision);
      const writeStarted = performance.now();
      const saved = worker.call("write", rows);
      results.mainWriteMs.push(performance.now() - writeStarted);
      await saved;
      results.savedMs.push(performance.now() - writeStarted);
      const start = 10_000 + retentionBatch * trial;
      const retentionStarted = performance.now();
      await worker.call("retain", start, retentionBatch);
      results.retentionMs.push(performance.now() - retentionStarted);
      check(
        await worker.call("verifyRetention", start, retentionBatch),
        "SQLite retention batch did not commit",
      );
      await worker.call(
        "write",
        Array.from({ length: retentionBatch }, (_, index) =>
          eventRow(start + index),
        ),
      );
      return () => worker.close();
    });
    results.handoffMs.push(ms);
    handoffIntact &&= intact;
  }
  await post("/progress", "Sample SQLite worker memory");
  const memory = await benchmarkWorkerMemory(retentionBatch);
  const worker = startWorker();
  await worker.call("open");
  const crashSpilledPages = await worker.call("stage", sampleCount + 1);
  worker.terminate();
  await post("/progress", "Recover SQLite worker");
  const recovered = startWorker();
  try {
    await recovered.call("open");
    const crashIntact =
      (await recovered.call("verify", sampleCount)) &&
      (await recovered.call("integrity"));
    return {
      ...summarize(results),
      memory,
      crashSpilledPages,
      journal,
      sqliteVersion,
      databaseBytes,
      opfsBytes,
      handoffIntact,
      crashIntact,
    };
  } finally {
    await recovered.close();
  }
}

async function benchmark() {
  check(
    Number.isSafeInteger(sampleCount) && sampleCount > 0 && sampleCount <= 50,
    "Invalid trial count",
  );
  const peer = openPeer();
  try {
    await peer.reply("ready");
    await post("/progress", "Run Dexie");
    const dexie = await benchmarkDexie(peer);
    await post("/progress", "Run SQLite");
    const sqlite = await benchmarkSQLite(peer);
    await post("/result", {
      status: "measured",
      userAgent: navigator.userAgent,
      dexie,
      sqlite,
    });
  } finally {
    peer.close();
  }
}

if (params.has("id")) handlePeer(params.get("id")!);
else
  void benchmark().catch(async (error) => {
    await post("/result", {
      status: "error",
      reason: error instanceof Error ? error.stack : String(error),
    });
  });
