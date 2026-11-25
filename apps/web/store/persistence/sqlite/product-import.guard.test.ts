import { expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { preProcessFile } from "typescript";

test("the product has no imports of the SQLite cache engine", async () => {
  const root = resolve(import.meta.dir, "../../../../..");
  const web = resolve(root, "apps/web");
  const engine = import.meta.dir.toLowerCase();
  const files = Bun.spawnSync(
    [
      "git",
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "apps",
      "packages",
    ],
    { cwd: root },
  );
  expect(files.exitCode).toBe(0);
  const violations: string[] = [];
  for (const relative of new TextDecoder().decode(files.stdout).split("\0")) {
    if (!/\.[cm]?[jt]sx?$/.test(relative)) continue;
    if (
      /\.(test|spec|bench)\.[cm]?[jt]sx?$|\/(?:__tests__|test-helpers|tests?|fixtures|perf)\//.test(
        relative,
      )
    )
      continue;
    const path = resolve(root, relative);
    if (path.toLowerCase().startsWith(engine + "/")) continue;
    const file = Bun.file(path);
    if (!(await file.exists())) continue;
    const source = await file.text();
    if (!/sqlite/i.test(source)) continue;
    for (const { fileName } of preProcessFile(source, true, true)
      .importedFiles) {
      const target = (
        fileName.startsWith("@/")
          ? resolve(web, fileName.slice(2))
          : resolve(dirname(path), fileName)
      ).toLowerCase();
      if (target === engine || target.startsWith(engine + "/"))
        violations.push(relative);
    }
  }
  expect(violations).toEqual([]);
});
