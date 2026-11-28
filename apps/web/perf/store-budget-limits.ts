import assert from "node:assert/strict";

const limits = {
  "Task list bytes": { measured: 14_661_183, margin: 146_612 },
  "Task comment detail bytes": { measured: 2_161_087, margin: 21_611 },
  "Pull request list bytes": { measured: 897_150, margin: 8_972 },
  "Pull request detail bytes": { measured: 1_349_847, margin: 13_499 },
  "Doc list bytes": { measured: 470_671, margin: 4_707 },
  "Doc detail bytes": { measured: 1_639_891, margin: 16_399 },
  "Session list bytes": { measured: 188_491, margin: 1_885 },
  "Conversation meta bytes": { measured: 380_491, margin: 3_805 },
  "External event list bytes": { measured: 818_001, margin: 8_181 },
  "My sends list bytes": { measured: 3_410_001, margin: 34_101 },
  "Deploy reach bytes": { measured: 70_501, margin: 706 },
  "Run graph bytes": { measured: 20_921, margin: 210 },
  "Deploy detail bytes": { measured: 30_401, margin: 305 },
  "Settings data bytes": { measured: 915, margin: 10 },
  "Cached conversation message JSON bytes": {
    measured: 13_488_375,
    margin: 3_288_841,
  },
  "Cached conversation message rows": { measured: 22_750, margin: 0 },
  "Cached conversation message bytes": {
    measured: 27_910_610,
    margin: 5_643_822,
  },
  "Retained sessions": { measured: 1200, margin: 0 },
  "Retained conversations": { measured: 1200, margin: 0 },
  "Retained docDetails": { measured: 200, margin: 0 },
  "Retained taskComments": { measured: 1500, margin: 0 },
  "Retained pullRequestDetails": { measured: 12, margin: 0 },
  "Retained deployReach": { measured: 300, margin: 0 },
  "Retained runGraphs": { measured: 40, margin: 0 },
  "Retained deployDetails": { measured: 50, margin: 0 },
  "Retained externalEvents": { measured: 2000, margin: 0 },
  "Retained settingsData": { measured: 1, margin: 0 },
  "Retained mySends": { measured: 10000, margin: 0 },
  "First paint IndexedDB tables": { measured: 2, margin: 0 },
  "First paint IndexedDB rows": { measured: 3, margin: 0 },
  "First paint SQLite rows": { measured: 2_823, margin: 0 },
  "Streamed batch row writes": { measured: 4, margin: 0 },
  "Rename action IndexedDB row writes": { measured: 4, margin: 0 },
  "Rename action SQLite row writes": { measured: 2, margin: 0 },
  "Rename action write bytes with pending entries": {
    measured: 1_589,
    margin: 16,
  },
  "Follower populated collections": { measured: 138, margin: 0 },
  "Main window populated collections": { measured: 138, margin: 0 },
  "Palette populated collections": { measured: 39, margin: 0 },
  "People populated collections": { measured: 16, margin: 0 },
  "Call panel populated collections": { measured: 49, margin: 0 },
  "Agent dock populated collections": { measured: 14, margin: 0 },
  "Persisted IndexedDB rows after replay": { measured: 18_185, margin: 0 },
} as const;

export function checkStoreBudget(name: keyof typeof limits, actual: number) {
  const { measured, margin } = limits[name];
  const limit = measured + margin;
  const result = `${name}: ${actual} (baseline ${measured}, limit ${limit})`;
  assert(
    actual > 0 && actual <= limit,
    `${result}\nIf the growth is intended, update apps/web/perf/store-budget-limits.ts and apps/web/perf/README.md.`,
  );
  console.log(`pass  ${result}`);
}
