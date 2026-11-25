import { expect, test } from "bun:test";
import { act } from "react";
import { AgentDock } from "../../components/agentDock/agent-dock";
import { webBuilders } from "../../test-helpers/builders";
import { SessionPrewarm } from "../../components/session-prewarm";
import { useInboxStore } from "../../store/inboxStore";
import { MESSAGE_CACHE_BUDGET_BYTES } from "../../store/store-eviction";
import { mountWeb } from "../../test-helpers/mountWeb";
import { useConversationMessages } from "../use-conversation-messages";

const sessionId = "cache-view-stub";
const reserveId = "cache-reserve-stub";

function Transcript() {
  useConversationMessages(sessionId);
  return null;
}

test.each([
  ["mounted transcript", <Transcript key="transcript" />, true],
  [
    "background prewarm",
    <SessionPrewarm key="prewarm" sessionId={sessionId} />,
    false,
  ],
] as const)(
  "%s retains messages only while they are on screen",
  async (_label, node, retained) => {
    const mounted = await mountWeb(node, {
      setup: (_backend, store) => {
        store.setMessages(
          sessionId,
          [
            {
              _id: "line",
              role: "assistant",
              content: "visible",
              timestamp: 1,
            },
          ],
          {},
          "cache",
        );
        useInboxStore.setState({
          queuedMessages: { [reserveId]: ["pending"] },
        });
      },
    });
    try {
      await act(async () => {
        useInboxStore.getState().setMessages(
          reserveId,
          [
            {
              _id: "reserve",
              role: "assistant",
              content: "a".repeat(MESSAGE_CACHE_BUDGET_BYTES / 2),
              timestamp: 2,
            },
          ],
          {},
          "cache",
        );
      });
      expect(Boolean(useInboxStore.getState().messages[sessionId])).toBe(
        retained,
      );
      await mounted.rerender(null);
      expect(useInboxStore.getState().messages[sessionId]).toBeUndefined();
    } finally {
      await mounted.close();
    }
  },
);

test("the open agent dock keeps its visible reply under cache pressure", async () => {
  const now = Date.now();
  const dockSession = webBuilders(
    "message-cache-view.mount.test.tsx",
  ).session.build({
    _id: sessionId,
    title: "Cache test agent",
    user_id: "cache-user",
    owner_user_id: "cache-user",
    owned_by_me: true,
    agent_status: "done",
    updated_at: now - 60_000,
    agent_status_updated_at: now - 60_000,
    started_at: now - 70_000,
    message_count: 1,
  });
  const mounted = await mountWeb(<AgentDock />, {
    setup: (_backend, store) => {
      useInboxStore.setState({
        currentUser: { _id: "cache-user" },
        queuedMessages: { [reserveId]: ["pending"] },
      });
      store.seedSession(dockSession);
      store.setMessages(
        sessionId,
        [
          {
            _id: "reply",
            role: "assistant",
            content: "The dock reply stays visible.",
            timestamp: 1,
          },
        ],
        {},
        "cache",
      );
    },
  });
  try {
    const dot = mounted.container.querySelector<HTMLButtonElement>(
      'button[title="Cache test agent"]',
    );
    expect(dot).not.toBeNull();
    await act(async () => dot!.click());
    expect(mounted.container.textContent).toContain(
      "The dock reply stays visible.",
    );
    await act(async () => {
      useInboxStore.getState().setMessages(
        reserveId,
        [
          {
            _id: "reserve",
            role: "assistant",
            content: "a".repeat(MESSAGE_CACHE_BUDGET_BYTES / 2),
            timestamp: 2,
          },
        ],
        {},
        "cache",
      );
    });
    expect(mounted.container.textContent).toContain(
      "The dock reply stays visible.",
    );
  } finally {
    await mounted.close();
  }
});
