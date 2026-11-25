import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import {
  effectZone,
  isEffectEntry,
  isEffectModule,
} from "../../../scripts/lib/effect-zone.mjs";

const root = resolve(import.meta.dir, "../../..");
const effectKit = join(root, "packages/effect-kit/package.json");
type Manifest = Record<string, unknown>;

function targets(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(targets);
}

function rootTargets(manifest: Manifest): string[] {
  const { exports, types, typings, main } = manifest;
  if (exports === undefined)
    return targets([types ?? typings, main ?? "index"]);
  if (exports && typeof exports === "object" && !Array.isArray(exports)) {
    const entries = exports as Manifest;
    if (Object.keys(entries).some((key) => key.startsWith("."))) {
      return targets(entries["."]);
    }
  }
  return targets(exports);
}

function manifestRootEntries(dir: string, manifest: Manifest): string[] {
  const listed = rootTargets(manifest);
  if (manifest.exports === undefined && manifest.main === undefined) {
    listed.push(
      ...["index.ts", "index.d.ts", "index.js"].filter((file) =>
        existsSync(join(dir, file)),
      ),
    );
  }
  return listed.flatMap((target) => {
    const file = Bun.resolveSync(resolve(dir, target), root);
    const declaration = file.replace(/\.([cm]?)jsx?$/, ".d.$1ts");
    return declaration !== file && existsSync(declaration)
      ? [file, declaration]
      : [file];
  });
}

function forbiddenDependency(name: string): boolean {
  return name === "effect" || name === "@codecast/effect-kit";
}

function manifestViolations(path: string, manifest: Manifest): string[] {
  if (effectZone.test(path)) return [];
  const violations: string[] = [];
  for (const kind of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
    "bundledDependencies",
    "bundleDependencies",
  ]) {
    const dependencies = manifest[kind];
    if (!dependencies || typeof dependencies !== "object") continue;
    const entries = Array.isArray(dependencies)
      ? dependencies.map((name) => [name, ""])
      : Object.entries(dependencies);
    for (const [name, version] of entries) {
      if (
        forbiddenDependency(name) ||
        (typeof version === "string" &&
          /^npm:(?:effect|@codecast\/effect-kit)(?:@|$)/.test(version))
      ) {
        violations.push(
          `${path} ${kind}: ${name} is restricted to Effect-zone packages`,
        );
      }
    }
  }
  return violations;
}

