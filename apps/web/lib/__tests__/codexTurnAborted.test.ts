import { test, expect, describe } from "bun:test";
import { classifyUserMessage } from "../../components/conversation/classify";
import {
  isCodexTurnAbortedMessage,
  isNoiseUserMessage,
} from "../conversationProcessor";

// Regression: a Codex conversation switched to Claude rendered its earlier
// `<turn_aborted>` notices as ordinary user bubbles, because the renderer only
// treated the tag as an interrupt when the conversation's CURRENT agent_type
// was codex. The tag is unambiguous on its own, so no path may gate it on the
// conversation's agent.
const notice =
  "<turn_aborted>\nThe user interrupted the previous turn on purpose. Any running unified exec processes may still be running in the background. If any tools/commands were aborted, they may have partially executed.\n</turn_aborted>";

describe("isCodexTurnAbortedMessage", () => {
  test("recognizes the notice from the message alone", () => {
    expect(isCodexTurnAbortedMessage(notice)).toBe(true);
    expect(isCodexTurnAbortedMessage("  " + notice)).toBe(true);
    expect(isCodexTurnAbortedMessage(notice.slice(0, 40))).toBe(true);
    expect(isNoiseUserMessage(notice)).toBe(true);
  });

  test("does not match a person mentioning the tag mid-message", () => {
    expect(
      isCodexTurnAbortedMessage("why does <turn_aborted> render as text?"),
    ).toBe(false);
    expect(isCodexTurnAbortedMessage("")).toBe(false);
    expect(isCodexTurnAbortedMessage(null)).toBe(false);
  });
});

test.each(["claude_code", "codex", undefined])(
  "a Codex turn-aborted notice still renders as an interrupt with agent %s",
  (agentType) => {
    const message = { _id: "m", role: "user", timestamp: 1, content: notice };
    expect(classifyUserMessage(message, agentType)).toEqual({
      kind: "interrupt",
      tone: "amber",
    });
    expect(
      classifyUserMessage(
        {
          ...message,
          content: "why does <turn_aborted> render as text?",
        },
        agentType,
      ),
    ).toEqual({ kind: "normal" });
  },
);
