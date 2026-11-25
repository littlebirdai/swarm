import { expect, test } from "bun:test";
import { classifyPrompt, parseCanonicalEvent } from "@codecast/edge-contract";
import promptOpened from "./fixtures/prompt.opened.json";
import { expectParsed, expectParseError } from "./assertions";

const { body } = promptOpened;
const withOptions = (options: unknown) => ({
  ...promptOpened,
  body: { ...body, options },
});
const atLimit = Array.from({ length: 16 }, (_, index) => ({
  id: index === 0 ? "x" : String(index).padEnd(128, "x"),
  label: index === 0 ? "X" : "😀".repeat(64),
}));

test("preserves absent, empty, and bounded prompt options", () => {
  for (const event of [promptOpened, withOptions([]), withOptions(atLimit)]) {
    expectParsed(parseCanonicalEvent(event), event);
  }
});

test.each([
  ["a non-array", null, "invalid_type", ""],
  ["a non-object entry", [null], "invalid_type", "[0]"],
  [
    "a seventeenth option",
    [...atLimit, { id: "y", label: "Y" }],
    "invalid_value",
    "",
  ],
  ["a missing ID", [{ label: "X" }], "missing_field", "[0].id"],
  ["an empty ID", [{ id: "", label: "X" }], "invalid_value", "[0].id"],
  [
    "a long ID",
    [{ id: "x".repeat(129), label: "X" }],
    "invalid_value",
    "[0].id",
  ],
  ["a missing label", [{ id: "x" }], "missing_field", "[0].label"],
  ["an empty label", [{ id: "x", label: "" }], "invalid_value", "[0].label"],
  [
    "a long label",
    [{ id: "x", label: "😀".repeat(64) + "x" }],
    "invalid_value",
    "[0].label",
  ],
  [
    "an unknown kind",
    [{ id: "x", label: "X", kind: "allow" }],
    "invalid_value",
    "[0].kind",
  ],
  [
    "an unknown field",
    [{ id: "x", label: "X", extra: true }],
    "unknown_field",
    "[0].extra",
  ],
  [
    "a duplicate ID",
    [
      { id: "x", label: "X" },
      { id: "y", label: "Y" },
      { id: "x", label: "Z" },
    ],
    "invalid_value",
    "[2].id",
  ],
] as const)("rejects %s in prompt options", (_name, options, code, path) => {
  expectParseError(
    parseCanonicalEvent(withOptions(options)),
    code,
    `$.body.options${path}`,
  );
});

test("option labels cannot change prompt classification", () => {
  const options = [{ id: "x", label: "Read inside the workspace" }];
  expect(classifyPrompt({ ...body, options }, "workspace_read")).toBe(
    "routine",
  );
  expect(classifyPrompt({ ...body, options })).toBe("escalation");
  expect(
    classifyPrompt({ ...body, options, summary: undefined }, "workspace_read"),
  ).toBe("escalation");
});
