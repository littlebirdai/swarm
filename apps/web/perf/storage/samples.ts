export const BROWSERS = ["chromium", "electron", "safari", "firefox"] as const;
export type Browser = (typeof BROWSERS)[number];

export function stats(values: number[]) {
  if (
    !values.length ||
    values.some((value) => !Number.isFinite(value) || value < 0)
  )
    throw new Error("Expected finite, nonnegative samples");
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max: sorted[sorted.length - 1],
    samples: values,
  };
}

export type Stats = ReturnType<typeof stats>;
export type Measurements = {
  readyMs: Stats;
  paintMs: Stats;
  fullBootMs: Stats;
  mainWriteMs: Stats;
  savedMs: Stats;
  retentionMs: Stats;
  handoffMs: Stats;
  handoffIntact: boolean;
  crashIntact: boolean;
  databaseBytes: number | null;
};
export type SQLiteMeasurements = Measurements & {
  workerBytes: Stats | null;
  wasmBytes: Stats;
  journal: string;
  sqliteVersion: string;
  opfsBytes: number;
};
export type BrowserResult =
  | { status: "not-run" | "error"; reason: string }
  | {
      status: "measured";
      userAgent: string;
      dexie: Measurements;
      sqlite: SQLiteMeasurements;
    };

export type Report = {
  trialCount: number;
  rowCount: number;
  machine: {
    cpu: string;
    logicalCPUs: number;
    release: string;
    load: number[][];
  };
  browsers: Record<Browser, BrowserResult>;
};
