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
  MESSAGE_COUNT,
  PAINT_SESSIONS,
  SESSION_COUNT,
  writeRows,
} from "./fixture";
import { handlePeer, openPeer, storageLock } from "./peer";
import { stats } from "./samples";
import { startWorker } from "./worker-client";
import type { sampleWorkerHeap } from "./worker-heap";

const params = new URLSearchParams(location.search);
const sampleCount = Number(params.get("trials"));

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
    wasmBytes: [] as number[],
  };
  const workerBytes: number[] = [];
  async function memory(worker: ReturnType<typeof startWorker>) {
    const { wasmBytes } = await worker.call("size");
    const heap: Awaited<ReturnType<typeof sampleWorkerHeap>> = await post(
      "/worker-heap",
      worker.name,
    );
    return {
      wasmBytes,
      total:
        heap === null
          ? null
          : heap.usedSize +
            (heap.embedderHeapUsedSize ?? 0) +
            Math.max(wasmBytes, heap.backingStorageSize ?? 0),
    };
  }

  let handoffIntact = true;
  for (let trial = 0; trial < sampleCount; trial++) {
    const revision = trial + 1;
    const { ms, intact } = await handoff("sqlite", peer, revision, async () => {
      const started = performance.now();
      const worker = startWorker();
      await worker.call("open");
      const ready = performance.now();
      const paint = await worker.call("paint");
      results.readyMs.push(ready - started);
      results.paintMs.push(performance.now() - ready);
      check(
        paint.sessions.length === PAINT_SESSIONS &&
          paint.messages.length === MESSAGE_COUNT,
        "SQLite paint rows missing",
      );
      const paintMemory = await memory(worker);
      const full = await worker.call("full");
      results.fullBootMs.push(performance.now() - started);
      check(
        Object.keys(full.externalEvents).length === EVENT_COUNT &&
          Object.keys(full.sessions).length === SESSION_COUNT &&
          full.messages.length === MESSAGE_COUNT,
        "SQLite boot rows missing",
      );
      const bootMemory = await memory(worker);
      const rows = writeRows(revision);
      const writeStarted = performance.now();
      const saved = worker.call("write", rows);
      results.mainWriteMs.push(performance.now() - writeStarted);
      await saved;
      results.savedMs.push(performance.now() - writeStarted);
      const start = 10_000 + 2000 * (trial % 50);
      const retained = 2000;
      const retentionStarted = performance.now();
      await worker.call("retain", start, retained);
      results.retentionMs.push(performance.now() - retentionStarted);
      check(
        await worker.call("verifyRetention", start, retained),
        "SQLite retention batch did not commit",
      );
      await worker.call(
        "write",
        Array.from({ length: retained }, (_, index) => eventRow(start + index)),
      );
      const retentionMemory = await memory(worker);
      const checkpoints = [paintMemory, bootMemory, retentionMemory];
      results.wasmBytes.push(
        Math.max(...checkpoints.map((point) => point.wasmBytes)),
      );
      const [paintBytes, bootBytes, retentionBytes] = checkpoints.map(
        (point) => point.total,
      );
      if (paintBytes !== null && bootBytes !== null && retentionBytes !== null)
        workerBytes.push(Math.max(paintBytes, bootBytes, retentionBytes));
      return () => worker.close();
    });
    results.handoffMs.push(ms);
    handoffIntact &&= intact;
  }
  const worker = startWorker();
  await worker.call("open");
  await worker.call("stage", sampleCount + 1);
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
      workerBytes:
        workerBytes.length === sampleCount ? stats(workerBytes) : null,
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
