import { expect, test } from "bun:test";

test("single-dot files under Convex have no hyphens in their paths", () => {
  const invalid = Array.from(
    new Bun.Glob("**/*").scanSync({
      cwd: import.meta.dir,
      dot: true,
      onlyFiles: true,
    }),
  ).filter(
    (path) =>
      path.split("/").at(-1)?.split(".").length === 2 && path.includes("-"),
  );
  expect(invalid.sort()).toEqual([]);
});
