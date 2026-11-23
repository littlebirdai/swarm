import { expect, test } from "bun:test";
import { windowStorePolicy } from "../windowRole";

test.each([
  ["regular", false, true],
  ["regular", true, true],
  ["spare", false, false],
  ["spare", true, true],
] as const)("%s window with claimed=%s has store access=%s", (role, claimed, active) => {
  expect(windowStorePolicy(role, claimed)).toEqual({ mayHost: active, shouldHydrate: active });
});
