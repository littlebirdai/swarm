import { expect, test } from "bun:test";
import { StorageTimingSamples } from "./timing-samples";

test("reports nearest-rank bucket percentiles and counts per write kind", () => {
  const samples = new StorageTimingSamples([]);
  for (let i = 0; i < 10; i++) samples.recordWrite("put", 0.24);
  for (let i = 0; i < 9; i++) samples.recordWrite("put", 183);
  samples.recordWrite("put", 500);
  samples.recordWrite("delete", 0.1);
  expect(samples.take()).toEqual({
    writeCount: { put: 20, delete: 1 },
    writeP50Ms: { put: 0.25, delete: 0.1 },
    writeP95Ms: { put: 192, delete: 0.1 },
  });
});

test("bounds table labels, rejects unknown labels and caps write durations", () => {
  const tables = Array.from({ length: 300 }, (_, i) => `table${i}`);
  const samples = new StorageTimingSamples(tables);
  for (const table of tables) samples.recordBoot("critical", table, 1);
  samples.recordBoot("critical", "someone@example.test", 2);
  samples.recordBoot("deferred", "table0", Infinity);
  samples.recordWrite("put", -1);
  samples.recordWrite("put", NaN);
  samples.recordWrite("put", 1e12);
  const result = samples.take();
  expect(Object.keys(result.criticalBootMs ?? {})).toHaveLength(192);
  expect(result.criticalBootMs).not.toHaveProperty("someone@example.test");
  expect(result.deferredBootMs).toBeUndefined();
  expect(result.writeCount).toEqual({ put: 1 });
  expect(result.writeP95Ms).toEqual({ put: 65536 });
});

test("keeps the longest read per phase and drains the report interval", () => {
  const samples = new StorageTimingSamples(["meta"]);
  samples.recordBoot("critical", "meta", 40);
  samples.recordBoot("critical", "meta", 20);
  samples.recordBoot("deferred", "meta", 0);
  samples.recordWrite("put", 48);
  expect(samples.take()).toMatchObject({
    criticalBootMs: { meta: 40 },
    deferredBootMs: { meta: 0 },
    writeP95Ms: { put: 48 },
  });
  expect(samples.take()).toEqual({});
  samples.recordWrite("put", 0.1);
  expect(samples.take()).toEqual({
    writeCount: { put: 1 },
    writeP50Ms: { put: 0.1 },
    writeP95Ms: { put: 0.1 },
  });
});
