import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { workspaceDirectories } from "../../../scripts/workspace-packages";
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
const IGNORE = new Set(["node_modules", "_generated"]);
const TEST_PATH =
  /(?:^|\/)(?:test|tests|__tests__|test-helpers|testkits?)\/|\.(?:test|spec|testkit)\.[cm]?[jt]sx?$/;
const MENTION = /@codecast\/test-helpers|packages\/test-helpers/;

test("production source never names the test helpers", () => {
  const offenders = walkFiles(ROOT, EXTENSIONS, IGNORE)
    .map((file) => [relative(ROOT, file), file] as const)
    .filter(
      ([path, file]) =>
        !TEST_PATH.test(path) && MENTION.test(readFileSync(file, "utf8")),
    )
    .map(([path]) => path);
  expect(offenders).toEqual([]);
});

test("workspaces list the test helpers only as a development dependency", () => {
  const offenders = workspaceDirectories(ROOT, "apps")
    .concat(workspaceDirectories(ROOT, "packages"))
    .filter((dir) => existsSync(join(ROOT, dir, "package.json")))
    .filter((dir) => {
      const manifest = JSON.parse(
        readFileSync(join(ROOT, dir, "package.json"), "utf8"),
      );
      return ["dependencies", "peerDependencies", "optionalDependencies"].some(
        (group) => manifest[group]?.[PACKAGE],
      );
    });
  expect(offenders).toEqual([]);
});
