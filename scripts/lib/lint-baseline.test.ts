import { expect, test } from "bun:test";
import {
  carryRenames,
  compareLintCounts,
  matchLintTransfers,
  parseRenames,
  staleFiles,
  type DiagnosticSpans,
} from "./lint-baseline";
import { diagnosticLines } from "./oxlint";

test("reports a count that grew", () => {
  const { grew } = compareLintCounts(
    { "a.ts": { comments: 1 } },
    { "a.ts": { comments: 2 } },
  );
  expect(grew).toEqual([
    { file: "a.ts", rule: "comments", before: 1, after: 2 },
  ]);
});

test("reports a new rule in an existing file and a rule in a new file", () => {
  const { grew } = compareLintCounts(
    { "a.ts": { comments: 1 } },
    { "a.ts": { comments: 1, hooks: 2 }, "b.ts": { comments: 1 } },
  );
  expect(grew).toEqual([
    { file: "a.ts", rule: "hooks", before: 0, after: 2 },
    { file: "b.ts", rule: "comments", before: 0, after: 1 },
  ]);
});

test("reports a count that shrank without reporting growth", () => {
  const { grew, shrank } = compareLintCounts(
    { "a.ts": { comments: 2 } },
    { "a.ts": { comments: 1 } },
  );
  expect(grew).toEqual([]);
  expect(shrank).toEqual([
    { file: "a.ts", rule: "comments", before: 2, after: 1 },
  ]);
});

test("keeps unchanged counts", () => {
  const baseline = { "a.ts": { comments: 1 } };
  expect(compareLintCounts(baseline, baseline)).toEqual({
    grew: [],
    shrank: [],
    pruned: baseline,
  });
});

test("prunes lower counts and removes zero counts without adding allowances", () => {
  const baseline = {
    "a.ts": { comments: 3, hooks: 1, imports: 2 },
    "b.ts": { comments: 1 },
  };
  const current = {
    "a.ts": { comments: 1, effects: 1, imports: 3 },
    "c.ts": { comments: 1 },
  };
  expect(compareLintCounts(baseline, current).pruned).toEqual({
    "a.ts": { comments: 1, imports: 2 },
  });
});

test("a renamed file keeps its baselined counts under its new path", () => {
  const baseline = { "old.ts": { comments: 64 }, "kept.ts": { comments: 1 } };
  const carried = carryRenames(baseline, [["old.ts", "new.ts"]]);
  expect(carried).toEqual({
    "new.ts": { comments: 64 },
    "kept.ts": { comments: 1 },
  });
  const { grew, pruned } = compareLintCounts(carried, {
    "new.ts": { comments: 64 },
    "kept.ts": { comments: 1 },
  });
  expect(grew).toEqual([]);
  expect(pruned).toEqual({
    "kept.ts": { comments: 1 },
    "new.ts": { comments: 64 },
  });
});

test("a rename never overwrites a path that already has counts", () => {
  const baseline = { "a.ts": { comments: 3 }, "b.ts": { comments: 1 } };
  expect(carryRenames(baseline, [["a.ts", "b.ts"]])).toEqual(baseline);
});

test("reads renames from git's -z name-status output and ignores copies and other statuses", () => {
  const out = [
    "R100",
    "old.ts",
    "new.ts",
    "M",
    "x.ts",
    "C075",
    "a.ts",
    "b.ts",
    "R087",
    "p/q.ts",
    "r/q.ts",
    "",
  ].join("\0");
  expect(parseRenames(out)).toEqual([
    ["old.ts", "new.ts"],
    ["p/q.ts", "r/q.ts"],
  ]);
});

test("names the baseline files that no longer exist", () => {
  const baseline = {
    "moved.ts": { comments: 2 },
    "kept.ts": { comments: 1 },
    "deleted.ts": { comments: 4 },
  };
  expect(staleFiles(baseline, (file) => file === "kept.ts")).toEqual([
    "deleted.ts",
    "moved.ts",
  ]);
});

function spans(
  entries: Record<string, Record<string, string[]>>,
): DiagnosticSpans {
  return new Map(
    Object.entries(entries).map(([file, rules]) => [
      file,
      {
        source: `\n${Object.values(rules)
          .flat()
          .flatMap((text) => [text, "context"])
          .join("\n")}\n`,
        rules: new Map(
          Object.entries(rules).map(([rule, texts]) => [
            rule,
            texts.map((text) => ({ text, next: "context" })),
          ]),
        ),
      },
    ]),
  );
}

test("matches only removed occurrences of the same rule and text", () => {
  const before = spans({ "source.ts": { comments: ["same", "same", "stay"] } });
  const after = spans({
    "source.ts": { comments: ["same", "stay"] },
    "split.ts": {
      comments: ["same", "same", "stay", "edited"],
      other: ["same"],
    },
  });
  const matched = matchLintTransfers(
    [{ file: "source.ts", rule: "comments", before: 3, after: 2 }],
    [
      { file: "split.ts", rule: "other", before: 0, after: 1 },
      { file: "split.ts", rule: "comments", before: 0, after: 4 },
    ],
    before,
    after,
  );
  expect(matched.map(({ before }) => before)).toEqual([0, 1]);
});

