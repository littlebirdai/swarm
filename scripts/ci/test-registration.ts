import ts from "typescript";

const TEST_NAMES = new Set(["test", "it", "specify"]);
const TEST_MODULES = new Set(["bun:test", "node:test"]);
const TEST_MODIFIERS = new Set(["only", "concurrent", "serial"]);
const TEST_FACTORIES = new Set(["each", "if", "skipIf", "runIf"]);
const REGISTRATION_HELPERS = new Set(["cliTest", "granted"]);
const LOCAL_TEST_WRAPPERS = new Set([
  "apps/cli/src/browser/defaultBrowser.test.ts",
]);

export function registersTest(file: string, text: string): boolean {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const bindings = new Map<ts.Node, Map<string, ts.Expression>>();
  const runners = new Set<string>();
  const namespaces = new Set<string>();
  const effectRunners = new Set<string>();
  const helpers = new Set<string>();

  function collect(node: ts.Node) {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const module = node.moduleSpecifier.text;
      const clause = node.importClause;
      const named = clause?.namedBindings;
      if (TEST_MODULES.has(module)) {
        if (clause?.name) runners.add(clause.name.text);
        if (named && ts.isNamespaceImport(named))
          namespaces.add(named.name.text);
      }
      if (named && ts.isNamedImports(named)) {
        for (const spec of named.elements) {
          const name = spec.propertyName?.text ?? spec.name.text;
          if (TEST_MODULES.has(module) && TEST_NAMES.has(name))
            runners.add(spec.name.text);
          if (REGISTRATION_HELPERS.has(name)) helpers.add(spec.name.text);
          if (
            module === "@codecast/effect-kit/effect/testing" &&
            name === "it" &&
            !clause?.isTypeOnly &&
            !spec.isTypeOnly
          ) {
            effectRunners.add(spec.name.text);
          }
        }
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer
    ) {
      let scope = node.parent;
      while (
        !ts.isBlock(scope) &&
        !ts.isSourceFile(scope) &&
        !ts.isFunctionLike(scope)
      ) {
        scope = scope.parent;
      }
      const local = bindings.get(scope) ?? new Map<string, ts.Expression>();
      local.set(node.name.text, node.initializer);
      bindings.set(scope, local);
      if (
        REGISTRATION_HELPERS.has(node.name.text) ||
        (node.name.text === "test" && LOCAL_TEST_WRAPPERS.has(file))
      ) {
        helpers.add(node.name.text);
      }
    }
    if (
      ts.isFunctionDeclaration(node) &&
      node.name &&
      REGISTRATION_HELPERS.has(node.name.text)
    ) {
      helpers.add(node.name.text);
    }
    ts.forEachChild(node, collect);
  }
  collect(source);

  function isRunner(node: ts.Expression, aliases = new Set<string>()): boolean {
    if (ts.isIdentifier(node)) {
      const name = node.text;
      if (aliases.has(name)) return false;
      let binding: ts.Expression | undefined;
      for (
        let scope: ts.Node | undefined = node.parent;
        scope && !binding;
        scope = scope.parent
      ) {
        binding = bindings.get(scope)?.get(name);
      }
      return binding
        ? isRunner(binding, new Set([...aliases, name]))
        : runners.has(name) || TEST_NAMES.has(name);
    }
    if (ts.isParenthesizedExpression(node))
      return isRunner(node.expression, aliases);
    if (ts.isConditionalExpression(node)) {
      return (
        isRunner(node.whenTrue, aliases) || isRunner(node.whenFalse, aliases)
      );
    }
    if (ts.isPropertyAccessExpression(node)) {
      const member = node.name.text;
      return (
        (ts.isIdentifier(node.expression) &&
          namespaces.has(node.expression.text) &&
          TEST_NAMES.has(member)) ||
        (member === "effect" &&
          ts.isIdentifier(node.expression) &&
          effectRunners.has(node.expression.text)) ||
        (TEST_MODIFIERS.has(member) && isRunner(node.expression, aliases))
      );
    }
    if (!ts.isCallExpression(node)) return false;
    if (
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require"
    ) {
      const module = node.arguments[0];
      return (
        !!module && ts.isStringLiteral(module) && TEST_MODULES.has(module.text)
      );
    }
    if (!ts.isPropertyAccessExpression(node.expression)) return false;
    const factory = node.expression.name.text;
    const condition = node.arguments[0]?.kind;
    if (
      (factory === "if" || factory === "runIf") &&
      condition === ts.SyntaxKind.FalseKeyword
    )
      return false;
    if (factory === "skipIf" && condition === ts.SyntaxKind.TrueKeyword)
      return false;
    return (
      TEST_FACTORIES.has(factory) &&
      isRunner(node.expression.expression, aliases)
    );
  }

  function containsTest(node: ts.Node): boolean {
    if (
      ts.isIfStatement(node) &&
      node.expression.kind === ts.SyntaxKind.FalseKeyword
    ) {
      return node.elseStatement ? containsTest(node.elseStatement) : false;
    }
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node))
      return false;
    if (
      (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
      ts.isVariableDeclaration(node.parent)
    ) {
      return false;
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (
        ts.isPropertyAccessExpression(callee) &&
        ["skip", "todo"].includes(callee.name.text)
      ) {
        return false;
      }
      if (
        (!ts.isCallExpression(callee) ||
          !ts.isIdentifier(callee.expression) ||
          callee.expression.text !== "require") &&
        (isRunner(callee) ||
          (ts.isIdentifier(callee) && helpers.has(callee.text)))
      ) {
        return true;
      }
    }
    return ts.forEachChild(node, containsTest) ?? false;
  }
  return containsTest(source);
}
