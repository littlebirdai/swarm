import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { workspaceDirectories } from "../workspace-packages";

const ROOT = join(import.meta.dir, "..", "..");

type Target = string | null | { [condition: string]: Target };

function targets(value: Target | undefined): string[] {
  if (typeof value === "string") return [value];
  if (!value) return [];
  return Object.values(value).flatMap(targets);
}

function exportTargets(exports: unknown): Array<[string, string]> {
  if (typeof exports === "string") return [[".", exports]];
  if (!exports || typeof exports !== "object") return [];
  const entries = Object.entries(exports as Record<string, Target>);
  if (entries.every(([key]) => !key.startsWith(".")))
    return targets(exports as Target).map((target) => [".", target]);
  return entries.flatMap(([key, value]) =>
    targets(value).map((target): [string, string] => [key, target]),
  );
}

function deadExports(): string[] {
  const dead: string[] = [];
  for (const dir of ["apps", "packages", "tests"].flatMap((group) =>
    workspaceDirectories(ROOT, group),
  )) {
    const manifest = join(ROOT, dir, "package.json");
    if (!existsSync(manifest)) continue;
    const { exports } = JSON.parse(readFileSync(manifest, "utf8"));
    for (const [key, target] of exportTargets(exports)) {
      if (target.includes("*")) continue;
      if (!existsSync(join(ROOT, dir, target)))
        dead.push(`${dir}/package.json: ${key} -> ${target}`);
    }
  }
  return dead;
}

test("every workspace export names a file that exists", () => {
  expect(deadExports()).toEqual([]);
});

test("export targets are read from strings and condition objects", () => {
  expect(
    exportTargets({
      ".": "./src/index.ts",
      "./a": { import: "./src/a.ts", types: "./src/a.d.ts" },
    }),
  ).toEqual([
    [".", "./src/index.ts"],
    ["./a", "./src/a.ts"],
    ["./a", "./src/a.d.ts"],
  ]);
  expect(exportTargets("./index.ts")).toEqual([[".", "./index.ts"]]);
  expect(exportTargets({ import: "./i.ts" })).toEqual([[".", "./i.ts"]]);
});
