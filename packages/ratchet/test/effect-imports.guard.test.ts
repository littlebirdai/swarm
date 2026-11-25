import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import ts from "typescript";
import {
  effectZone,
  isEffectModule,
} from "../../../scripts/lib/effect-zone.mjs";

const root = resolve(import.meta.dir, "../../..");
const effectKit = join(root, "packages/effect-kit/package.json");
function visit(node: ts.Node, callback: (node: ts.Node) => void): void {
  callback(node);
  ts.forEachChild(node, (child) => visit(child, callback));
}

function modulePath(node: ts.Node): ts.StringLiteralLike | undefined {
  let argument: ts.Node | undefined;
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    argument = node.moduleSpecifier;
  } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
    argument = node.argument.literal;
  } else if (ts.isExternalModuleReference(node)) {
    argument = node.expression;
  } else if (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword
  ) {
    argument = node.arguments[0];
  }
  return argument && ts.isStringLiteralLike(argument) ? argument : undefined;
}

function violations(sources: Map<string, ts.SourceFile>): string[] {
  const options: ts.CompilerOptions = {
    allowJs: true,
    noLib: true,
    types: [],
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  };
  const host = ts.createCompilerHost(options);
  const readSource = host.getSourceFile.bind(host);
  host.getSourceFile = (file, ...args) =>
    sources.get(file) ?? readSource(file, ...args);
  host.resolveModuleNames = (names, file) =>
    names.map((name) => {
      if (!sources.has(file)) {
        return ts.resolveModuleName(name, file, options, host).resolvedModule;
      }
      return isEffectModule(name)
        ? ts.resolveModuleName(name, effectKit, options, host).resolvedModule
        : undefined;
    });
  const checker = ts
    .createProgram([...sources.keys()], options, host)
    .getTypeChecker();
  const offenders: string[] = [];

  for (const source of sources.values()) {
    const path = source.fileName.slice(root.length + 1);
    const namespaces = new Map<ts.Symbol, ts.StringLiteralLike>();
    const report = (node: ts.Node, message: string) => {
      const { line } = source.getLineAndCharacterOfPosition(
        node.getStart(source),
      );
      offenders.push(`${path}:${line + 1} ${message}`);
    };
    const checkExport = (
      node: ts.Node,
      module: ts.StringLiteralLike,
      exportName: string,
    ) => {
      const moduleSymbol = checker.getSymbolAtLocation(module);
      const symbol =
        moduleSymbol &&
        checker
          .getExportsOfModule(moduleSymbol)
          .find((entry) => entry.name === exportName);
      const stability = (entry: ts.Symbol) =>
        entry
          .getJsDocTags(checker)
          .filter(({ name }) => name === "stability")
          .map(({ text }) =>
            text
              ?.map((part) => part.text)
              .join("")
              .trim(),
          );
      const tags = symbol ? stability(symbol) : [];
      if (tags.length === 0 && symbol && symbol.flags & ts.SymbolFlags.Alias) {
        tags.push(...stability(checker.getAliasedSymbol(symbol)));
      }
      if (tags.length === 0 || tags.some((tag) => tag !== "stable")) {
        report(
          node,
          `${module.text} export ${exportName} lacks @stability stable`,
        );
      }
    };

    visit(source, (node) => {
      const module = modulePath(node);
      if (!module) return;
      const name = module.text;
      if (!isEffectModule(name)) return;

      if (ts.isImportDeclaration(node) && node.importClause) {
        const { name: defaultImport, namedBindings } = node.importClause;
        if (defaultImport) checkExport(defaultImport, module, "default");
        if (namedBindings && ts.isNamespaceImport(namedBindings)) {
          const symbol = checker.getSymbolAtLocation(namedBindings.name);
          if (symbol) namespaces.set(symbol, module);
        } else {
          for (const specifier of namedBindings?.elements ?? []) {
            checkExport(
              specifier,
              module,
              (specifier.propertyName ?? specifier.name).text,
            );
          }
        }
      } else if (
        ts.isExportDeclaration(node) &&
        node.exportClause &&
        ts.isNamedExports(node.exportClause)
      ) {
        for (const specifier of node.exportClause.elements) {
          checkExport(
            specifier,
            module,
            (specifier.propertyName ?? specifier.name).text,
          );
        }
      } else if (ts.isImportTypeNode(node) && node.qualifier) {
        let qualifier = node.qualifier;
        while (ts.isQualifiedName(qualifier)) qualifier = qualifier.left;
        checkExport(qualifier, module, qualifier.text);
      } else {
        report(
          node,
          `name the exports used from ${name} so their stability can be checked`,
        );
      }
    });

    if (namespaces.size === 0) continue;
    visit(source, (node) => {
      if (!ts.isIdentifier(node) || ts.isNamespaceImport(node.parent)) return;
      const parent = node.parent;
      const symbol =
        ts.isExportSpecifier(parent) &&
        (parent.propertyName ?? parent.name) === node
          ? checker.getExportSpecifierLocalTargetSymbol(parent)
          : ts.isShorthandPropertyAssignment(parent)
            ? checker.getShorthandAssignmentValueSymbol(parent)
            : checker.getSymbolAtLocation(node);
      const module = symbol && namespaces.get(symbol);
      if (!module) return;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
        checkExport(parent, module, parent.name.text);
      } else if (ts.isQualifiedName(parent) && parent.left === node) {
        checkExport(parent, module, parent.right.text);
      } else if (
        ts.isElementAccessExpression(parent) &&
        parent.expression === node &&
        ts.isStringLiteralLike(parent.argumentExpression)
      ) {
        checkExport(parent, module, parent.argumentExpression.text);
      } else {
        report(
          node,
          `name the exports used from ${module.text} so their stability can be checked`,
        );
      }
    });
  }
  return offenders;
}

