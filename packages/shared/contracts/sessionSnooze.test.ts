import { describe, expect, test } from "bun:test";
import { sessionSnoozeUntil } from "./sessionSnooze";

describe("session snooze", () => {
  test("calendar day, week, and month choices preserve local time", () => {
    const start = new Date(2026, 0, 31, 14, 20).getTime();
    for (const [key, month, day] of [
      ["1", 1, 1],
      ["3", 1, 3],
      ["w", 1, 7],
      ["m", 1, 28],
    ] as const) {
      const until = new Date(sessionSnoozeUntil(key, start));
      expect([
        until.getMonth(),
        until.getDate(),
        until.getHours(),
        until.getMinutes(),
      ]).toEqual([month, day, 14, 20]);
    }
  });
});
