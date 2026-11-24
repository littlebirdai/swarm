import { expect, test } from "bun:test";
import { carryRenames, compareLintCounts, parseRenames } from "./lint-baseline";

test("reports a count that grew", () => {
  const { grew } = compareLintCounts({ "a.ts": { comments: 1 } }, { "a.ts": { comments: 2 } });
  expect(grew).toEqual([{ file: "a.ts", rule: "comments", before: 1, after: 2 }]);
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
  const { grew, shrank } = compareLintCounts({ "a.ts": { comments: 2 } }, { "a.ts": { comments: 1 } });
  expect(grew).toEqual([]);
  expect(shrank).toEqual([{ file: "a.ts", rule: "comments", before: 2, after: 1 }]);
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
  const baseline = { "a.ts": { comments: 3, hooks: 1, imports: 2 }, "b.ts": { comments: 1 } };
  const current = { "a.ts": { comments: 1, effects: 1, imports: 3 }, "c.ts": { comments: 1 } };
  expect(compareLintCounts(baseline, current).pruned).toEqual({ "a.ts": { comments: 1, imports: 2 } });
});

test("a renamed file keeps its baselined counts under its new path", () => {
  const baseline = { "old.ts": { comments: 64 }, "kept.ts": { comments: 1 } };
  const carried = carryRenames(baseline, [["old.ts", "new.ts"]]);
  expect(carried).toEqual({ "new.ts": { comments: 64 }, "kept.ts": { comments: 1 } });
  const { grew, pruned } = compareLintCounts(carried, { "new.ts": { comments: 64 }, "kept.ts": { comments: 1 } });
  expect(grew).toEqual([]);
  expect(pruned).toEqual({ "kept.ts": { comments: 1 }, "new.ts": { comments: 64 } });
});

test("a rename never overwrites a path that already has counts", () => {
  const baseline = { "a.ts": { comments: 3 }, "b.ts": { comments: 1 } };
  expect(carryRenames(baseline, [["a.ts", "b.ts"]])).toEqual(baseline);
});

test("reads renames from git's -z name-status output and ignores copies and other statuses", () => {
  const out = ["R100", "old.ts", "new.ts", "M", "x.ts", "C075", "a.ts", "b.ts", "R087", "p/q.ts", "r/q.ts", ""].join("\0");
  expect(parseRenames(out)).toEqual([["old.ts", "new.ts"], ["p/q.ts", "r/q.ts"]]);
});