function parse(path: string, source: string): ts.SourceFile {
  return ts.createSourceFile(
    join(root, path),
    source,
    ts.ScriptTarget.Latest,
    true,
  );
}

test("Effect-zone source uses only stable Effect exports", async () => {
  const git = Bun.spawn(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, stdout: "pipe" },
  );
  const files = (await new Response(git.stdout).text()).split("\0");
  expect(await git.exited).toBe(0);
  const sources = new Map<string, ts.SourceFile>();
  for (const path of files) {
    if (!effectZone.test(path) || !/\.[cm]?[jt]sx?$/.test(path)) continue;
    const file = Bun.file(join(root, path));
    if (!(await file.exists())) continue;
    const text = await file.text();
    if (!/effect|\\[xu]/.test(text)) continue;
    const source = parse(path, text);
    visit(source, (node) => {
      const module = modulePath(node)?.text;
      if (module && isEffectModule(module)) {
        sources.set(source.fileName, source);
      }
    });
  }
  expect(violations(sources)).toEqual([]);
}, 15_000);

test("Effect import rules reject banned source and accept stable exports", () => {
  const samples = [
    [
      "packages/delivery/src/named.ts",
      'import { toFile as save } from "effect/Logger";',
    ],
    [
      "packages/delivery/src/namespace.ts",
      'import * as E from "effect/Effect"; E["withExecutionPlan"];',
    ],
    [
      "packages/delivery/src/reexport.ts",
      'import * as E from "effect/Effect"; export { E };',
    ],
    [
      "packages/delivery/src/spread.ts",
      'import * as E from "effect/Effect"; const options = { ...E };',
    ],
    [
      "packages/delivery/src/stable.ts",
      'import * as E from "effect/Effect"; E.sleep; type T = E.Effect<void>; import { catch as recover } from "effect/Effect";',
    ],
    [
      "packages/delivery/src/stable-type.ts",
      'type T = import("effect/Effect").Effect<void>;',
    ],
    [
      "apps/relay/src/stable.ts",
      'import { adjust } from "effect/testing/TestClock"; import "@codecast/effect-kit/effect";',
    ],
  ].map(([path, text]) => parse(path, text));

  expect(
    violations(new Map(samples.map((source) => [source.fileName, source]))),
  ).toEqual([
    "packages/delivery/src/named.ts:1 effect/Logger export toFile lacks @stability stable",
    "packages/delivery/src/namespace.ts:1 effect/Effect export withExecutionPlan lacks @stability stable",
    "packages/delivery/src/reexport.ts:1 name the exports used from effect/Effect so their stability can be checked",
    "packages/delivery/src/spread.ts:1 name the exports used from effect/Effect so their stability can be checked",
  ]);
});
