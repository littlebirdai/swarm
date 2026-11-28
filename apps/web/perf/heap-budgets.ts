import { heapStats } from "bun:jsc";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { join } from "node:path";
import {
  installSignedInPrincipal,
  TEST_PRINCIPAL,
} from "../store/__tests__/fixtures/signedInPrincipal";
import { clearProtectedInboxMemory, useInboxStore } from "../store/inboxStore";
import { cacheStorage, loadCache } from "../store/idb-cache";
import { _reopenForTests, db } from "../store/persistence/db";
import { writeOwnerStamp } from "../store/persistence/ownership";
import { measureDetailRows } from "./detail-rows-size";
import {
  budgetMessages,
  calibratedDocDetailRows,
  calibratedDocRows,
  calibratedSessionRows,
  fixtureSizes,
  id,
  retainedRows,
} from "./store-budget-fixture";

const mib = 1024 * 1024;

const WINDOW_HEAP_THRESHOLDS = {
  main: 12 * mib,
  palette: Math.round(4.5 * mib),
  people: 3 * mib,
  "call-panel": Math.round(5.5 * mib),
  "agent-dock": 3 * mib,
  "main-account": 72 * mib,
} as const;

type WindowTarget = keyof typeof WINDOW_HEAP_THRESHOLDS;

type HeapMeasurement = {
  panel: WindowTarget;
  scoped: boolean;
  keys: number;
  heapBytes: number;
  liveHeapBytes?: number;
  snapshotBytes?: number;
};

async function measureMainAccountWorker() {
  Bun.gc(true);
  const before = heapStats().heapSize;
  measureDetailRows();
  installSignedInPrincipal(TEST_PRINCIPAL);
  await _reopenForTests({ indexedDB: new IDBFactory(), IDBKeyRange });
  try {
    await db.meta.put({ key: "currentUser", value: { _id: TEST_PRINCIPAL } });
    await writeOwnerStamp(TEST_PRINCIPAL, "test-fixture");
    const seedState: Record<string, any> = {
      currentUser: { _id: TEST_PRINCIPAL },
    };
    for (const [key, size] of Object.entries(fixtureSizes)) {
      if (key === "taskComments" || key === "pullRequestDetails") continue;
      const rows =
        key === "docDetails"
          ? calibratedDocDetailRows(size)
          : retainedRows(key, size);
      seedState[key] = Object.fromEntries(rows.map((row) => [row._id, row]));
    }
    seedState.docs = Object.fromEntries(
      calibratedDocRows(1000).map((row) => [row._id, row]),
    );
    cacheStorage.setHydrating(false);
    cacheStorage.writePatches(
      Object.keys(seedState)
        .filter((key) => key !== "currentUser")
        .map((key) => ({ op: "replace", path: [key], value: seedState[key] })),
      seedState,
    );
    await cacheStorage.flushPersistence();
    const loaded = await loadCache([...Object.keys(fixtureSizes), "docs"]);
    for (const [key, map] of Object.entries(loaded ?? {})) {
      if (
        key === "taskComments" ||
        key === "pullRequestDetails" ||
        !map ||
        typeof map !== "object"
      )
        continue;
      useInboxStore
        .getState()
        .syncTable(key, Object.values(map), { isDelta: false });
    }
    useInboxStore
      .getState()
      .syncTable("sessions", calibratedSessionRows(1200), { isDelta: true });
    clearProtectedInboxMemory();
    for (let conversation = 0; conversation < 400; conversation++) {
      useInboxStore
        .getState()
        .setMessages(
          id(conversation),
          budgetMessages(conversation),
          undefined,
          "cache",
        );
    }
  } finally {
    db.close();
  }
  Bun.gc(true);
  const after = heapStats().heapSize;
  console.log(
    JSON.stringify({
      panel: "main-account",
      scoped: false,
      keys: 14,
      heapBytes: after - before,
      liveHeapBytes: after,
    }),
  );
}

function runSubprocess(args: string[]): HeapMeasurement {
  const result = Bun.spawnSync(["bun", ...args], {
    env: { ...process.env, VITE_DESKTOP_PANEL_SCOPE: "1" },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  if (result.exitCode !== 0 || result.signalCode) {
    throw new Error(
      `Heap worker failed (${args.join(" ")}, exit=${result.exitCode}, signal=${result.signalCode}): ${result.stderr.toString()}`,
    );
  }
  const line = result.stdout.toString().trim().split("\n").at(-1);
  if (!line) throw new Error(`Missing output from ${args.join(" ")}`);
  return JSON.parse(line) as HeapMeasurement;
}

function formatMib(bytes: number): string {
  return `${(bytes / mib).toFixed(2)} MiB`;
}

if (process.argv[2] === "--worker" && process.argv[3] === "main-account") {
  await measureMainAccountWorker();
  process.exit(0);
}

const here = import.meta.dir;
const jsonFlag = process.argv.includes("--json");
const targets: WindowTarget[] = [
  "main",
  "palette",
  "people",
  "call-panel",
  "agent-dock",
  "main-account",
];

const results = targets.map((target) =>
  target === "main-account"
    ? runSubprocess([import.meta.path, "--worker", "main-account"])
    : runSubprocess([join(here, "desktop-panel-heap.ts"), target]),
);

const mainReplicated = results.find((entry) => entry.panel === "main");
const evaluations = results.map((entry) => {
  const thresholdBytes = WINDOW_HEAP_THRESHOLDS[entry.panel];
  const smallerThanMain =
    entry.panel === "main" ||
    entry.panel === "main-account" ||
    (mainReplicated ? entry.heapBytes < mainReplicated.heapBytes : true);
  const pass =
    entry.heapBytes > 0 && entry.heapBytes <= thresholdBytes && smallerThanMain;
  return {
    ...entry,
    thresholdBytes,
    smallerThanMain,
    pass,
  };
});

if (jsonFlag) {
  console.log(JSON.stringify({ mib, windows: evaluations }, null, 2));
} else {
  for (const row of evaluations) {
    const label = row.pass ? "pass" : "FAIL";
    const extra = row.liveHeapBytes
      ? `, live ${formatMib(row.liveHeapBytes)}`
      : "";
    console.log(
      `${label}  ${row.panel.padEnd(13)} keys=${String(row.keys).padStart(3)}  heap=${formatMib(row.heapBytes).padStart(10)} (${row.heapBytes} B)  limit=${formatMib(row.thresholdBytes).padStart(9)} (${row.thresholdBytes} B)${extra}`,
    );
  }
}

process.exit(evaluations.every((row) => row.pass) ? 0 : 1);
