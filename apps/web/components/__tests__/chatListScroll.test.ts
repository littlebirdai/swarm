import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { shouldHoldChatLanding } from "../chat/chatLanding";

const css = readFileSync(new URL("../chat/chat.css", import.meta.url), "utf8");
function rule(selector: string): Record<string, string> {
  const at = css.indexOf(`\n${selector} {`);
  expect(at).toBeGreaterThan(-1);
  const body = css.slice(at + selector.length + 3, css.indexOf("}", at));
  return Object.fromEntries(
    body.split(";").flatMap((declaration) => {
      const colon = declaration.indexOf(":");
      return colon < 0
        ? []
        : [
            [
              declaration.slice(0, colon).trim(),
              declaration.slice(colon + 1).trim(),
            ],
          ];
    }),
  );
}

describe("chat list scrolling", () => {
  test("the scroller is a block, not a flex column that pins with margin-top auto", () => {
    const scroller = rule(".ch-list");
    expect(scroller["overflow-y"]).toBe("auto");
    expect(scroller["display"]).toBeUndefined();
    expect(scroller["flex-direction"]).toBeUndefined();
    expect(scroller["justify-content"]).toBeUndefined();
  });

  test("a short transcript pins to the composer on an inner fill that can grow", () => {
    const fill = rule(".ch-list-fill");
    expect(fill["min-height"]).toBe("100%");
    expect(fill["display"]).toBe("flex");
    expect(fill["flex-direction"]).toBe("column");
    expect(fill["justify-content"]).toBe("flex-end");
    expect(css).not.toMatch(
      /\.ch-thread\s+\.ch-list-fill\s*\{[^}]*justify-content\s*:(?!\s*flex-end\b)/,
    );
    expect(rule(".ch-list-sizer")["margin-top"]).toBeUndefined();
  });

  test("a named row on the tail does not hold the bottom pin", () => {
    expect(shouldHoldChatLanding(-1, 40)).toBe(false);
    expect(shouldHoldChatLanding(39, 40)).toBe(false);
    expect(shouldHoldChatLanding(35, 40)).toBe(false);
    expect(shouldHoldChatLanding(20, 40)).toBe(true);
    expect(shouldHoldChatLanding(0, 3)).toBe(false);
  });
});
