import { expect, test } from "bun:test";
import { passageTables } from "./passageTable.testkit";

test("the mobile passage table is the solver's", () => {
  const { solved, kept } = passageTables("mobile");
  expect(Object.keys(solved).length).toBeGreaterThan(0);
  expect(kept).toEqual(solved);
}, 1_800_000);
