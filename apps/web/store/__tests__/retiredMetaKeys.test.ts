import { expect, test } from "bun:test";
import { RETIRED_META_KEYS } from "../idb-cache";
import { META_KEYS } from "../persistence/schema";

test("no retired key is still written to web meta", () => {
  expect(RETIRED_META_KEYS.filter((key) => META_KEYS.has(key))).toEqual([]);
});
