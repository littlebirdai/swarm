import { readFileSync, writeFileSync } from "node:fs";
const R = JSON.parse(readFileSync("report.json", "utf8"));
const I: Record<string, string[]> = JSON.parse(
  readFileSync("importers.json", "utf8"),
);
const A: Record<string, string> = {};
for (const l of readFileSync("assign.txt", "utf8").trim().split("\n")) {
  const [p, r] = l.split(": ");
  for (const m of r.split(" ")) A[m] = p;
}
type PR = { wave: number; id: string; pkg: string; mods: string[] };
const prs: PR[] = [];
const prOf: Record<string, PR> = {};
for (const l of readFileSync("waves.txt", "utf8").trim().split("\n")) {
  if (!l.trim() || l.startsWith("#")) continue;
  const m = l.match(/^W(\d+)\s+(\S+)\s+(\S+):\s*(.*)$/)!;
  const pr = {
    wave: +m[1],
    id: m[2],
    pkg: m[3],
    mods: m[4].split(/\s+/).filter(Boolean),
  };
  prs.push(pr);
  for (const x of pr.mods) {
    if (prOf[x]) console.log("DUP", x);
    if (A[x] !== pr.pkg) console.log("PKG MISMATCH", x, A[x], pr.pkg);
    prOf[x] = pr;
  }
}
for (const m of Object.keys(A)) if (!prOf[m]) console.log("NOT PLANNED", m);
const fileMod = (f: string) =>
  f.replace(/^packages\/shared\//, "").replace(/\.(tsx?|js|json)$/, "");
const SPLIT: Record<string, Record<string, string>> = {
  "contracts/signalFingerprint": {
    "contracts/inboxProjection": "hash/fnv1a32",
  },
  "changes/keys": { "contracts/inboxProjection": "hash/fnv1a32" },
};
const TEST_OWNER: Record<string, string> = {
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
const MEMO = new Map<string, string | null>();
const modOfTest = (t: string): string | null => {
  if (MEMO.has(t)) return MEMO.get(t)!;
  const r = modOfTest0(t);
  MEMO.set(t, r);
  return r;
};
const modOfTest0 = (t: string): string | null => {
  if (TEST_OWNER[t]) return TEST_OWNER[t];
  if (A[t]) return t;
  let b = t;
  while (b.includes(".")) {
    b = b.replace(/\.[^./]+$/, "");
    if (A[b]) return b;
  }
  const dir = t.split("/").slice(0, -1).join("/");
  const cand = Object.keys(A).filter(
    (k) => k.startsWith(dir + "/") && !k.includes("__fixtures__"),
  );
  if (t.startsWith("contracts/__fixtures__/")) {
    const n = t.split("/").pop()!.split(".")[0];
    if (A[`contracts/__fixtures__/${n}`]) return `contracts/__fixtures__/${n}`;
  }
  if (!t.startsWith("contracts/") && cand.length)
    return cand.find((k) => k.endsWith("/index")) ?? cand[0];
  return null;
};
const deps = new Map<string, Set<string>>();
for (const [m, ds] of Object.entries(R.adj) as [string, string[]][]) {
  deps.set(
    m,
    new Set(
      ds.map((d) => SPLIT[m]?.[d] ?? d).filter((d) => d !== "contracts/index"),
    ),
  );
}
const unowned = new Set<string>();
for (const [t, d] of R.testEdges as [string, string][]) {
  if (TEST_DROP.has(`${t}->${d}`)) continue;
  const o = modOfTest(t);
  if (!o) {
    unowned.add(t);
    continue;
  }
  if (o === d) continue;
  if (!deps.has(o)) deps.set(o, new Set());
  deps.get(o)!.add(d);
}
if (unowned.size) console.log("UNOWNED TESTS", [...unowned]);
const rows: any[] = [];
for (const pr of prs.sort(
  (a, b) => a.wave - b.wave || a.id.localeCompare(b.id),
)) {
  const problems: string[] = [];
  for (const m of pr.mods)
    for (const d of deps.get(m) ?? []) {
      if (d === "hash/fnv1a32") {
        if (pr.wave < 1) problems.push(`${m}->${d}`);
        continue;
      }
      const q = prOf[d];
      if (!q) {
        problems.push(`${m}->${d} unplanned`);
        continue;
      }
      if (q === pr) continue;
      if (q.wave >= pr.wave) problems.push(`${m}->${d} (${q.id} W${q.wave})`);
    }
  const files = new Set<string>();
  const byArea: Record<string, number> = {};
  for (const m of pr.mods)
    for (const f of I[m] ?? []) {
      const fm = fileMod(f);
      const owner = !f.startsWith("packages/shared/")
        ? null
        : A[fm]
          ? fm
          : modOfTest(fm);
      if (f.startsWith("packages/shared/") && owner && A[owner] === pr.pkg)
        continue;
      files.add(f);
    }
  for (const f of files) {
    const a = f.startsWith("packages/shared/")
      ? "shared"
      : (
          f.match(/^(apps|packages|tests)\/[^/]+/)?.[0] ?? f.split("/")[0]
        ).replace("apps/", "");
    byArea[a] = (byArea[a] ?? 0) + 1;
  }
  const breaks: string[] = [];
  rows.push({ ...pr, importers: files.size, byArea, problems });
  console.log(
    `W${pr.wave} ${pr.id} [${pr.pkg}] mods=${pr.mods.length} importers=${files.size} ${JSON.stringify(byArea)}${problems.length ? " PROBLEMS: " + problems.join("; ") : ""}`,
  );
}
writeFileSync("waves.json", JSON.stringify(rows, null, 1));
