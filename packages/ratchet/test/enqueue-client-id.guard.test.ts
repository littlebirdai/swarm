import { expect, test } from "bun:test";
import { join } from "node:path";
import ts from "typescript";

const convexDir = join(import.meta.dir, "../../../apps/server/convex");
const legacySites: Readonly<Record<string, number>> = {
  "anchors.ts:provisionStandingAgent": 1,
  "cloud.ts:placeConversation": 1,
  "subagentFleet.ts:startSpawnedSession": 1,
  "tasks.ts:spawnSessionForTask": 1,
};
type Signature = { position: number; positional?: true };
const enqueueFunctions = new Map<string, Signature>([
  ["enqueuePendingMessage", { position: 3 }],
  ["deliverToAnchor", { position: 3, positional: true }],
  ["tellRole", { position: 2 }],
  ["performSessionSend", { position: 2 }],
]);

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

function nameOf(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (
    ts.isElementAccessExpression(node) &&
    ts.isStringLiteral(node.argumentExpression)
  )
    return node.argumentExpression.text;
}

function supplied(node: ts.Expression | undefined): boolean {
  return (
    !!node &&
    node.kind !== ts.SyntaxKind.NullKeyword &&
    !(ts.isIdentifier(node) && node.text === "undefined") &&
    !(ts.isStringLiteralLike(node) && !node.text.trim())
  );
}

function hasClientId(options: ts.Expression | undefined): boolean {
  if (!options || !ts.isObjectLiteralExpression(options)) return false;
  return options.properties.some(
    (prop) =>
      (ts.isPropertyAssignment(prop) &&
        nameOf(prop.name) === "client_id" &&
        supplied(prop.initializer)) ||
      (ts.isShorthandPropertyAssignment(prop) &&
        prop.name.text === "client_id"),
  );
}

function missingIdentities(
  path: string,
  text: string,
): { site: string; line: number }[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const aliases = new Map(enqueueFunctions);
  const deliveryRoutes = new Set(["deliverToSession"]);
  const memberAliases = new Map<string, Signature>([
    ["askAgentDelivery.enqueue", { position: 3 }],
  ]);
  const visit = (node: ts.Node) => {
    if (ts.isImportSpecifier(node) && node.propertyName) {
      const original = node.propertyName.text;
      const signature = aliases.get(original);
      if (signature) aliases.set(node.name.text, signature);
      if (deliveryRoutes.has(original)) deliveryRoutes.add(node.name.text);
      for (const [member, position] of memberAliases)
        if (member.startsWith(node.propertyName.text + "."))
          memberAliases.set(
            node.name.text + member.slice(node.propertyName.text.length),
            position,
          );
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      const init = node.initializer;
      const original = nameOf(init) ?? "";
      if (deliveryRoutes.has(original)) deliveryRoutes.add(node.name.text);
      const alias =
        aliases.get(nameOf(init) ?? "") ??
        memberAliases.get(init.getText(source));
      if (alias !== undefined) aliases.set(node.name.text, alias);
      if (ts.isObjectLiteralExpression(init))
        for (const prop of init.properties) {
          if (!ts.isPropertyAssignment(prop)) continue;
          const argument = aliases.get(nameOf(prop.initializer) ?? "");
          if (argument !== undefined)
            memberAliases.set(
              `${node.name.text}.${nameOf(prop.name)}`,
              argument,
            );
        }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  const missing: { site: string; line: number }[] = [];
  const check = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = nameOf(callee) ?? "";
      const signature =
        aliases.get(name) ?? memberAliases.get(callee.getText(source));
      const scheduled = ["runAfter", "runAt", "runMutation"].includes(name);
      const route = nameOf(
        node.arguments[name === "runMutation" ? 0 : 1] ?? source,
      );
      const argument =
        node.arguments[signature?.position ?? (name === "runMutation" ? 1 : 2)];
      const missingIdentity =
        signature !== undefined
          ? signature.positional
            ? !supplied(argument)
            : !hasClientId(argument)
          : scheduled &&
            route !== undefined &&
            deliveryRoutes.has(route) &&
            !hasClientId(argument);
      if (missingIdentity)
        missing.push({
          site: `${path}:${enclosingName(node)}`,
          line:
            source.getLineAndCharacterOfPosition(node.getStart(source)).line +
            1,
        });
    }
    ts.forEachChild(node, check);
  };
  check(source);
  return missing;
}

test("new Convex enqueue and wrapper callers provide an explicit client ID", async () => {
  const remaining = new Map(Object.entries(legacySites));
  const missing: string[] = [];
  for (const path of new Bun.Glob("**/*.ts").scanSync({ cwd: convexDir })) {
    if (
      path.includes(".test.") ||
      path.includes(".testkit.") ||
      path.startsWith("_generated/")
    )
      continue;
    const text = await Bun.file(join(convexDir, path)).text();
    if (
      !/enqueuePendingMessage|askAgentDelivery|deliverToAnchor|tellRole|performSessionSend|deliverToSession/.test(
        text,
      )
    )
      continue;
    for (const { site, line } of missingIdentities(path, text)) {
      const allowed = remaining.get(site) ?? 0;
      if (!allowed) missing.push(`${site}:${line}`);
      else if (allowed === 1) remaining.delete(site);
      else remaining.set(site, allowed - 1);
    }
  }
  expect(missing.sort()).toEqual([]);
  expect([...remaining.keys()].sort()).toEqual([]);
});
