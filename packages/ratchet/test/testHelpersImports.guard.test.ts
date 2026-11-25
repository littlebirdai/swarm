import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import ts from "typescript";
import { walkFiles } from "../src/index";

const ROOT = resolve(import.meta.dir, "../../..");
const PACKAGE = "@codecast/test-helpers";
const EXTENSIONS = [
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
];
const IGNORE = new Set([
  "node_modules",
  "_generated",
  "build",
  "coverage",
  "dist",
  "out",
]);
const TEST_PATH =
  /(?:^|\/)(?:test|tests|__tests__|test-helpers|testkits?)(?:\/)|(?:^|[./_-])(?:test|spec|testkit|test-preload)\.[cm]?[jt]sx?$/;

test("only test code imports the test helpers", () => {
  const offenders: string[] = [];
  for (const file of walkFiles(ROOT, EXTENSIONS, IGNORE)) {
    const path = relative(ROOT, file);
    if (TEST_PATH.test(path)) continue;
    const source = readFileSync(file, "utf8");
    if (!source.includes(PACKAGE)) continue;
    for (const { fileName } of ts.preProcessFile(source, true, true)
      .importedFiles) {
      if (fileName === PACKAGE || fileName.startsWith(`${PACKAGE}/`)) {
        offenders.push(`${path} imports ${fileName}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});
