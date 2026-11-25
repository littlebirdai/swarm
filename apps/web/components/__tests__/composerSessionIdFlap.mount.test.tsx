import { expect, test } from "bun:test";
import { act } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import "../chat/ChatMessage";
import { mountWeb } from "../../test-helpers/mountWeb";
import { pending } from "../../test-helpers/testConvex";
import { testToasts } from "../../test-helpers/testToasts";
import { MessageInput } from "../MessageInput";

test("words typed while the session id was unset survive its return", async () => {
  const conversationId = "jx70000000000000000000000flap01".padEnd(32, "x");
  const sessionId = "5d8d74d7-3c4d-4caf-9ef0-3c64122a9726";
  const composer = (sid?: string) => (
    <MessageInput
      key={sid ?? conversationId}
      conversationId={conversationId}
      sessionId={sid}
      status="active"
      agentType="claude_code"
    />
  );
  const { container, rerender } = await mountWeb(composer(sessionId), {
    dispatch: true,
    setup: (backend) => {
      backend.set(api.pendingMessages.getConversationPendingMessage, pending);
      backend.mutation(api.dispatch.dispatch, null);
    },
  });
  const toasts = testToasts();
  const textarea = () => container.querySelector("textarea")!;
  const type = (text: string) =>
    act(() => {
      const input = textarea();
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      for (const character of text) {
        setValue.call(input, input.value + character);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });

  await type("fix the");
  await rerender(composer());
  expect(textarea().value).toBe("fix the");
  await type(" login bug");
  await rerender(composer(sessionId));
  expect(textarea().value).toBe("fix the login bug");
  expect(toasts.events()).toEqual([]);
});