test("shares each donor budget across files and reassigns overlapping matches", () => {
  const before = spans({
    "a.ts": { comments: ["shared", "unique"] },
    "b.ts": { comments: ["shared"] },
  });
  const after = spans({
    "a.ts": { comments: ["replacement"] },
    "new-1.ts": { comments: ["shared"] },
    "new-2.ts": { comments: ["unique"] },
    "new-3.ts": { comments: ["unique"] },
  });
  const donations = [
    { file: "a.ts", rule: "comments", before: 2, after: 1 },
    { file: "b.ts", rule: "comments", before: 1, after: 0 },
  ];
  const requests = ["new-1.ts", "new-2.ts", "new-3.ts"].map((file) => ({
    file,
    rule: "comments",
    before: 0,
    after: 1,
  }));
  expect(
    matchLintTransfers(donations, requests.slice(0, 2), before, after).map(
      ({ before }) => before,
    ),
  ).toEqual([1, 1]);
  expect(
    matchLintTransfers(donations, requests, before, after).reduce(
      (total, { before }) => total + before,
      0,
    ),
  ).toBe(2);
  expect(
    matchLintTransfers(
      donations.slice(0, 1),
      requests.slice(0, 2),
      before,
      after,
    ).reduce((total, { before }) => total + before, 0),
  ).toBe(1);
});

test("extracts whole trimmed lines and nonblank neighbors from UTF-8 spans", () => {
  const prefix = 'const name = "é🙂"; ';
  const span = "/* héllo\r\n    * world  \r\n    */";
  const header = "  before  \r\n\r\n}\n";
  const source = Buffer.from(header + prefix + span + "\n\n  after  \n");
  expect(
    diagnosticLines(
      {
        severity: "error",
        message: "Code comments are forbidden.",
        labels: [
          {
            span: {
              line: 1,
              offset: Buffer.byteLength(header + prefix),
              length: Buffer.byteLength(span),
            },
          },
        ],
      },
      source,
    ),
  ).toEqual({
    text: prefix + "/* héllo\n* world\n*/",
    start: Buffer.byteLength(header),
    previous: "before",
    next: "after",
  });
});

test("a neighbor that stays in the source does not carry a transfer", () => {
  const block = (source: string, texts: string[]) => ({
    source,
    rules: new Map([
      ["comments", texts.map((text) => ({ text, next: "return null;" }))],
    ]),
  });
  const match = (kept: string) =>
    matchLintTransfers(
      [{ file: "old.ts", rule: "comments", before: 1, after: 0 }],
      [{ file: "new.ts", rule: "comments", before: 0, after: 1 }],
      new Map([["old.ts", block("\n// TODO\nreturn null;\n", ["// TODO"])]]),
      new Map([
        ["old.ts", block(kept, [])],
        ["new.ts", block("\n// TODO\nreturn null;\n", ["// TODO"])],
      ]),
    )[0]!.before;
  expect(match("\nreturn null;\n")).toBe(0);
  expect(match("\nother();\n")).toBe(1);
});

test("a moved line carries each of its diagnostics", () => {
  const spansOf = (source: string, starts: number[]) => ({
    source,
    rules: new Map([
      [
        "keys",
        starts.map((start) => ({ text: "a || b", start, next: "done" })),
      ],
    ]),
  });
  const matched = matchLintTransfers(
    [{ file: "old.ts", rule: "keys", before: 4, after: 2 }],
    [{ file: "new.ts", rule: "keys", before: 0, after: 4 }],
    new Map([
      ["old.ts", spansOf("\na || b\ndone\na || b\ndone\n", [0, 0, 12, 12])],
    ]),
    new Map([
      ["old.ts", spansOf("\na || b\ndone\n", [0, 0])],
      ["new.ts", spansOf("\na || b\ndone\na || b\ndone\n", [0, 0, 12, 12])],
    ]),
  );
  expect(matched[0]!.before).toBe(2);
});

test("a declaration that gains an export keeps the same lines", () => {
  const lines = (declaration: string) => {
    const comment = "/** What it holds. */";
    return diagnosticLines(
      {
        severity: "error",
        message: "Code comments are forbidden.",
        labels: [{ span: { line: 1, offset: 0, length: comment.length } }],
      },
      Buffer.from(`${comment}\n${declaration}\n`),
    );
  };
  expect(lines("export interface Held {")).toEqual(lines("interface Held {"));
  expect(lines("export default class Held {")).toEqual(lines("class Held {"));
  expect(lines("interface Other {")).not.toEqual(lines("interface Held {"));
});
