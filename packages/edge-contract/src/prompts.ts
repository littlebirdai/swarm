import {
  array,
  boolean,
  boundedText,
  EdgeParseError,
  nonEmptyString,
  object,
  oneOf,
  optional,
  type Reader,
} from "./parse";

function boundedList<T>(readItem: Reader<T>, maxItems: number): Reader<T[]> {
  const read = array(readItem);
  return (value, path) => {
    if (Array.isArray(value) && value.length > maxItems) {
      throw new EdgeParseError(
        "invalid_value",
        path,
        `expected at most ${maxItems} entries`,
      );
    }
    return read(value, path);
  };
}

const readRuleRequest = object({
  permission: boundedText(80),
  patterns: boundedList(boundedText(32_000, true), 32),
  always: boundedList(boundedText(1_000, true), 8),
  opaque: optional(boolean),
});

const boundedOptionText = boundedText(128, true);
const readOptionText: Reader<string> = (value, path) =>
  boundedOptionText(nonEmptyString(value, path), path);

const readOptions = boundedList(
  object({
    id: readOptionText,
    label: readOptionText,
    kind: optional(
      oneOf("allow_once", "allow_always", "reject_once", "reject_always"),
    ),
  }),
  16,
);

const readSummary: Reader<string> = (value, path) => {
  const summary = boundedText(500)(value, path);
  if (/[\r\n\u0085\u2028\u2029]/u.test(summary)) {
    throw new EdgeParseError("invalid_value", path, "expected a single line");
  }
  return summary;
};

export const readPromptOpened = object({
  prompt_id: nonEmptyString,
  kind: nonEmptyString,
  tool_call_id: optional(boundedText(256)),
  tool_name: optional(boundedText(128)),
  rule_request: optional((value, path) => {
    const request = readRuleRequest(value, path);
    const opaqueCall =
      request.opaque &&
      request.patterns.length === 1 &&
      request.always.length === 0;
    if (
      !opaqueCall &&
      request.patterns.some((pattern) => pattern.length > 1_000)
    ) {
      throw new EdgeParseError(
        "invalid_value",
        `${path}.patterns`,
        "expected patterns of at most 1000 code units",
      );
    }
    return request;
  }),
  summary: optional(readSummary),
  options: optional((value, path) => {
    const options = readOptions(value, path);
    const ids = new Set<string>();
    for (const [index, { id }] of options.entries()) {
      if (ids.has(id)) {
        throw new EdgeParseError(
          "invalid_value",
          `${path}[${index}].id`,
          "expected a unique option ID",
        );
      }
      ids.add(id);
    }
    return options;
  }),
});

export type PromptOpened = ReturnType<typeof readPromptOpened>;

export function classifyPrompt(
  prompt: PromptOpened,
  verifiedKind?: "workspace_read" | "question",
): "routine" | "escalation" {
  const { kind, summary, rule_request, tool_call_id, tool_name } = prompt;
  if (!summary?.trim() || rule_request?.opaque) return "escalation";
  if (verifiedKind === "question" && kind === "question") return "routine";
  if (
    verifiedKind === "workspace_read" &&
    kind === "permission" &&
    tool_call_id &&
    tool_name &&
    rule_request?.permission === "read" &&
    rule_request.patterns.length > 0 &&
    rule_request.patterns.every((pattern) => pattern.trim().length > 0)
  ) {
    return "routine";
  }
  return "escalation";
}
