import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLibraryResolver,
  workspaceDirectories,
} from "../workspace-packages";
import { packageTestDirectories, testFiles } from "./package-tests";

test("discovers library manifests and tests in new directories", () => {
  const root = mkdtempSync(join(tmpdir(), "workspace-libraries-"));
  try {
    const lib = join(root, "packages", "directory-name");
    const testFile = join(lib, "test", "example_spec.ts");
    const legacy = join(root, "packages", "legacy");
    mkdirSync(join(lib, "test"), { recursive: true });
    mkdirSync(legacy);
    writeFileSync(testFile, "");
    writeFileSync(
      join(lib, "package.json"),
      JSON.stringify({
        name: "@codecast/example",
        exports: {
          ".": { types: "./src/root.d.ts", import: "./src/root.ts" },
          "./tools/*": "./src/tools/*.ts",
        },
      }),
    );
    writeFileSync(
      join(legacy, "package.json"),
      JSON.stringify({ name: "@codecast/legacy", main: "./src/main.ts" }),
    );
    const resolveLibrary = createLibraryResolver(root);
    expect(workspaceDirectories(root, "packages")).toEqual([
      "packages/directory-name",
      "packages/legacy",
    ]);
    expect(packageTestDirectories(root)).toEqual(["packages/directory-name"]);
    expect(testFiles(lib)).toEqual([testFile]);
    expect(resolveLibrary("@codecast/example")).toBe(join(lib, "src/root.ts"));
    expect(resolveLibrary("@codecast/example/tools/load")).toBe(
      join(lib, "src/tools/load.ts"),
    );
    expect(resolveLibrary("@codecast/example/private")).toBeNull();
    expect(resolveLibrary("@codecast/directory-name")).toBeNull();
    expect(resolveLibrary("@codecast/legacy")).toBe(
      join(legacy, "src/main.ts"),
    );
  } finally {
    rmSync(root, { recursive: true });
  }
});
