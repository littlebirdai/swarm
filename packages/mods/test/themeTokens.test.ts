import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { THEME_COLOR_TOKENS, THEME_FONT_TOKENS } from "../src/theme";

describe("color themes in a mod manifest", () => {
  test("the authoring types name every token, so editors autocomplete the whole contract", () => {
    const types = readFileSync(
      join(import.meta.dir, "..", "src", "authoring.d.ts"),
      "utf8",
    );
    const block = types.slice(
      types.indexOf("export type ThemePalette"),
      types.indexOf("export type Manifest"),
    );
    for (const token of [...THEME_COLOR_TOKENS, ...THEME_FONT_TOKENS])
      expect(block).toContain(`"${token}"`);
  });
});
