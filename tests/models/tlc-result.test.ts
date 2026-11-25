import { expect, test } from "bun:test";
import { parseTlcResult } from "./tlc-result";

const passing = await Bun.file(
  new URL("./fixtures/holds.txt", import.meta.url),
).text();
const invariant = await Bun.file(
  new URL("./fixtures/invariant.txt", import.meta.url),
).text();
const temporal = await Bun.file(
  new URL("./fixtures/temporal.txt", import.meta.url),
).text();
const invalid = await Bun.file(
  new URL("./fixtures/invalid-config.txt", import.meta.url),
).text();

test("reads the final distinct-state count from a successful run", () => {
  expect(parseTlcResult(0, passing, "")).toEqual({
    outcome: "holds",
    distinctStates: 70_596,
  });
});

test("reports the violated invariant and the count at the counterexample", () => {
  expect(parseTlcResult(12, invariant, "")).toEqual({
    outcome: "violated",
    kind: "invariant",
    rule: "ActsOnlyOnTheTurnSeen",
    distinctStates: 41,
  });
});

test("identifies a temporal violation only when its property is unambiguous", () => {
  const config = "SPECIFICATION FairSpec\nPROPERTY GoneHolderFreesBaton\n";
  expect(parseTlcResult(13, temporal, config)).toEqual({
    outcome: "violated",
    kind: "property",
    rule: "GoneHolderFreesBaton",
    distinctStates: 420,
  });
  expect(() =>
    parseTlcResult(13, temporal, config + "PROPERTY EventuallyStops\n"),
  ).toThrow("Unexpected TLC result");
});

test("rejects config errors, incomplete runs, and inconsistent exit codes", () => {
  expect(() => parseTlcResult(151, invalid, "")).toThrow("MachineGuard");
  expect(() => parseTlcResult(0, passing.split("Finished in")[0], "")).toThrow(
    "Unexpected TLC result",
  );
  expect(() => parseTlcResult(0, invariant, "")).toThrow(
    "Unexpected TLC result",
  );
});
