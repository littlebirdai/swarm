import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

function unresolvedImports(file: string, source: string): string[] {
  const unresolved = new Set<string>();
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  function visit(node: ts.Node): void {
    const specifier =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : ts.isCallExpression(node) &&
            (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
              (ts.isIdentifier(node.expression) &&
                node.expression.text === "require"))
          ? node.arguments[0]
          : ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
            ? node.argument.literal
            : undefined;
    if (
      specifier &&
      ts.isStringLiteralLike(specifier) &&
      specifier.text.startsWith("@codecast/")
    ) {
      try {
        Bun.resolveSync(specifier.text, file);
      } catch {
        unresolved.add(specifier.text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return [...unresolved].sort();
}

test("the checker catches an unexported workspace subpath", () => {
  const source = [
    'import type { Route } from "@codecast/browser/browserExtension";',
    'type Missing = import("@codecast/line/src/lineWords").Type;',
    'const alsoMissing = import("@codecast/inbox/src/inboxProjection");',
  ].join("\n");
  expect(unresolvedImports(import.meta.path, source)).toEqual([
    "@codecast/inbox/src/inboxProjection",
    "@codecast/line/src/lineWords",
  ]);
});

test("every workspace import in the web server resolves under Bun", () => {
  const unresolved = readdirSync(import.meta.dir, { recursive: true })
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .flatMap((name) => {
      const file = join(import.meta.dir, name);
      return unresolvedImports(file, readFileSync(file, "utf8")).map(
        (specifier) => `${name}: ${specifier}`,
      );
    });
  expect(unresolved).toEqual([]);
});
