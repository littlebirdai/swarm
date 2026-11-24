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

export function duplicateKeys(text: string): string[] {
  const found: string[] = [];
  const scopes: Array<Set<string> | null> = [];
  let expectKey = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const value = text.slice(i + 1, j);
      const scope = scopes.at(-1);
      if (expectKey && scope) {
        if (scope.has(value)) found.push(value);
        scope.add(value);
        expectKey = false;
      }
      i = j;
    } else if (ch === "{") {
      scopes.push(new Set());
      expectKey = true;
    } else if (ch === "[") {
      scopes.push(null);
    } else if (ch === "}" || ch === "]") {
      scopes.pop();
    } else if (ch === ",") {
      expectKey = scopes.at(-1) instanceof Set;
    }
  }
  return found;
}

function manifests(): string[] {
  return ["apps", "packages", "tests"]
    .flatMap((group) => workspaceDirectories(ROOT, group))
    .map((dir) => join(dir, "package.json"))
    .filter((manifest) => existsSync(join(ROOT, manifest)));
}

function deadExports(): string[] {
  const dead: string[] = [];
  for (const manifest of manifests()) {
    const dir = join(manifest, "..");
    const { exports } = JSON.parse(readFileSync(join(ROOT, manifest), "utf8"));
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

test("no workspace manifest repeats a key", () => {
  const repeated = manifests().flatMap((manifest) =>
    duplicateKeys(readFileSync(join(ROOT, manifest), "utf8")).map(
      (key) => `${manifest}: ${key}`,
    ),
  );
  expect(repeated).toEqual([]);
});

test("a repeated key is found in any object, and string contents are not keys", () => {
  expect(
    duplicateKeys(
      '{"a": 1, "deps": {"x": "1", "y": "{\\"x\\": 2}", "x": "2"}, "list": ["a", "a"], "a": 3}',
    ),
  ).toEqual(["x", "a"]);
  expect(duplicateKeys('{"a": {"b": 1}, "b": 2}')).toEqual([]);
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
