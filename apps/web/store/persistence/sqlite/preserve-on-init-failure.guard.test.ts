import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import * as ts from "typescript";

const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__") continue;
      collectSourceFiles(full, out);
      continue;
    }
    if (!/\.[cm]?[jt]sx?$/.test(entry)) continue;
    if (/\.(test|spec|bench)\.[cm]?[jt]sx?$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

function isInstallOpfsCall(node: ts.CallExpression): boolean {
  const expr = node.expression;
  if (ts.isIdentifier(expr)) return expr.text === "installOpfsSAHPoolVfs";
  if (ts.isPropertyAccessExpression(expr))
    return expr.name.text === "installOpfsSAHPoolVfs";
  return false;
}

function hasPreserveOnInitFailureTrue(arg: ts.Expression | undefined): boolean {
  if (!arg || !ts.isObjectLiteralExpression(arg)) return false;
  return arg.properties.some((prop) => {
    if (!ts.isPropertyAssignment(prop)) return false;
    const name = ts.isIdentifier(prop.name)
      ? prop.name.text
      : ts.isStringLiteral(prop.name)
        ? prop.name.text
        : null;
    return (
      name === "preserveOnInitFailure" &&
      prop.initializer.kind === ts.SyntaxKind.TrueKeyword
    );
  });
}

function findInvalidCalls(
  sourceText: string,
  fileName: string,
): {
  total: number;
  invalid: number;
} {
  const sf = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  let total = 0;
  let invalid = 0;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && isInstallOpfsCall(node)) {
      total++;
      if (!hasPreserveOnInitFailureTrue(node.arguments[0])) invalid++;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { total, invalid };
}

test("every installOpfsSAHPoolVfs call in apps/web passes an object literal with preserveOnInitFailure: true", () => {
  const webRoot = resolve(import.meta.dir, "../../..");
  const files = collectSourceFiles(webRoot);
  let callCount = 0;
  const invalidFiles: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    if (!source.includes("installOpfsSAHPoolVfs")) continue;
    const result = findInvalidCalls(source, file);
    callCount += result.total;
    if (result.invalid > 0) invalidFiles.push(file);
  }
  expect(invalidFiles).toEqual([]);
  expect(callCount).toBeGreaterThanOrEqual(2);
  expect(
    findInvalidCalls(`sqlite.installOpfsSAHPoolVfs(opts);`, "bad.ts").invalid,
  ).toBe(1);
});
