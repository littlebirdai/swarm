export type BootPhase = "critical" | "deferred";

const WRITE_KINDS = [
  "add",
  "put",
  "delete",
  "deleteRange",
  "collection_prepare",
  "message_prepare",
] as const;

type WriteKind = (typeof WRITE_KINDS)[number];

const MAX_BOOT_TABLES = 192;
const MAX_COUNT = 0xffffffff;
const WRITE_BUCKETS_MS = [
  0.025, 0.05, 0.075, 0.1, 0.125, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.75, 1, 1.5,
  2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024,
  2048, 4096, 8192, 16384, 65536,
];

type Counters = Record<string, number>;

export type StorageTimingSample = {
  criticalBootMs?: Counters;
  deferredBootMs?: Counters;
  writeCount?: Counters;
  writeP50Ms?: Counters;
  writeP95Ms?: Counters;
};

function writeBucket(ms: number): number {
  let lo = 0;
  let hi = WRITE_BUCKETS_MS.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ms <= WRITE_BUCKETS_MS[mid]) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function percentile(buckets: Uint32Array, count: number, fraction: number) {
  let remaining = Math.ceil(count * fraction);
  for (let i = 0; i < buckets.length; i++) {
    remaining -= buckets[i];
    if (remaining <= 0) return WRITE_BUCKETS_MS[i];
  }
  return WRITE_BUCKETS_MS[WRITE_BUCKETS_MS.length - 1];
}

export class StorageTimingSamples {
  private readonly tables: Set<string>;
  private readonly boot = {
    critical: new Map<string, number>(),
    deferred: new Map<string, number>(),
  };
  private readonly writes = new Map(
    WRITE_KINDS.map((kind) => [
      kind,
      { count: 0, buckets: new Uint32Array(WRITE_BUCKETS_MS.length) },
    ]),
  );

  constructor(schemaTables: readonly string[]) {
    this.tables = new Set(schemaTables.slice(0, MAX_BOOT_TABLES));
  }

  recordBoot(phase: BootPhase, table: string, ms: number): void {
    if (!this.tables.has(table) || !Number.isFinite(ms) || ms < 0) return;
    const durations = this.boot[phase];
    durations.set(table, Math.max(durations.get(table) ?? 0, ms));
  }

  recordWrite(kind: WriteKind, ms: number): void {
    const histogram = this.writes.get(kind);
    if (
      !histogram ||
      histogram.count === MAX_COUNT ||
      !Number.isFinite(ms) ||
      ms < 0
    )
      return;
    histogram.buckets[writeBucket(ms)]++;
    histogram.count++;
  }

  take(): StorageTimingSample {
    const result: StorageTimingSample = {};
    if (this.boot.critical.size)
      result.criticalBootMs = Object.fromEntries(this.boot.critical);
    if (this.boot.deferred.size)
      result.deferredBootMs = Object.fromEntries(this.boot.deferred);
    this.boot.critical.clear();
    this.boot.deferred.clear();
    for (const [kind, histogram] of this.writes) {
      const { count, buckets } = histogram;
      if (!count) continue;
      (result.writeCount ??= {})[kind] = count;
      (result.writeP50Ms ??= {})[kind] = percentile(buckets, count, 0.5);
      (result.writeP95Ms ??= {})[kind] = percentile(buckets, count, 0.95);
      buckets.fill(0);
      histogram.count = 0;
    }
    return result;
  }
}
