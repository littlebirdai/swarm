import type { CodecastEventProps } from "@codecast/analytics";

type Report = CodecastEventProps<"client_resource_report">;

export function isClientResourceReportWindow(
  role: Report["window_role"],
): boolean {
  return (
    role === "app" ||
    role === "tab" ||
    role === "people" ||
    role === "call_panel"
  );
}

export function shouldReportClientResources(
  role: Report["window_role"],
  hidden: boolean,
  syncRole: Report["sync_role"],
): boolean {
  return isClientResourceReportWindow(role) && (!hidden || syncRole === "host");
}

export type CollectionSample = {
  key: string;
  count: number;
  estimatedBytes?: number;
};

type ReportInputs = {
  platform: Report["platform"];
  syncRole: Report["sync_role"];
  windowRole: Report["window_role"];
  windowCount?: number;
  memory?: { usedJSHeapSize: number; totalJSHeapSize: number };
  collections: readonly CollectionSample[];
  storage?: { usage?: number; quota?: number };
  longFrames?: { count: number; worstMs: number };
};

export function buildClientResourceReport(input: ReportInputs): Report {
  const top = input.collections
    .filter(({ count }) => count > 0)
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, 15);
  return {
    platform: input.platform,
    sync_role: input.syncRole,
    window_role: input.windowRole,
    ...(input.windowCount === undefined
      ? {}
      : { window_count: input.windowCount }),
    ...(input.memory && {
      heap_used_bytes: input.memory.usedJSHeapSize,
      heap_total_bytes: input.memory.totalJSHeapSize,
    }),
    store_total_rows: input.collections.reduce(
      (total, { count }) => total + count,
      0,
    ),
    store_collection_rows: Object.fromEntries(
      top.map(({ key, count }) => [key, count]),
    ),
    store_collection_estimated_bytes: Object.fromEntries(
      top.flatMap(({ key, estimatedBytes }) =>
        estimatedBytes === undefined ? [] : [[key, estimatedBytes]],
      ),
    ),
    ...(input.storage?.usage === undefined
      ? {}
      : { storage_usage_bytes: input.storage.usage }),
    ...(input.storage?.quota === undefined
      ? {}
      : { storage_quota_bytes: input.storage.quota }),
    ...(input.longFrames && {
      long_frame_count: input.longFrames.count,
      long_frame_worst_ms: input.longFrames.worstMs,
    }),
  };
}

/** Estimate serialized size without copying message bodies or walking large rows in full. */
export function estimateCollectionBytes(
  rows: readonly unknown[],
  count: number,
): number | undefined {
  let budget: number;
  function size(value: unknown): number {
    if (--budget < 0) throw new RangeError();
    if (typeof value === "string") return value.length + 2;
    if (typeof value !== "object" || value === null)
      return String(value).length;
    let bytes = 2;
    if (Array.isArray(value)) {
      for (const item of value) bytes += size(item) + 1;
    } else {
      for (const key in value) {
        if (Object.hasOwn(value, key))
          bytes += key.length + 4 + size(value[key as keyof typeof value]);
      }
    }
    return bytes;
  }

  let sampleBytes = 0;
  let measuredRows = 0;
  for (const row of rows) {
    budget = 1_536;
    try {
      sampleBytes += size(row);
      measuredRows++;
    } catch {
      // An oversized row leaves the other samples available for the estimate.
    }
  }
  return measuredRows
    ? Math.round((sampleBytes / measuredRows) * count)
    : undefined;
}
