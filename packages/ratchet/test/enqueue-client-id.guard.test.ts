import { expect, test } from "bun:test";
import { join } from "node:path";
import ts from "typescript";

const convexDir = join(import.meta.dir, "../../../apps/server/convex");
const legacySites: Readonly<Record<string, number>> = {
  "anchors.ts:provisionStandingAgent": 2,
  "cloud.ts:placeConversation": 1,
  "subagentFleet.ts:recordMergeBack": 1,
  "subagentFleet.ts:startSpawnedSession": 1,
  "tasks.ts:spawnSessionForTask": 1,
};

function enclosingName(node: ts.Node): string {
  let ancestor: ts.Node | undefined = node.parent;
  while (ancestor) {
    if (ts.isFunctionDeclaration(ancestor) && ancestor.name)
      return ancestor.name.text;
    if (ts.isVariableDeclaration(ancestor) && ts.isIdentifier(ancestor.name))
      return ancestor.name.text;
    ancestor = ancestor.parent;
  }
  return "<module>";
}

test("new Convex enqueue callers provide an explicit client_id", async () => {
  const remaining = new Map(Object.entries(legacySites));
  const missing: string[] = [];
  for (const path of new Bun.Glob("**/*.ts").scanSync({ cwd: convexDir })) {
    if (path.includes(".test.") || path.includes(".testkit.")) continue;
    const text = await Bun.file(join(convexDir, path)).text();
    if (!text.includes("enqueuePendingMessage")) continue;
    const source = ts.createSourceFile(
      path,
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    const names = new Set(["enqueuePendingMessage"]);
    for (const node of source.statements) {
      if (!ts.isImportDeclaration(node)) continue;
      const bindings = node.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      for (const binding of bindings.elements) {
        if (binding.propertyName?.text === "enqueuePendingMessage")
          names.add(binding.name.text);
      }
    }
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const enqueue =
          (ts.isIdentifier(callee) && names.has(callee.text)) ||
          (ts.isPropertyAccessExpression(callee) &&
            callee.name.text === "enqueuePendingMessage");
        if (enqueue) {
          const options = node.arguments[3];
          const clientId =
            options &&
            ts.isObjectLiteralExpression(options) &&
            options.properties.some((prop) => {
              if (
                prop.name?.getText(source).replace(/['"]/g, "") !== "client_id"
              )
                return false;
              return !(
                ts.isPropertyAssignment(prop) &&
                ["undefined", "null"].includes(prop.initializer.getText(source))
              );
            });
          if (!clientId) {
            const site = `${path}:${enclosingName(node)}`;
            const allowed = remaining.get(site) ?? 0;
            if (allowed > 0) remaining.set(site, allowed - 1);
            else {
              const { line } = source.getLineAndCharacterOfPosition(
                node.getStart(source),
              );
              missing.push(`${path}:${line + 1}`);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(missing.sort()).toEqual([]);
});
