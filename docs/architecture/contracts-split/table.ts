import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.argv[2];
const { edges } = JSON.parse(readFileSync("edges.json", "utf8"));
const R = JSON.parse(readFileSync("report.json", "utf8"));
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
  /\.(test)\.tsx?$/.test(f) ||
  /\.testkit\.ts$/.test(f) ||
  f.includes("/__fixtures__/") ||
  /\.fixture\.ts$/.test(f);
const mod = (f: string) =>
  f.replace(/^packages\/shared\//, "").replace(/\.(tsx?|js)$/, "");
const BARRELS: Record<string, string> = {
  "packages/shared/contracts/index.ts": "contracts/index",
  "packages/shared/tasks/index.ts": "tasks/index",
  "packages/shared/render/index.ts": "render/index",
  "packages/shared/replay/index.ts": "replay/index",
  "packages/shared/search/index.ts": "search/index",
  "packages/shared/changes/index.ts": "changes/index",
};
const importers = new Map<string, Set<string>>();
const addI = (m: string, f: string) => {
  if (!importers.has(m)) importers.set(m, new Set());
  importers.get(m)!.add(f);
};
for (const e of edges) {
  if (!isCore(e.to)) continue;
  if (e.from === "packages/shared/index.ts") continue;
  if (BARRELS[e.to] && !BARRELS[e.from]) {
    const br = R.barrelReport[e.to];
    if (Array.isArray(e.names)) {
      const origins = new Map<string, string>();
      for (const n of e.names) {
        for (const [o, _] of Object.entries(br.byOriginModule)) void o;
      }
    }
  }
  if (BARRELS[e.from]) continue;
  addI(mod(e.to), e.from);
}
const bimp = JSON.parse(readFileSync("barrelOrigins.json", "utf8")) as Record<
  string,
  Record<string, string>
>;
for (const e of edges) {
  if (
    !BARRELS[e.to] ||
    BARRELS[e.from] ||
    e.from === "packages/shared/index.ts"
  )
    continue;
  const om = bimp[e.to];
  if (Array.isArray(e.names))
    for (const n of e.names) {
      const o = om[n];
      if (o) addI(o, e.from);
    }
  else addI(`${BARRELS[e.to]}#ns`, e.from);
}
const area = (f: string) => {
  if (isCore(f)) return isTest(f) ? "coreTest" : "core";
  const m = f.match(/^(apps|packages|tests)\/([^/]+)/);
  return m ? (m[1] === "apps" ? m[2] : `${m[1]}/${m[2]}`) : f.split("/")[0];
};
const rows: any[] = [];
const all = new Set<string>([...Object.keys(R.adj), ...importers.keys()]);
for (const m of [...all].sort()) {
  const fs = importers.get(m) ?? new Set();
  const by: Record<string, number> = {};
  for (const f of fs) by[area(f)] = (by[area(f)] ?? 0) + 1;
  const ext = [...fs].filter((f) => !f.startsWith("packages/shared/")).length;
  let loc = 0;
  for (const x of [".ts", ".tsx"])
    if (existsSync(join(ROOT, "packages/shared", m + x)))
      loc = readFileSync(join(ROOT, "packages/shared", m + x), "utf8").split(
        "\n",
      ).length;
  rows.push({ m, loc, ext, by, deps: R.adj[m] ?? [] });
}
writeFileSync("table.json", JSON.stringify(rows, null, 1));
writeFileSync(
  "importers.json",
  JSON.stringify(
    Object.fromEntries([...importers].map(([k, v]) => [k, [...v]])),
  ),
);
for (const r of rows)
  console.log(
    `${r.m}\t${r.loc}\t${r.ext}\t${Object.entries(r.by)
      .map(([k, v]) => k + ":" + v)
      .join(",")}\t${r.deps.join(" ")}`,
  );
