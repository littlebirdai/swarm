import { ROW_COUNT } from "./fixture";
import {
  BROWSERS,
  type Browser,
  type BrowserResult,
  type Report,
} from "./samples";

const mib = 1024 * 1024;

export function evaluate(
  browser: Browser,
  result: BrowserResult,
  trialCount: number,
  rowCount: number,
) {
  if (result.status !== "measured")
    return {
      verdict: result.status === "not-run" ? "not-run" : "fail",
      reason: result.reason,
    };
  const { sqlite, dexie } = result;
  const maximum = (actual: number | null, limit: number) => ({
    actual,
    limit,
    pass:
      actual !== null &&
      Number.isFinite(actual) &&
      actual >= 0 &&
      actual <= limit,
  });
  const requiredSamples = [
    dexie.paintMs,
    sqlite.readyMs,
    sqlite.paintMs,
    sqlite.mainWriteMs,
    sqlite.retentionMs,
    sqlite.handoffMs,
    sqlite.workerBytes,
  ];
  const targets = {
    fixtureRows: {
      actual: rowCount,
      target: ROW_COUNT,
      pass: rowCount === ROW_COUNT,
    },
    samples: {
      actual: trialCount,
      minimum: 20,
      pass:
        trialCount >= 20 &&
        requiredSamples.every((sample) => sample?.count === trialCount),
    },
    baselineIntegrity: {
      actual: dexie.handoffIntact && dexie.crashIntact,
      pass: dexie.handoffIntact && dexie.crashIntact,
    },
    rollbackJournal: {
      actual: sqlite.journal,
      pass: sqlite.journal === "delete",
    },
    workerReadyMs: maximum(
      sqlite.readyMs.p95,
      browser === "chromium" ? 120 : 200,
    ),
    paintMs: maximum(sqlite.paintMs.p95, 60),
    paintComparedToDexieMs: maximum(
      sqlite.paintMs.p95,
      dexie.paintMs.p95 / (browser === "chromium" ? 2 : 1),
    ),
    mainWriteMs: maximum(sqlite.mainWriteMs.p95, 2),
    retentionMs: maximum(sqlite.retentionMs.p95, 50),
    handoffMs: maximum(sqlite.handoffMs.p95, 100),
    handoffIntact: { actual: sqlite.handoffIntact, pass: sqlite.handoffIntact },
    crashIntact: { actual: sqlite.crashIntact, pass: sqlite.crashIntact },
    workerBytes: maximum(sqlite.workerBytes?.max ?? null, 35 * mib),
  };
  return {
    verdict: Object.values(targets).every((target) => target.pass)
      ? "pass"
      : "fail",
    targets,
  };
}

export function gate(report: Report) {
  const browsers = BROWSERS.map(
    (browser) =>
      [
        browser,
        evaluate(
          browser,
          report.browsers[browser],
          report.trialCount,
          report.rowCount,
        ),
      ] as const,
  );
  const verdicts = browsers.map(([, result]) => result.verdict);
  const verdict = verdicts.includes("fail")
    ? "fail"
    : verdicts.includes("not-run")
      ? "incomplete"
      : "pass";
  return { verdict, browsers: Object.fromEntries(browsers) };
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) throw new Error("Usage: bun gate.ts <results.json>");
  const report = (await Bun.file(path).json()) as Report;
  const result = gate(report);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode =
    result.verdict === "pass" ? 0 : result.verdict === "fail" ? 1 : 2;
}
