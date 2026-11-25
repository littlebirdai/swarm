import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { walkFiles } from "../src/index";

const ROOT = resolve(import.meta.dir, "../../..");
const BASELINE = join(import.meta.dir, "../module-mocks-baseline.txt");
const IGNORE = new Set(["node_modules", "dist", "platform", "ios", "android"]);
const CALL = /\bmock\s*\.\s*module\s*\(/g;
const PRUNE = process.env.RATCHET_PRUNE === "1";

function counts(): Map<string, number> {
  const found = new Map<string, number>();
  for (const root of ["apps", "packages"])
    for (const file of walkFiles(
      join(ROOT, root),
      [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
      IGNORE,
    )) {
      if (file === import.meta.path) continue;
      const calls = readFileSync(file, "utf8").match(CALL)?.length ?? 0;
      if (calls > 0) found.set(relative(ROOT, file), calls);
    }
  return found;
}

function baseline(): Map<string, number> {
  return new Map(
    readFileSync(BASELINE, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const at = line.lastIndexOf(" ");
        return [line.slice(0, at), Number(line.slice(at + 1))];
      }),
  );
}

export function problems(
  found: Map<string, number>,
  allowed: Map<string, number>,
): string[] {
  const out: string[] = [];
  for (const [file, calls] of found) {
    const limit = allowed.get(file) ?? 0;
    if (calls > limit)
      out.push(
        `${file}: ${calls} module mocks, ${limit} allowed. Use the mount harness or a shared fake.`,
      );
  }
  for (const [file, limit] of allowed) {
    const calls = found.get(file) ?? 0;
    if (calls < limit)
      out.push(
        `${file}: ${calls} module mocks, the baseline says ${limit}. Run this test with RATCHET_PRUNE=1.`,
      );
  }
  return out.toSorted();
}

test("the number of module mocks in each file only goes down", () => {
  const found = counts();
  const allowed = baseline();
  if (PRUNE) {
    const pruned = [...allowed]
      .map(([file, limit]): [string, number] => [
        file,
        Math.min(limit, found.get(file) ?? 0),
      ])
      .filter(([, limit]) => limit > 0);
    writeFileSync(
      BASELINE,
      pruned.map(([file, limit]) => `${file} ${limit}\n`).join(""),
    );
    expect(problems(found, new Map(pruned))).toEqual([]);
    return;
  }
  expect(problems(found, allowed)).toEqual([]);
});

const cases: Array<[Array<[string, number]>, Array<[string, number]>, number]> =
  [
    [[["new.test.ts", 1]], [], 1],
    [[["a.test.ts", 3]], [["a.test.ts", 2]], 1],
    [[["a.test.ts", 1]], [["a.test.ts", 2]], 1],
    [[], [["gone.test.ts", 2]], 1],
    [[["a.test.ts", 2]], [["a.test.ts", 2]], 0],
  ];
test.each(cases)(
  "reports a rise, a new file and a stale entry",
  (found, allowed, total) => {
    expect(problems(new Map(found), new Map(allowed))).toHaveLength(total);
  },
);
