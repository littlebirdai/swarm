import { expect, test } from "bun:test";
import { createTransitionGate } from "./transition-gate";

test("a failing transition does not strand the transitions queued behind it", () => {
  const gate = createTransitionGate();
  const ran: string[] = [];
  expect(() =>
    gate.run(() => {
      gate.run(() => {
        ran.push("queued");
      });
      throw new Error("first step failed");
    }),
  ).toThrow("first step failed");
  expect(ran).toEqual(["queued"]);
  gate.run(() => ran.push("later"));
  expect(ran).toEqual(["queued", "later"]);
});

test("close and disable are never dropped from a full queue", () => {
  const gate = createTransitionGate();
  const ran: string[] = [];
  gate.run(() => {
    for (let i = 0; i < 100; i++) gate.run(() => ran.push("routine"));
    gate.run(() => ran.push("close"), { essential: true });
  });
  expect(ran.filter((step) => step === "routine")).toHaveLength(64);
  expect(ran.at(-1)).toBe("close");
});
