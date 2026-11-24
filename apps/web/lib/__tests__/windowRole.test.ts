import { expect, test } from "bun:test";
import { shouldStartWindowStore } from "../windowRole";

test.each([
  ["regular", false, true],
  ["regular", true, true],
  ["spare", false, false],
  ["spare", true, true],
] as const)(
  "%s window with claimed=%s has store access=%s",
  (role, claimed, active) => {
    expect(shouldStartWindowStore(role, claimed)).toBe(active);
  },
);
