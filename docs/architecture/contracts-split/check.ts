import { readFileSync, writeFileSync } from "node:fs";
const R = JSON.parse(readFileSync("report.json", "utf8"));
const T = JSON.parse(readFileSync("table.json", "utf8"));
const I: Record<string, string[]> = JSON.parse(
  readFileSync("importers.json", "utf8"),
);
const A: Record<string, string> = {};
const order: string[] = [];
for (const l of readFileSync(process.argv[2] ?? "assign.txt", "utf8")
  .trim()
  .split("\n")) {
  const [p, r] = l.split(": ");
  order.push(p);
  for (const m of r.split(" ")) A[m] = p;
}
const fileMod = (f: string) =>
  f.replace(/^packages\/shared\//, "").replace(/\.(tsx?|js)$/, "");
const ownerOfTest = (f: string) => {
  const m = fileMod(f);
  if (A[m]) return A[m];
  const base = m
    .replace(
      /\.(test|guard\.test|ratchet\.test|golden\.test|rows\.test|testkit)$/,
      "",
    )
    .replace(/\.[a-z]+\.test$/, "")
    .replace(/\.[a-zA-Z]+$/, "");
  if (A[base]) return A[base];
  const dir = m.split("/")[0];
  const prefix = Object.keys(A)
    .filter((k) => m.startsWith(k.split(".")[0]))
    .sort((a, b) => b.length - a.length)[0];
  if (prefix) return A[prefix];
  const sameDir = Object.keys(A).find(
    (k) => k.startsWith(dir + "/") && dir !== "contracts",
  );
  return sameDir ? A[sameDir] : `?${m}`;
};
const split: Record<string, Record<string, string>> = {
  "contracts/signalFingerprint": {
    "contracts/inboxProjection": "hash/fnv1a32",
  },
  "changes/keys": { "contracts/inboxProjection": "hash/fnv1a32" },
  "contracts/linePriority": { "tasks/index": "tasks/statuses" },
};
const pe = new Map<string, Map<string, string[]>>();
const addPE = (a: string, b: string, why: string) => {
  if (a === b) return;
  if (!pe.has(a)) pe.set(a, new Map());
  const m = pe.get(a)!;
  if (!m.has(b)) m.set(b, []);
  m.get(b)!.push(why);
};
for (const [m, deps] of Object.entries(R.adj) as [string, string[]][]) {
  for (let d of deps) {
    d = split[m]?.[d] ?? d;
    if (d === "contracts/index") continue;
    addPE(A[m], A[d], `${m}->${d}`);
  }
}
const testPE = new Map<string, Set<string>>();
const TEST_OWNER_MOD: Record<string, string> = {
  "contracts/machineMessages.decisionAnswer.test": "contracts/decisionAnswers",
  "contracts/machineMessages.vaultReady.test": "contracts/vaultMessages",
  "contracts/capabilitySlug.test": "contracts/snippets",
  "contracts/channelHuddle.test": "contracts/callRoomKeys",
  "contracts/commandsSession.test": "contracts/inboxProjection",
  "contracts/decisionAnswerLabel.test": "contracts/decisionAnswers",
  "contracts/initiativeRecord.test": "contracts/initiative",
  "contracts/metricSeries.test": "contracts/lineWords",
  "contracts/replayImport.test": "contracts/replay",
  "contracts/runEnd.test": "contracts/changeCard",
  "contracts/momentWho.test": "contracts/moments",
  "changes/__fixtures__/genCodecastDays": "changes/index",
};
const TEST_DROP = new Set([
  "contracts/initiative.test->contracts/machineMessages",
  "contracts/agentStatus.test->contracts/inboxProjection",
  "contracts/hibernation.test->contracts/inboxProjection",
  "contracts/sessionSnooze.test->contracts/inboxProjection",
  "contracts/capabilityScopes.test->contracts/index",
  "contracts/capabilitySlug.test->contracts/index",
  "contracts/cloudAgents.test->contracts/apiErrorBanner",
]);
for (const [f, t] of R.testEdges as [string, string][]) {
  if (TEST_DROP.has(`${f}->${t}`)) continue;
  const a = TEST_OWNER_MOD[f]
    ? A[TEST_OWNER_MOD[f]]
    : ownerOfTest("packages/shared/" + f + ".ts");
  const b = A[t] ?? ownerOfTest("packages/shared/" + t + ".ts");
  if (a !== b) {
    if (!testPE.has(a)) testPE.set(a, new Set());
    testPE.get(a)!.add(`${b} (${f}->${t})`);
  }
}
const ext: Record<string, string[]> = {
  comments: ["fence"],
  blame: ["entities"],
  artifacts: ["entities"],
  vault: ["entities", "search"],
  agents: ["vault", "agent-clients"],
  memory: ["vault"],
};
for (const [a, bs] of Object.entries(ext))
  for (const b of bs) addPE(a, b, "external package");
addPE("calls", "@team", "callRoomKeys");
addPE("calls", "@chat", "callRoomKeys");
addPE("goals", "@chat", "initiative");
const nodes = new Set<string>([...order, ...Object.keys(ext)]);
let idx = 0;
const ix = new Map(),
  lo = new Map(),
  on = new Set(),
  st: string[] = [];
const sccs: string[][] = [];
const all = (v: string, withTests: boolean) =>
  [
    ...(pe.get(v)?.keys() ?? []),
    ...(withTests
      ? [...(testPE.get(v) ?? [])].map((s) => s.split(" ")[0])
      : []),
  ].filter((x) => !x.startsWith("@"));
function sc(v: string, wt: boolean) {
  ix.set(v, idx);
  lo.set(v, idx);
  idx++;
  st.push(v);
  on.add(v);
  for (const w of all(v, wt)) {
    if (!ix.has(w)) {
      sc(w, wt);
      lo.set(v, Math.min(lo.get(v), lo.get(w)));
    } else if (on.has(w)) lo.set(v, Math.min(lo.get(v), ix.get(w)));
  }
  if (lo.get(v) === ix.get(v)) {
    const c = [];
    let w;
    do {
      w = st.pop()!;
      on.delete(w);
      c.push(w);
    } while (w !== v);
    if (c.length > 1) sccs.push(c);
  }
}
for (const n of nodes) if (!ix.has(n)) sc(n, process.argv[3] !== "notests");
console.log("PACKAGE SCCs (incl tests):", JSON.stringify(sccs));
for (const c of sccs)
  for (const a of c)
    for (const [b, w] of pe.get(a) ?? [])
      if (c.includes(b))
        console.log("  ", a, "->", b, w.slice(0, 4).join(", "));
const depth = new Map<string, number>();
const d = (v: string): number => {
  if (depth.has(v)) return depth.get(v)!;
  depth.set(v, 0);
  const r = Math.max(-1, ...all(v, true).map(d)) + 1;
  depth.set(v, r);
  return r;
};
const out: any[] = [];
const loc = Object.fromEntries(T.map((r: any) => [r.m, r.loc]));
for (const p of order) {
  const mems = Object.keys(A).filter((m) => A[m] === p);
  const files = new Set<string>();
  const outside = new Set<string>();
  const inShared = new Set<string>();
  for (const m of mems)
    for (const f of I[m] ?? []) {
      const fm = fileMod(f);
      if (
        f.startsWith("packages/shared/") &&
        (A[fm] === p || ownerOfTest(f) === p)
      )
        continue;
      files.add(f);
      if (f.startsWith("packages/shared/")) inShared.add(f);
      else outside.add(f);
    }
  out.push({
    p,
    layer: d(p),
    modules: mems.length,
    loc: mems.reduce((s, m) => s + (loc[m] ?? 0), 0),
    importers: files.size,
    outside: outside.size,
    inShared: inShared.size,
    deps: [...(pe.get(p)?.keys() ?? [])].sort(),
    testDeps: [...(testPE.get(p) ?? [])],
  });
}
out.sort((a, b) => a.layer - b.layer || a.p.localeCompare(b.p));
for (const o of out)
  console.log(
    `L${o.layer} ${o.p} mods=${o.modules} loc=${o.loc} importers=${o.importers} (outside ${o.outside}, shared ${o.inShared}) deps=[${o.deps.join(",")}] ${o.testDeps.length ? "testDeps=" + o.testDeps.join(";") : ""}`,
  );
writeFileSync(
  "packages.json",
  JSON.stringify(
    {
      out,
      edges: Object.fromEntries(
        [...pe].map(([a, m]) => [a, Object.fromEntries(m)]),
      ),
    },
    null,
    1,
  ),
);
