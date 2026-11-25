import { expect, test } from "bun:test";
import {
  classifyPrompt,
  parseCanonicalEvent,
  parseCommandsNextResponse,
} from "@codecast/edge-contract";
import commandsNext from "./fixtures/commands.next.json";
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

test("preserves absent and bounded prompt options", () => {
  for (const event of [
    promptOpened,
    withOptions(atLimit.slice(0, 1)),
    withOptions(atLimit),
  ]) {
    expectParsed(parseCanonicalEvent(event), event);
  }
});

test.each([
  ["a non-array", null, "invalid_type", ""],
  ["a non-object entry", [null], "invalid_type", "[0]"],
  ["an empty list", [], "invalid_value", ""],
  [
    "a seventeenth option",
    [...atLimit, { id: "y", label: "Y" }],
    "invalid_value",
    "",
  ],
  ["a missing ID", [{ label: "X" }], "missing_field", "[0].id"],
  ["an empty ID", [{ id: "", label: "X" }], "invalid_value", "[0].id"],
  ["a blank ID", [{ id: " \t", label: "X" }], "invalid_value", "[0].id"],
  [
    "a long ID",
    [{ id: "x".repeat(129), label: "X" }],
    "invalid_value",
    "[0].id",
  ],
  ["a missing label", [{ id: "x" }], "missing_field", "[0].label"],
  ["an empty label", [{ id: "x", label: "" }], "invalid_value", "[0].label"],
  ["a blank label", [{ id: "x", label: " \t" }], "invalid_value", "[0].label"],
  [
    "a multiline label",
    [{ id: "x", label: "First\u2028Second" }],
    "invalid_value",
    "[0].label",
  ],
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

test.each(["allow_once", "allow_always"] as const)(
  "option labels and %s cannot change prompt classification",
  (kind) => {
    const options = [{ id: "x", label: "Read inside the workspace", kind }];
    expect(classifyPrompt({ ...body, options }, "workspace_read")).toBe(
      "routine",
    );
    expect(classifyPrompt({ ...body, options })).toBe("escalation");
    expect(
      classifyPrompt(
        { ...body, options, summary: undefined },
        "workspace_read",
      ),
    ).toBe("escalation");
  },
);

const commandWithAnswer = (answer: unknown) => ({
  ...commandsNext.response,
  name: "prompt_answer",
  args: { answer },
});
const settlementWithAnswer = (answer: unknown) => ({
  ...promptOpened,
  kind: "prompt.settled",
  body: {
    prompt_id: body.prompt_id,
    by: { kind: "person", id: "person-1" },
    answer,
  },
});

test("preserves option selections and free text with the same ID", () => {
  for (const answer of [
    "allow-once",
    { option_id: "allow-once" },
    { allow: true },
    null,
  ]) {
    const command = commandWithAnswer(answer);
    const event = settlementWithAnswer(answer);
    expectParsed(parseCommandsNextResponse(command), command);
    expectParsed(parseCanonicalEvent(event), event);
  }
});

test.each([
  ["a numeric ID", { option_id: 1 }, "invalid_type", "option_id"],
  ["a blank ID", { option_id: " \t" }, "invalid_value", "option_id"],
  ["a long ID", { option_id: "x".repeat(129) }, "invalid_value", "option_id"],
  ["an extra field", { option_id: "x", extra: true }, "unknown_field", "extra"],
] as const)(
  "rejects an option selection with %s",
  (_name, answer, code, field) => {
    expectParseError(
      parseCommandsNextResponse(commandWithAnswer(answer)),
      code,
      `$.args.answer.${field}`,
    );
    expectParseError(
      parseCanonicalEvent(settlementWithAnswer(answer)),
      code,
      `$.body.answer.${field}`,
    );
  },
);

test("preserves JSON args for commands other than prompt answers", () => {
  const command = {
    ...commandsNext.response,
    args: { answer: { option_id: 1 } },
  };
  expectParsed(parseCommandsNextResponse(command), command);
});
