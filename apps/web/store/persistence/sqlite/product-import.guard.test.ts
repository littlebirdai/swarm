import { expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import * as ts from "typescript";

const { preProcessFile } = ts;

const ALLOWED_PRODUCT_IMPORTERS = new Set(["apps/web/store/idb-cache.ts"]);

test("the product imports the SQLite cache engine only through the storage binding", async () => {
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
    if (ALLOWED_PRODUCT_IMPORTERS.has(relative)) continue;
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

test("idb-cache loads SQLite storage dynamically", async () => {
  const root = resolve(import.meta.dir, "../../../../..");
  const idbCachePath = resolve(root, "apps/web/store/idb-cache.ts");
  const source = await Bun.file(idbCachePath).text();
  const sf = ts.createSourceFile(
    idbCachePath,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const staticSqliteImports: string[] = [];
  for (const stmt of sf.statements) {
    if (
      ts.isImportDeclaration(stmt) &&
      ts.isStringLiteral(stmt.moduleSpecifier) &&
      stmt.moduleSpecifier.text.includes("sqlite")
    ) {
      staticSqliteImports.push(stmt.moduleSpecifier.text);
    }
  }
  expect(staticSqliteImports).toEqual([]);
  expect(source).not.toContain("VITE_SQLITE_CACHE");
  expect(source).toContain('import("./persistence/sqlite/storage")');
});

test("no SQLite cache flag or Dexie collection stores remain", async () => {
  const root = resolve(import.meta.dir, "../../../../..");
  for (const rel of [
    "apps/web/vite.config.ts",
    "apps/web/plugins/precacheScope.ts",
    "apps/web/store/idb-cache.ts",
  ]) {
    const content = await Bun.file(resolve(root, rel)).text();
    expect(content).not.toContain("VITE_SQLITE_CACHE");
  }
  const { db } = await import("../db");
  expect(db.tables.map((table) => table.name).sort()).toEqual([
    "dispatchOutbox",
    "meta",
    "pendingEntries",
  ]);
});
