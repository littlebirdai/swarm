import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codeLines } from "../src/codeLines";
import { patchEnv } from "../src/patchEnv";
import { waitFor } from "../src/waitFor";
import { walkSources } from "../src/walkSources";

const dir = mkdtempSync(join(tmpdir(), "test-helpers-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("codeLines drops comment lines and keeps the numbers of the others", () => {
  expect(codeLines("a\n// b\n * c\nd")).toEqual([
    { line: "a", n: 1 },
    { line: "d", n: 4 },
  ]);
});

test("patchEnv restores a changed, an added and a removed variable", () => {
  process.env.TH_CHANGED = "old";
  process.env.TH_REMOVED = "old";
  delete process.env.TH_ADDED;
  const read = (key: string) => process.env[key];
  const restore = patchEnv({
    TH_CHANGED: "new",
    TH_ADDED: "new",
    TH_REMOVED: undefined,
  });
  expect(read("TH_CHANGED")).toBe("new");
  expect(read("TH_ADDED")).toBe("new");
  expect("TH_REMOVED" in process.env).toBe(false);
  restore();
  expect(read("TH_CHANGED")).toBe("old");
  expect("TH_ADDED" in process.env).toBe(false);
  expect(read("TH_REMOVED")).toBe("old");
  delete process.env.TH_CHANGED;
  delete process.env.TH_REMOVED;
});

test("waitFor answers true when the check passes and false after the limit", async () => {
  let calls = 0;
  expect(await waitFor(() => ++calls === 3, 1_000, 1)).toBe(true);
  expect(calls).toBe(3);
  expect(await waitFor(() => false, 5, 1)).toBe(false);
});

test("walkSources finds nested source, and skips tests and skipped folders", () => {
  for (const folder of ["a", "skip"]) mkdirSync(join(dir, folder));
  for (const file of ["a/one.ts", "a/one.test.ts", "skip/two.ts", "three.md"])
    writeFileSync(join(dir, file), "");
  expect(walkSources(dir, new Set(["skip"]))).toEqual([join(dir, "a/one.ts")]);
});
