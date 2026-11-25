import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { walkFiles } from "@codecast/ratchet";

const ROOT = join(import.meta.dir, "../..");

test("every suite that uses the mount harness is in its typecheck program", () => {
  const program = JSON.parse(
    readFileSync(join(ROOT, "tsconfig.mount.json"), "utf8"),
  ) as { files: string[] };
  const users = walkFiles(
    ROOT,
    [".test.ts", ".test.tsx"],
    new Set(["node_modules", "dist"]),
  )
    .map((file) => [relative(ROOT, file), file] as const)
    .filter(
      ([path, file]) =>
        !path.startsWith("test-helpers/") &&
        /test-helpers\/mountWeb["']/.test(readFileSync(file, "utf8")),
    )
    .map(([path]) => path);
  expect(program.files.toSorted()).toEqual(users.toSorted());
});
