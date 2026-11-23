import { describe, expect, test } from "bun:test";
import { buildClientResourceReport, estimateCollectionBytes } from "./clientResourceReport";

const window = { platform: "desktop", syncRole: "host", windowRole: "app" } as const;

describe("client resource report", () => {
  test("reports the largest 15 collections and totals every collection", () => {
    const collections = Array.from({ length: 17 }, (_, i) => ({
      key: `collection${i}`,
      count: i + 1,
      estimatedBytes: i * 100,
    }));
    const report = buildClientResourceReport({ ...window, collections });
    expect(report.store_total_rows).toBe(153);
    expect(Object.keys(report.store_collection_rows)).toHaveLength(15);
    expect(Object.entries(report.store_collection_rows)[0]).toEqual(["collection16", 17]);
    expect(report.store_collection_rows).not.toHaveProperty("collection1");
    expect(Object.keys(report.store_collection_estimated_bytes)).toHaveLength(15);
    expect(report.store_collection_estimated_bytes.collection16).toBe(1600);
  });

  test("omits unavailable measurements and preserves observed zeros", () => {
    expect(buildClientResourceReport({ ...window, collections: [] })).toEqual({
      platform: "desktop",
      sync_role: "host",
      window_role: "app",
      store_total_rows: 0,
      store_collection_rows: {},
      store_collection_estimated_bytes: {},
    });
    const report = buildClientResourceReport({
      ...window,
      windowCount: 2,
      memory: { usedJSHeapSize: 1000, totalJSHeapSize: 2000 },
      collections: [{ key: "docs", count: 2 }],
      storage: { usage: 0, quota: 10_000 },
      longFrames: { count: 0, worstMs: 0 },
    });
    expect(report).toMatchObject({
      window_count: 2,
      heap_used_bytes: 1000,
      heap_total_bytes: 2000,
      store_collection_rows: { docs: 2 },
      storage_usage_bytes: 0,
      storage_quota_bytes: 10_000,
      long_frame_count: 0,
      long_frame_worst_ms: 0,
    });
    expect(report.store_collection_estimated_bytes).toEqual({});
  });

  test("estimates from sample lengths and skips oversized row structures", () => {
    const longText = "x".repeat(1_000_000);
    expect(estimateCollectionBytes([longText], 10)).toBe(10_000_020);
    expect(estimateCollectionBytes(["a", "abc"], 4)).toBe(16);
    expect(estimateCollectionBytes([Array(1000).fill(0)], 1)).toBeUndefined();
  });
});