function rootExposure(entries: string[]): string[] {
  if (!entries.length) return [];
  const options: ts.CompilerOptions = {
    allowJs: true,
    declaration: true,
    emitDeclarationOnly: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    strict: true,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  host.resolveModuleNames = (names, file) =>
    names.map((name) => {
      const resolved = ts.resolveModuleName(
        name,
        file,
        options,
        host,
      ).resolvedModule;
      return (
        resolved ??
        (isEffectModule(name)
          ? ts.resolveModuleName(name, effectKit, options, host).resolvedModule
          : undefined)
      );
    });
  const sourceProgram = ts.createProgram(entries, options, host);
  const declarations = new Map<string, string>();
  const emit = sourceProgram.emit(
    undefined,
    (_path, text, _bom, _error, sources) => {
      for (const source of sources ?? [])
        declarations.set(source.fileName, text);
    },
  );
  if (emit.emitSkipped || emit.diagnostics.length > 0) {
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(emit.diagnostics, host),
    );
  }
  const getSource = host.getSourceFile.bind(host);
  host.getSourceFile = (filename, ...args) => {
    const declaration = declarations.get(filename);
    return declaration === undefined
      ? getSource(filename, ...args)
      : ts.createSourceFile(
          filename,
          declaration,
          args[0],
          true,
          ts.ScriptKind.TS,
        );
  };
  const declarationProgram = ts.createProgram(entries, options, host);
  const checker = declarationProgram.getTypeChecker();
  const offenders: string[] = [];

  function exposesEffect(symbol: ts.Symbol, visited: Set<ts.Symbol>): boolean {
    if (visited.has(symbol)) return false;
    visited.add(symbol);
    return (
      (symbol.declarations ?? []).some((declaration) => {
        const filename = declaration
          .getSourceFile()
          .fileName.replaceAll("\\", "/");
        if (/\/node_modules\/effect\//.test(filename)) return true;
        if (
          declarationProgram.isSourceFileDefaultLibrary(
            declaration.getSourceFile(),
          )
        )
          return false;
        if (
          ts.isSourceFile(declaration) ||
          ts.isModuleDeclaration(declaration)
        ) {
          return checker
            .getExportsOfModule(symbol)
            .some((entry) => exposesEffect(entry, visited));
        }
        return hasEffectReference(declaration, visited);
      }) ||
      Boolean(
        symbol.flags & ts.SymbolFlags.Alias &&
        exposesEffect(checker.getAliasedSymbol(symbol), visited),
      )
    );
  }

  function hasEffectReference(node: ts.Node, visited: Set<ts.Symbol>): boolean {
    if (
      ts.isStringLiteralLike(node) &&
      (ts.isImportDeclaration(node.parent) ||
        ts.isExportDeclaration(node.parent) ||
        (ts.isLiteralTypeNode(node.parent) &&
          ts.isImportTypeNode(node.parent.parent))) &&
      (node.text === "effect" ||
        isEffectModule(node.text) ||
        isEffectEntry(node.text))
    ) {
      return true;
    }
    if (ts.isIdentifier(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol && exposesEffect(symbol, visited)) return true;
    }
    return (
      ts.forEachChild(node, (child) => hasEffectReference(child, visited)) ??
      false
    );
  }

  for (const entry of entries) {
    const source = declarationProgram.getSourceFile(entry);
    const symbol = source && checker.getSymbolAtLocation(source);
    if (!source)
      throw new Error(`Cannot inspect the root declaration at ${entry}`);
    if (!symbol) continue;
    const exports = checker.getExportsOfModule(symbol);
    const commonJs = symbol.exports?.get(ts.InternalSymbolName.ExportEquals);
    for (const exported of commonJs ? [...exports, commonJs] : exports) {
      if (exposesEffect(exported, new Set())) {
        offenders.push(
          `${entry} exports ${exported.name} with an Effect declaration`,
        );
      }
    }
  }
  return offenders;
}

test("manifests and root declarations preserve the Effect boundary", async () => {
  const git = Bun.spawn(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, stdout: "pipe" },
  );
  const files = (await new Response(git.stdout).text()).split("\0");
  expect(await git.exited).toBe(0);
  const entries = new Set<string>();
  const offenders: string[] = [];
  for (const path of files) {
    if (!/(?:^|\/)package\.json$/.test(path)) continue;
    const file = Bun.file(join(root, path));
    if (!(await file.exists())) continue;
    const manifest: Manifest = await file.json();
    offenders.push(...manifestViolations(path, manifest));
    if (!effectZone.test(path)) continue;
    for (const entry of manifestRootEntries(
      dirname(join(root, path)),
      manifest,
    )) {
      entries.add(entry);
    }
  }
  expect(offenders.concat(rootExposure([...entries]))).toEqual([]);
}, 15_000);

test.each([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "bundleDependencies",
  "bundledDependencies",
])("rejects Effect packages in %s outside the zone", (kind) => {
  const manifest = {
    [kind]: kind.startsWith("bundle")
      ? ["effect", "@codecast/effect-kit"]
      : {
          effect: "catalog:",
          "@codecast/effect-kit": "workspace:*",
          disguised: "npm:effect@4.1.5",
        },
  };
  expect(
    manifestViolations("packages/time/package.json", manifest),
  ).toHaveLength(kind.startsWith("bundle") ? 2 : 3);
  expect(manifestViolations("apps/relay/package.json", manifest)).toEqual([]);
});

test("root declarations reject direct and inferred Effect exposure but allow a Promise facade", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "effect-boundary-")));
  try {
    mkdirSync(join(dir, "src"));
    const entry = join(dir, "src/index.ts");
    writeFileSync(
      join(dir, "src/internal.ts"),
      `
      import { sleep, runPromise } from "effect/Effect";
      export const leaked = () => ({ nested: [sleep(0)] });
      export const facade = () => runPromise(sleep(0));
    `,
    );
    writeFileSync(
      entry,
      `
      export { sleep as direct } from "effect/Effect";
      export type { Effect as DirectType } from "effect/Effect";
      export { leaked, facade } from "./internal";
      export interface Options { readonly later: import("effect/Effect").Effect<void> }
    `,
    );
    writeFileSync(
      join(dir, "src/types.d.ts"),
      'export type { Effect as FromDeclaration } from "effect/Effect";',
    );
    const entries = manifestRootEntries(dir, {
      exports: {
        ".": { types: "./src/types.d.ts", default: "./src/index.ts" },
        "./effect": "./src/internal.ts",
      },
    });
    expect(entries).toEqual([join(dir, "src/types.d.ts"), entry]);
    expect(rootExposure(entries).sort()).toEqual(
      ["DirectType", "Options", "direct", "leaked"]
        .map((name) => `${entry} exports ${name} with an Effect declaration`)
        .concat(
          `${join(dir, "src/types.d.ts")} exports FromDeclaration with an Effect declaration`,
        )
        .sort(),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);
