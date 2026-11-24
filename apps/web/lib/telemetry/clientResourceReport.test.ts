import { describe, expect, test } from "bun:test";
import { buildClientResourceReport, estimateCollectionBytes, shouldReportClientResources } from "./clientResourceReport";

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

  test("estimates a collection from three rows of 100 fields each", () => {
    const row = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`field${i}`, Array(6).fill("x")]));
    expect(estimateCollectionBytes([row, row, row], 1000)).toBe(3_692_000);
  });

  test("uses complete samples when another row exceeds the traversal budget", () => {
    const oversized = Array(3000).fill(0);
    expect(estimateCollectionBytes(["a", oversized, "abc"], 4)).toBe(16);
    expect(estimateCollectionBytes([oversized], 1)).toBeUndefined();
  });

  test("reports from visible app windows or the sync host, and excludes overlays and the palette", () => {
    expect(shouldReportClientResources("app", true, "host")).toBe(true);
    expect(shouldReportClientResources("tab", true, "follower")).toBe(false);
    expect(shouldReportClientResources("tab", false, "follower")).toBe(true);
    expect(shouldReportClientResources("people", false, "follower")).toBe(true);
    expect(shouldReportClientResources("call_panel", false, "follower")).toBe(true);
    expect(shouldReportClientResources("auxiliary", false, "host")).toBe(false);
    expect(shouldReportClientResources("palette", false, "follower")).toBe(false);
  });
});
