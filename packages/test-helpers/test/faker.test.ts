import { expect, test } from "bun:test";
import { testFaker } from "../src/faker";

test("a seed reproduces independent ids and dates relative to a fixed date", () => {
  const first = testFaker("docs.test.ts");
  const second = testFaker("docs.test.ts");
  const other = testFaker("plans.test.ts");

  const id = first.string.uuid();
  expect(id).toBe(second.string.uuid());
  expect(id).not.toBe(other.string.uuid());
  expect(first.date.recent().toISOString()).toBe(
    second.date.recent().toISOString(),
  );
  const recent = first.date.recent();
  expect(recent.getTime()).toBeGreaterThan(Date.UTC(2025, 11, 31));
  expect(recent.getTime()).toBeLessThan(Date.UTC(2026, 0, 1));
});
