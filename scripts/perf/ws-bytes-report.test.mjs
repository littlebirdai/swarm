import { expect, test } from "bun:test";
import { socketQueryReport } from "./ws-bytes-report.mjs";

test("ranks top queries deterministically and preserves unknown read sets", () => {
  const totals = new Map([
    ["z:query", { bytes: 30, frames: 1 }],
    ["syncLog:getRange", { bytes: 40, frames: 2 }],
    ["a:query", { bytes: 30, frames: 3 }],
    ["empty:query", { bytes: 20, frames: 1 }],
  ]);
  const sets = {
    "syncLog:getRange": ["sync_outbox", "sync_actions", "sync_outbox"],
  };
  expect(socketQueryReport(totals, sets, 2)).toEqual([
    {
      query: "syncLog:getRange",
      bytes: 40,
      updates: 2,
      readSet: ["sync_actions", "sync_outbox"],
    },
    { query: "a:query", bytes: 30, updates: 3, readSet: null },
  ]);
});
