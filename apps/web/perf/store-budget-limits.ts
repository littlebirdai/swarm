import assert from "node:assert/strict";

const limits = {
  "Task list bytes": { measured: 14_661_183, margin: 146_612 },
  "Pull request list bytes": { measured: 897_150, margin: 8_972 },
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
  "First paint read groups": { measured: 21, margin: 0 },
  "First paint IndexedDB tables": { measured: 20, margin: 0 },
  "First paint IndexedDB rows": { measured: 2_822, margin: 0 },
  "Streamed batch row writes": { measured: 4, margin: 0 },
  "Rename action row writes": { measured: 4, margin: 0 },
  "Follower populated collections": { measured: 138, margin: 0 },
} as const;

export function checkStoreBudget(name: keyof typeof limits, actual: number) {
  const { measured, margin } = limits[name];
  const limit = measured + margin;
  const result = `${name}: ${actual} (baseline ${measured}, limit ${limit})`;
  assert(actual > 0 && actual <= limit, result);
  console.log(`pass  ${result}`);
}
