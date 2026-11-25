import { expect, test } from "bun:test";
import { join } from "node:path";

test("the lint baseline keeps the order that bun run lint:prune writes", async () => {
  const baseline = await Bun.file(
    join(import.meta.dir, "../../../lint-baseline.json"),
  ).json();
  const files = Object.keys(baseline);
  expect(files).toEqual([...files].sort());
});
