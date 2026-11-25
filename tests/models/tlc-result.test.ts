import { expect, test } from "bun:test";
import { parseRuleSections } from "./config-rules";
import { parseTlcResult } from "./tlc-result";

const [
  passing,
  invariant,
  initial,
  temporal,
  temporalHolds,
  deadlock,
  invalid,
] = await Promise.all(
  [
    "holds",
    "invariant",
    "initial-invariant",
    "temporal",
    "temporal-holds",
    "deadlock",
    "invalid-config",
  ].map((name) =>
    Bun.file(new URL(`./fixtures/${name}.txt`, import.meta.url)).text(),
  ),
);
const property = ["GoneHolderFreesBaton"];

test("reads the final distinct-state count from a successful run", () => {
  expect(parseTlcResult(0, passing, [])).toEqual({
    outcome: "holds",
    distinctStates: 70_596,
  });
});

test("requires completed temporal checking when the config has a property", () => {
  expect(parseTlcResult(0, temporalHolds, property)).toEqual({
    outcome: "holds",
    distinctStates: 1_420,
  });
  expect(() => parseTlcResult(0, passing, property)).toThrow(
    "Unexpected TLC result",
  );
});

test("reports the violated invariant and the count at the counterexample", () => {
  expect(parseTlcResult(12, invariant, [])).toEqual({
    outcome: "violated",
    kind: "invariant",
    rule: "ActsOnlyOnTheTurnSeen",
    distinctStates: 41,
  });
});

test("reports an initial-state violation before TLC prints statistics", () => {
  expect(parseTlcResult(12, initial, [])).toMatchObject({
    outcome: "violated",
    kind: "invariant",
    rule: "Nonzero",
  });
  expect(parseTlcResult(12, initial, []).distinctStates).toBeUndefined();
});

test("identifies a temporal violation only when its property is unambiguous", () => {
  expect(parseTlcResult(13, temporal, property)).toEqual({
    outcome: "violated",
    kind: "property",
    rule: "GoneHolderFreesBaton",
    distinctStates: 420,
  });
  const sections = parseRuleSections(`
    SPECIFICATION FairSpec
    PROPERTIES GoneHolderFreesBaton
      EventuallyStops
  `);
  const properties = sections.flatMap((section) => section.names);
  expect(() => parseTlcResult(13, temporal, properties)).toThrow(
    "Unexpected TLC result",
  );
});

test("parses singular and plural rule sections with comments and continuation lines", () => {
  const sections = parseRuleSections(String.raw`
    CONSTANT Name = "PROPERTY Ignored"
    PROPERTY First Second \* PROPERTY Ignored
      Third
    INVARIANTS Alpha (* PROPERTY Ignored (* nested *) still ignored *) Beta
      Gamma
    PROPERTIES Fourth Fifth
      Sixth
    INVARIANT Delta
    CHECK_DEADLOCK FALSE
  `);
  expect(sections.map(({ kind, names }) => [kind, names])).toEqual([
    ["properties", ["First", "Second", "Third"]],
    ["invariants", ["Alpha", "Beta", "Gamma"]],
    ["properties", ["Fourth", "Fifth", "Sixth"]],
    ["invariants", ["Delta"]],
  ]);
});

test("rejects an apparent hold when TLC exits nonzero", () => {
  expect(() => parseTlcResult(12, passing, [])).toThrow("exit 12");
});

test("rejects an apparent hold with pending states", () => {
  const unfinished = passing.replace(
    "0 states left on queue",
    "1 states left on queue",
  );
  expect(() => parseTlcResult(0, unfinished, [])).toThrow("exit 0");
});

test("rejects a temporal result with pending states", () => {
  const unfinished = temporal.replaceAll(
    "0 states left on queue",
    "1 states left on queue",
  );
  expect(() => parseTlcResult(13, unfinished, property)).toThrow("exit 13");
});

test("rejects a deadlock as a checker error", () => {
  expect(() => parseTlcResult(11, deadlock, [])).toThrow("Deadlock reached");
});

test("rejects config errors, incomplete runs, and inconsistent exit codes", () => {
  expect(() => parseTlcResult(151, invalid, [])).toThrow("MachineGuard");
  expect(() => parseTlcResult(0, passing.split("Finished in")[0], [])).toThrow(
    "Unexpected TLC result",
  );
  expect(() => parseTlcResult(0, invariant, [])).toThrow(
    "Unexpected TLC result",
  );
});
