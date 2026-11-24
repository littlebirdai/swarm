import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Modern's send button is a solid accent with a page-colour arrow, but it
// keeps Classic's `text-sol-blue bg-sol-blue/20` beside its modern: classes.
// The rule that deepens accent text on its own tint once matched that pair
// and outranked modern:text-sol-bg, so the arrow turned dark blue on teal.
// Every such rule must step aside for an element Modern colours itself.
test("the accent-on-tint rules skip elements with their own Modern text colour", () => {
  const css = readFileSync(
    join(import.meta.dir, "..", "..", "app", "globals.css"),
    "utf8",
  );
  const rules =
    css.match(
      /^\.modern-style\S*\s+\.text-sol-\w+\[class\*="bg-sol-\w+\/"\][^{]+/gm,
    ) ?? [];
  expect(rules.length).toBeGreaterThan(0);
  for (const rule of rules)
    expect(rule).toMatch(/:not\(\s*\[class\*="modern:text-sol-"\]/);
  expect(css).not.toMatch(
    /:is\(\.text-sol-\w+, \.modern\\:text-sol-\w+\)\[class\*="bg-sol-/,
  );
});
