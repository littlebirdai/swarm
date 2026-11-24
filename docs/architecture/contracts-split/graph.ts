import ts from "typescript";
import { readFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = process.argv[2];
const OUT = process.argv[3];
const files = execSync("git ls-files", { cwd: ROOT, maxBuffer: 1 << 28 })
  .toString()
  .split("\n")
  .filter(
    (f) =>
      /\.(ts|tsx|js|mjs|cjs|mts)$/.test(f) &&
      !f.startsWith("platform/") &&
      !f.includes("node_modules/"),
  );

const sharedPkg = JSON.parse(
  readFileSync(join(ROOT, "packages/shared/package.json"), "utf8"),
);
const exportsMap: Record<string, string> = sharedPkg.exports;

const pkgDirs: Record<string, string> = {};
for (const f of files) {
  const m = f.match(/^(packages|apps|tests)\/([^/]+)\/package\.json$/);
}
for (const f of execSync("git ls-files '*package.json'", { cwd: ROOT })
  .toString()
  .split("\n")) {
  if (!f || f.includes("node_modules") || f.startsWith("platform/")) continue;
  try {
    const j = JSON.parse(readFileSync(join(ROOT, f), "utf8"));
    if (j.name?.startsWith("@codecast/")) pkgDirs[j.name] = dirname(f);
  } catch {}
}

function tryFile(p: string): string | null {
  for (const c of [
    p,
    p + ".ts",
    p + ".tsx",
    p + ".js",
    p + "/index.ts",
    p + "/index.tsx",
  ]) {
    if (existsSync(join(ROOT, c)) && statSync(join(ROOT, c)).isFile()) return c;
  }
  return null;
}

type Edge = {
  from: string;
  to: string;
  spec: string;
  names: string[] | "*" | "ns";
  typeOnly: boolean;
  kind: string;
};
const unresolvedShared: string[] = [];

function resolveSpec(from: string, spec: string): string | null {
  if (spec.startsWith(".")) {
    const p = relative(ROOT, resolve(ROOT, dirname(from), spec));
    return tryFile(p.replace(/\.(js|ts)$/, "")) ?? tryFile(p);
  }
  if (spec === "@codecast/shared" || spec.startsWith("@codecast/shared/")) {
    const sub =
      spec === "@codecast/shared"
        ? "."
        : "./" + spec.slice("@codecast/shared/".length);
    const tgt = exportsMap[sub];
    if (tgt) return join("packages/shared", tgt);
    const f = tryFile(join("packages/shared", sub));
    unresolvedShared.push(
      `${from} -> ${spec}${f ? " (on disk, not in exports)" : " (MISSING)"}`,
    );
    return f;
  }
  return null;
}

const edges: Edge[] = [];
for (const f of files) {
  let src: string;
  try {
    src = readFileSync(join(ROOT, f), "utf8");
  } catch {
    continue;
  }
  if (
    !src.includes("@codecast/shared") &&
    !(
      f.startsWith("packages/shared/") &&
      /from\s+['"]\.|import\(['"]\.|require\(['"]\./.test(src)
    ) &&
    !src.includes("mock.module")
  )
    continue;
  const sf = ts.createSourceFile(
    f,
    src,
    ts.ScriptTarget.Latest,
    true,
    f.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const add = (
    spec: string,
    names: Edge["names"],
    typeOnly: boolean,
    kind: string,
  ) => {
    const to = resolveSpec(f, spec);
    if (to) edges.push({ from: f, to, spec, names, typeOnly, kind });
  };
  const visit = (n: ts.Node) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const c = n.importClause;
      let names: Edge["names"] = [];
      let typeOnly = !!c?.isTypeOnly;
      if (!c) names = [];
      else {
        if (c.name) names.push("default");
        if (c.namedBindings) {
          if (ts.isNamespaceImport(c.namedBindings)) names = "ns";
          else {
            const els = c.namedBindings.elements;
            for (const e of els)
              (names as string[]).push((e.propertyName ?? e.name).text);
            if (!typeOnly && els.length && els.every((e) => e.isTypeOnly))
              typeOnly = true;
          }
        }
      }
      add(n.moduleSpecifier.text, names, typeOnly, "import");
    } else if (
      ts.isExportDeclaration(n) &&
      n.moduleSpecifier &&
      ts.isStringLiteral(n.moduleSpecifier)
    ) {
      let names: Edge["names"] = "*";
      if (n.exportClause && ts.isNamedExports(n.exportClause))
        names = n.exportClause.elements.map(
          (e) => (e.propertyName ?? e.name).text,
        );
      else if (n.exportClause) names = "ns";
      add(n.moduleSpecifier.text, names, n.isTypeOnly, "reexport");
    } else if (ts.isCallExpression(n)) {
      const a = n.arguments[0];
      if (a && ts.isStringLiteral(a)) {
        if (n.expression.kind === ts.SyntaxKind.ImportKeyword)
          add(a.text, "ns", false, "dynamic");
        else if (
          ts.isIdentifier(n.expression) &&
          n.expression.text === "require"
        )
          add(a.text, "ns", false, "require");
        else if (
          ts.isPropertyAccessExpression(n.expression) &&
          n.expression.name.text === "module" &&
          ts.isIdentifier(n.expression.expression) &&
          n.expression.expression.text === "mock"
        )
          add(a.text, "ns", false, "mock");
      }
    } else if (
      ts.isImportTypeNode(n) &&
      ts.isLiteralTypeNode(n.argument) &&
      ts.isStringLiteral(n.argument.literal)
    ) {
      add(n.argument.literal.text, "ns", true, "importType");
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

writeFileSync(
  OUT,
  JSON.stringify({ edges, unresolvedShared, pkgDirs }, null, 0),
);
console.log("edges", edges.length, "unresolved", unresolvedShared.length);
