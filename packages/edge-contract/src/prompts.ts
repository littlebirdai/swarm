import {
  array,
  boolean,
  EdgeParseError,
  nonEmptyString,
  object,
  optional,
  string,
  type Reader,
} from "./parse";

function boundedText(maxLength: number, allowBlank = false): Reader<string> {
  return (value, path) => {
    const text = string(value, path);
    if (text.length > maxLength || (!allowBlank && !text.trim())) {
      throw new EdgeParseError(
        "invalid_value",
        path,
        `expected ${allowBlank ? "text" : "non-blank text"} of at most ${maxLength} code units`,
      );
    }
    return text;
  };
}

function boundedPatterns(
  maxItems: number,
  maxLength: number,
): Reader<string[]> {
  const read = array(boundedText(maxLength, true));
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
  patterns: boundedPatterns(32, 32_000),
  always: boundedPatterns(8, 1_000),
  opaque: optional(boolean),
});

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
});

export type PromptOpened = ReturnType<typeof readPromptOpened>;

export function classifyPrompt(
  prompt: PromptOpened,
  verifiedKind?: "workspace_read" | "question",
): "routine" | "escalation" {
  const { summary, rule_request, tool_call_id, tool_name } = prompt;
  if (!summary || rule_request?.opaque) return "escalation";
  if (verifiedKind === "question") return "routine";
  if (
    verifiedKind === "workspace_read" &&
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
