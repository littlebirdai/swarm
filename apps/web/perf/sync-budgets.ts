import assert from "node:assert/strict";
import { runLocalProbe } from "../scripts/sync-probe";

const responseLimits = {
  "syncLog:getHeads": 96,
  "syncLog:getRange": 480,
} as const;

const sampleCount = 4;
const { reads } = await runLocalProbe(sampleCount, 5000);
assert.equal(reads.length, sampleCount);
for (const [sample, queries] of reads.entries()) {
  assert.deepEqual(
    queries.map(({ name }) => name),
    Object.keys(responseLimits),
    `Unexpected queries for edit ${sample + 1}`,
  );
  for (const [index, limit] of Object.values(responseLimits).entries()) {
    const { name, responseBytes } = queries[index];
    assert(
      responseBytes > 0 && responseBytes <= limit,
      `Edit ${sample + 1} response from ${name}: ${responseBytes} bytes (limit ${limit})`,
    );
  }
}
console.log(
  `pass  Sync delivery queries and response bytes (${sampleCount} edits)`,
);
