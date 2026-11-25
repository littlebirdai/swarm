import { expect, test } from "bun:test";
import { api } from "@codecast/convex/convex/_generated/api";
import { pending } from "../../test-helpers/testConvex";
import { act } from "react";
import "../chat/ChatMessage";
import { mountWeb } from "../../test-helpers/mountWeb";
import { testToasts } from "../../test-helpers/testToasts";
import { MessageInput } from "../message-input";

const conversationId = "jx70000000000000000000000escstop";

async function doubleEscape(running: boolean) {
  let stops = 0;
  let maps = 0;
  const { container, clock } = await mountWeb(
    <MessageInput
      conversationId={conversationId}
      status="active"
      agentType="claude_code"
      agentStatus={running ? undefined : "idle"}
      isThinking={running}
      isConversationLive={running}
      onSendEscape={() => {
        stops++;
      }}
      onOpenNavigator={() => {
        maps++;
      }}
    />,
    {
      clock: true,
      setup: (backend) =>
        backend.set(api.pendingMessages.getConversationPendingMessage, pending),
    },
  );
  const toasts = testToasts();
  const textarea = container.querySelector("textarea")!;
  const escape = () =>
    act(() => {
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
  await escape();
  await escape();
  await clock!.advance(320);
  expect(toasts.events()).toEqual([]);
  return { stops, maps };
}

test("a double Escape during a running turn stops it once and opens no map", async () => {
  expect(await doubleEscape(true)).toEqual({ stops: 1, maps: 0 });
});

test("a double Escape at rest opens the branch map and stops nothing", async () => {
  expect(await doubleEscape(false)).toEqual({ stops: 0, maps: 1 });
});
