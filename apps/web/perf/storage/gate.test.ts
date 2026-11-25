import { describe, expect, test } from "bun:test";
import { ROW_COUNT } from "./fixture";
import { evaluate, gate } from "./gate";
import { stats, type BrowserResult, type Report } from "./samples";

const constant = (value: number) => stats(Array<number>(20).fill(value));

function result() {
  const dexie = {
    readyMs: constant(8),
    paintMs: constant(50),
    fullBootMs: constant(500),
    mainWriteMs: constant(1),
    savedMs: constant(8),
    retentionMs: constant(48),
    handoffMs: constant(49),
    handoffIntact: true,
    crashIntact: true,
    databaseBytes: 200_000_000,
  };
  return {
    status: "measured",
    userAgent: "synthetic-browser",
    dexie,
    sqlite: {
      ...dexie,
      readyMs: constant(120),
      paintMs: constant(25),
      mainWriteMs: constant(2),
      retentionMs: constant(50),
      handoffMs: constant(100),
      workerBytes: constant(35 * 1024 * 1024),
      wasmBytes: constant(8 * 1024 * 1024),
      journal: "delete",
      sqliteVersion: "3.54.1",
      opfsBytes: 200_128_000,
    },
  } satisfies BrowserResult;
}

describe("bench statistics", () => {
  test("reports nearest ranks without changing the raw trial order", () => {
    const values = [
      100,
      ...Array.from({ length: 19 }, (_, index) => 19 - index),
    ];
    expect(stats(values)).toEqual({
      count: 20,
      p50: 10,
      p95: 19,
      max: 100,
      samples: values,
    });
  });

  test("rejects empty, negative and nonfinite samples", () => {
    for (const sample of [[], [-1], [Infinity], [NaN]])
      expect(() => stats(sample)).toThrow();
  });
});

describe("storage gate", () => {
  test("accepts exact thresholds and applies the Chromium comparison and startup limits", () => {
    const measured = result();
    expect(evaluate("chromium", measured, 20, ROW_COUNT).verdict).toBe("pass");
    measured.sqlite.paintMs = constant(26);
    measured.sqlite.readyMs = constant(200);
    expect(evaluate("chromium", measured, 20, ROW_COUNT)).toMatchObject({
      verdict: "fail",
      targets: {
        paintComparedToDexieMs: { pass: false },
        workerReadyMs: { pass: false },
      },
    });
    expect(evaluate("electron", measured, 20, ROW_COUNT).verdict).toBe("pass");
  });

  test("fails an absolute paint or write limit, a slow retention or handoff, and a memory peak", () => {
    const measured = result();
    measured.dexie.paintMs = constant(100);
    measured.sqlite.paintMs = constant(61);
    measured.sqlite.mainWriteMs = constant(2.1);
    measured.sqlite.retentionMs = constant(51);
    measured.sqlite.handoffMs = constant(101);
    measured.sqlite.workerBytes = stats([
      ...Array<number>(19).fill(8 * 1024 * 1024),
      36 * 1024 * 1024,
    ]);
    expect(evaluate("electron", measured, 20, ROW_COUNT)).toMatchObject({
      verdict: "fail",
      targets: {
        paintMs: { pass: false },
        paintComparedToDexieMs: { pass: true },
        mainWriteMs: { pass: false },
        retentionMs: { pass: false },
        handoffMs: { pass: false },
        workerBytes: { pass: false },
      },
    });
  });

  test("requires data integrity, a rollback journal and complete samples", () => {
    const measured: Extract<BrowserResult, { status: "measured" }> = result();
    measured.sqlite.handoffIntact = false;
    measured.sqlite.crashIntact = false;
    measured.sqlite.journal = "wal";
    measured.sqlite.workerBytes = null;
    expect(evaluate("safari", measured, 1, 149_999)).toMatchObject({
      verdict: "fail",
      targets: {
        fixtureRows: { pass: false },
        samples: { pass: false },
        handoffIntact: { pass: false },
        crashIntact: { pass: false },
        rollbackJournal: { pass: false },
        workerBytes: { pass: false },
      },
    });
  });

  test("returns incomplete for skipped browsers and fails on a browser error", () => {
    const report: Report = {
      trialCount: 20,
      rowCount: ROW_COUNT,
      machine: {
        cpu: "synthetic",
        logicalCPUs: 1,
        release: "synthetic",
        load: [],
      },
      browsers: {
        chromium: result(),
        electron: result(),
        safari: result(),
        firefox: result(),
      },
    };
    expect(gate(report).verdict).toBe("pass");
    report.browsers.safari = { status: "not-run", reason: "Unavailable" };
    expect(gate(report).verdict).toBe("incomplete");
    report.browsers.firefox = { status: "error", reason: "Failed to run" };
    expect(gate(report).verdict).toBe("fail");
  });
});
