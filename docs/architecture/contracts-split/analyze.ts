import ts from "/Users/rentamac/swarm/node_modules/typescript/lib/typescript.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.argv[2];
const { edges } = JSON.parse(readFileSync(process.argv[3], "utf8")) as {
  edges: any[];
};
const CORE = [
  "contracts",
  "entities",
  "tasks",
  "render",
  "search",
  "replay",
  "changes",
  "ratchet",
];
const isCore = (f: string) =>
  CORE.some((c) => f.startsWith(`packages/shared/${c}/`));
const isTest = (f: string) =>
  /\.(test|guard\.test|ratchet\.test)\.tsx?$/.test(f) ||
  /\.testkit\.ts$/.test(f) ||
  f.includes("/__fixtures__/") ||
  /\.fixture\.ts$/.test(f);
const mod = (f: string) =>
  f.replace(/^packages\/shared\//, "").replace(/\.(tsx?|js)$/, "");
const area = (f: string) => {
  const m = f.match(/^(apps|packages|tests)\/([^/]+)/);
  if (!m) return f.split("/")[0];
  if (m[1] === "packages" && m[2] === "shared") return "shared";
  return `${m[1]}/${m[2]}`;
};

const coreEdges = edges.filter(
  (e) => isCore(e.from) && isCore(e.to) && !isTest(e.from),
);
const nodes = new Set<string>();
for (const e of edges) {
  if (isCore(e.to) && !isTest(e.to)) nodes.add(mod(e.to));
  if (isCore(e.from) && !isTest(e.from)) nodes.add(mod(e.from));
}
const adj = new Map<string, Set<string>>();
for (const n of nodes) adj.set(n, new Set());
for (const e of coreEdges)
  if (!isTest(e.to)) adj.get(mod(e.from))!.add(mod(e.to));

let idx = 0;
const index = new Map<string, number>(),
  low = new Map<string, number>(),
  on = new Set<string>(),
  st: string[] = [];
const sccs: string[][] = [];
function strong(v: string) {
  index.set(v, idx);
  low.set(v, idx);
  idx++;
  st.push(v);
  on.add(v);
  for (const w of adj.get(v)!) {
    if (!index.has(w)) {
      strong(w);
      low.set(v, Math.min(low.get(v)!, low.get(w)!));
    } else if (on.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
  }
  if (low.get(v) === index.get(v)) {
    const c: string[] = [];
    let w: string;
    do {
      w = st.pop()!;
      on.delete(w);
      c.push(w);
    } while (w !== v);
    if (c.length > 1 || adj.get(v)!.has(v)) sccs.push(c.sort());
  }
}
for (const n of nodes) if (!index.has(n)) strong(n);

const fanIn = new Map<string, Map<string, Set<string>>>();
for (const e of edges) {
  if (!isCore(e.to)) continue;
  const t = mod(e.to);
  if (!fanIn.has(t)) fanIn.set(t, new Map());
  const k = isCore(e.from)
    ? isTest(e.from)
      ? "core-test"
      : "core"
    : area(e.from);
  const m = fanIn.get(t)!;
  if (!m.has(k)) m.set(k, new Set());
  m.get(k)!.add(e.from);
}

function exportOrigins(
  file: string,
  seen = new Set<string>(),
): Map<string, string> {
  const out = new Map<string, string>();
  if (seen.has(file)) return out;
  seen.add(file);
  const src = readFileSync(join(ROOT, file), "utf8");
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  for (const s of sf.statements) {
    if (
      ts.isExportDeclaration(s) &&
      s.moduleSpecifier &&
      ts.isStringLiteral(s.moduleSpecifier)
    ) {
      const e = edges.find(
        (x) =>
          x.from === file &&
          x.spec === (s.moduleSpecifier as ts.StringLiteral).text,
      );
      if (!e) {
        if (s.exportClause && ts.isNamedExports(s.exportClause))
          for (const el of s.exportClause.elements)
            out.set(el.name.text, mod(file));
        continue;
      }
      if (!s.exportClause)
        for (const [k, v] of exportOrigins(e.to, seen)) out.set(k, v);
      else if (ts.isNamedExports(s.exportClause))
        for (const el of s.exportClause.elements)
          out.set(el.name.text, mod(e.to));
    } else {
      const mods = (s as any).modifiers as ts.Modifier[] | undefined;
      if (mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
        if ((s as any).name) out.set((s as any).name.text, mod(file));
        if (ts.isVariableStatement(s))
          for (const d of s.declarationList.declarations)
            if (ts.isIdentifier(d.name)) out.set(d.name.text, mod(file));
      }
    }
  }
  return out;
}

const barrels = [
  "packages/shared/index.ts",
  "packages/shared/contracts/index.ts",
  "packages/shared/tasks/index.ts",
  "packages/shared/render/index.ts",
  "packages/shared/replay/index.ts",
  "packages/shared/search/index.ts",
  "packages/shared/changes/index.ts",
];
const barrelReport: any = {};
const originsDump: any = {};
for (const b of barrels) {
  const origins = exportOrigins(b);
  originsDump[b] = Object.fromEntries(origins);
  const users = edges.filter(
    (e) => e.to === b && e.from !== "packages/shared/index.ts",
  );
  const byOrigin = new Map<string, Set<string>>();
  const importers = new Map<string, string[]>();
  const ns: string[] = [];
  for (const e of users) {
    if (!Array.isArray(e.names)) {
      ns.push(`${e.from} (${e.kind} ${JSON.stringify(e.names)})`);
      continue;
    }
    importers.set(e.from, [...(importers.get(e.from) ?? []), ...e.names]);
    for (const n of e.names) {
      const o = origins.get(n) ?? `?${n}`;
      if (!byOrigin.has(o)) byOrigin.set(o, new Set());
      byOrigin.get(o)!.add(e.from);
    }
  }
  barrelReport[b] = {
    reexports: new Set(origins.values()).size,
    importerFiles: new Set(users.map((e) => e.from)).size,
    importersByArea: Object.fromEntries(
      [...new Set(users.map((e) => e.from))].reduce(
        (m, f) => m.set(area(f), (m.get(area(f)) ?? 0) + 1),
        new Map(),
      ),
    ),
    namespaceOrStar: ns,
    byOriginModule: Object.fromEntries(
      [...byOrigin]
        .sort((a, b) => b[1].size - a[1].size)
        .map(([k, v]) => [k, v.size]),
    ),
    importers: Object.fromEntries(importers),
  };
}

const fanInOut: any = {};
for (const [t, m] of [...fanIn].sort()) {
  const o: any = {};
  let outside = 0;
  const outsideFiles = new Set<string>();
  for (const [k, v] of m) {
    o[k] = v.size;
    if (k !== "core" && k !== "core-test" && k !== "shared")
      for (const f of v) outsideFiles.add(f);
  }
  fanInOut[t] = { ...o, outsideTotal: outsideFiles.size };
}

const outAdj: any = {};
for (const [k, v] of adj) outAdj[k] = [...v].sort();
const testEdges = edges
  .filter((e) => isCore(e.from) && isTest(e.from) && isCore(e.to))
  .map((e) => [mod(e.from), mod(e.to)]);
writeFileSync(
  process.argv[4],
  JSON.stringify(
    { sccs, fanIn: fanInOut, adj: outAdj, barrelReport, testEdges },
    null,
    1,
  ),
);
writeFileSync("barrelOrigins.json", JSON.stringify(originsDump));
console.log(
  "nodes",
  nodes.size,
  "sccs",
  sccs.map((c) => c.length),
);
