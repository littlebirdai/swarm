import { expect, test } from "bun:test";
import { redactFrame } from "./pane-stream.js";

const begin = "-----BEGIN PRIVATE KEY-----";
const end = "-----END PRIVATE KEY-----";
const keyRows = ["synthetic key row one", "synthetic key row two"];

test.each([
  ["entire", ["above", begin, ...keyRows, end, "below"], ["above", "below"]],
  ["top clipped", [...keyRows, end, "below"], ["below"]],
  ["bottom clipped", ["above", begin, ...keyRows], ["above"]],
] as const)(
  "redacts a PEM key with %s screen content and preserves its rows",
  (_name, rows, neighbors) => {
    const screen = redactFrame(rows.join("\n"), 80);
    expect(screen.split("\n")).toHaveLength(rows.length);
    for (const key of keyRows) expect(screen).not.toContain(key);
    for (const neighbor of neighbors) expect(screen).toContain(neighbor);
  },
);
