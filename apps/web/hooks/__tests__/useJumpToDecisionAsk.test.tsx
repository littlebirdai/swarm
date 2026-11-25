import { describe, expect, it } from "bun:test";
import { act } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { webBuilders } from "../../test-helpers/builders";
import { mountWeb } from "../../test-helpers/mountWeb";
import { pending } from "../../test-helpers/testConvex";
import { useJumpToDecisionAsk } from "../useJumpToDecisionAsk";

const { session } = webBuilders("useJumpToDecisionAsk.test.tsx");
const asker = session.build({ title: "Asker", inbox_dismissed_at: 1000 });
const station = session.build({
  title: "Station",
  is_subagent: true,
  parent_conversation_id: "p".repeat(32),
  inbox_killed_at: 1000,
});
const decisionId = "d".repeat(32);
const messageId = "m".repeat(32) as Id<"messages">;

function Probe({ conversationId }: { conversationId: string }) {
  const jump = useJumpToDecisionAsk(conversationId, decisionId, "Ship it?");
  return <button onClick={() => void jump()}>Talk to the session</button>;
}

const mount = (row: typeof asker) =>
  mountWeb(<Probe conversationId={row._id} />, {
    path: "/decisions/sd-1",
    dispatch: true,
    setup: (backend, store) => {
      store.syncTable("sessions", [row]);
      backend.set(api.sessionDecisions.findAskMessage, pending);
      backend.mutation(api.dispatch.dispatch, null);
    },
  });

describe("useJumpToDecisionAsk", () => {
  it("selects and restores the asking session before the server answers", async () => {
    const { backend, container, navigationLog, store } = await mount(asker);
    await act(() => container.querySelector("button")!.click());
    const state = store.getState();
    expect(state.currentSessionId).toBe(asker._id);
    expect(state.viewingDismissedId).toBeNull();
    expect(state.sessions[asker._id].inbox_dismissed_at).toBeNull();
    expect(navigationLog.at(-1)).toEqual({
      action: "push",
      path: `/inbox?s=${asker._id}`,
    });
    expect(state.pendingScrollToMessageId).toBeNull();
    expect(backend.queryRequests).toEqual([
      {
        name: "sessionDecisions:findAskMessage",
        args: { decision_id: decisionId },
      },
    ]);

    await act(async () => {
      backend.set(api.sessionDecisions.findAskMessage, {
        message_id: messageId,
        timestamp: 42,
      });
    });
    expect(store.getState().pendingScrollToMessageId).toBe(messageId);
    expect(store.getState().pendingScrollToMessageTimestamp).toBe(42);
  });

  it("restores and adopts a killed asker from a finished flow station", async () => {
    const { container, store } = await mount(station);
    await act(() => container.querySelector("button")!.click());
    const state = store.getState();
    expect(state.currentSessionId).toBe(station._id);
    expect(state.sessions[station._id].inbox_killed_at).toBeNull();
    expect(state.sessions[station._id].inbox_adopted_at).toBeGreaterThan(0);
  });
});
