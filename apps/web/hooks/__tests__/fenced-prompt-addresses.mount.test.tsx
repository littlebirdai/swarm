import { expect, spyOn, test } from "bun:test";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import type { FunctionReturnType } from "convex/server";
import { act } from "react";
import { mountWeb } from "../../test-helpers/mountWeb";
import { useCollectionRows } from "../useCollectionRows";
import {
  FencedObservedTurnFeeder,
  useSyncFencedPromptAddresses,
} from "../use-sync-fenced-prompt-addresses";
import { COLLECTION_STORE_KEYS } from "../../store/clientSyncRegistry";

const feed = api.permissions.getFencedPromptFeed;
type Reply = FunctionReturnType<typeof feed>;
type Row = Reply["prompts"][number];

const conversation = "a".repeat(32) as Id<"conversations">;
const other = "b".repeat(32) as Id<"conversations">;
function row(conversation_id: Id<"conversations">, prompt_id: string): Row {
  const lease_id = conversation_id as string as Id<"run_leases">;
  return {
    _id: JSON.stringify([lease_id, "turn", prompt_id]),
    lease_id,
    conversation_id,
    run: 1,
    turn_id: "turn",
    prompt_id,
    kind: "question",
    questions: [{ id: "question", is_secret: true }],
  };
}

function Feed({ enabled }: { enabled: boolean }) {
  useSyncFencedPromptAddresses(conversation, enabled);
  const rows = useCollectionRows<Row>("fencedPromptAddresses");
  return (
    <output>
      {rows
        .map(({ prompt_id }) => prompt_id)
        .sort()
        .join(",")}
    </output>
  );
}

test("a conversation feed inserts and removes its addresses without dropping other conversations", async () => {
  const sibling = row(other, "sibling");
  const prompt = row(conversation, "ask");
  const web = await mountWeb(<Feed enabled={false} />, {
    authenticated: true,
    setup(backend, store) {
      backend.set(feed, { prompts: [prompt], turn: null });
      store.syncTable("fencedPromptAddresses", [sibling]);
    },
  });
  try {
    expect(web.backend.queryRequests).toEqual([]);
    expect(web.container.querySelector("output")?.textContent).toBe("sibling");
    await web.rerender(<Feed enabled />);
    expect(web.backend.queryRequests).toEqual([
      {
        name: "permissions:getFencedPromptFeed",
        args: { conversation_id: conversation },
      },
    ]);
    expect(web.container.querySelector("output")?.textContent).toBe(
      "ask,sibling",
    );
    expect(web.store.getState().fencedPromptAddresses[prompt._id]).toEqual(
      prompt,
    );
    const before = web.store.getState().fencedPromptAddresses[prompt._id];
    await act(async () =>
      web.backend.set(feed, {
        prompts: [structuredClone(prompt), row(conversation, "new")],
        turn: null,
      }),
    );
    expect(web.container.querySelector("output")?.textContent).toBe(
      "ask,new,sibling",
    );
    expect(web.store.getState().fencedPromptAddresses[prompt._id]).toBe(before);
    const revised = {
      ...prompt,
      questions: [{ id: "second", is_secret: false }],
    };
    await act(async () =>
      web.backend.set(feed, { prompts: [revised], turn: null }),
    );
    expect(web.store.getState().fencedPromptAddresses[prompt._id]).toEqual(
      revised,
    );
    await act(async () => web.backend.set(feed, { prompts: [], turn: null }));
    expect(web.container.querySelector("output")?.textContent).toBe("sibling");
    expect(
      web.store.getState().fencedPromptAddresses[prompt._id],
    ).toBeUndefined();
  } finally {
    await web.close();
  }
});

function PromptAndTurn({ id }: { id: Id<"conversations"> }) {
  return (
    <>
      <Feed enabled />
      <FencedObservedTurnFeeder conversationId={id} />
    </>
  );
}

test("one query feeds prompt rows and an independent memory-only turn row", async () => {
  const prompt = row(conversation, "ask");
  const turn = {
    _id: conversation,
    observed_turn: { id: "turn", run: 1, start_event_seq: 1 },
    lease_remaining_ms: 5000,
  };
  const clock = spyOn(performance, "now").mockReturnValue(1000);
  const web = await mountWeb(<PromptAndTurn id={conversation} />, {
    authenticated: true,
    setup(backend) {
      backend.set(feed, ({ conversation_id }) =>
        conversation_id === conversation
          ? { prompts: [prompt], turn }
          : { prompts: [], turn: null },
      );
    },
  });
  try {
    expect(web.backend.queryRequests).toEqual([
      {
        name: "permissions:getFencedPromptFeed",
        args: { conversation_id: conversation },
      },
    ]);
    expect(COLLECTION_STORE_KEYS).not.toContain("fencedPromptAddresses");
    expect(COLLECTION_STORE_KEYS).not.toContain("fencedObservedTurns");
    expect(web.store.getState().fencedPromptAddresses).toEqual({
      [prompt._id]: prompt,
    });
    expect(web.store.getState().fencedObservedTurns).toEqual({
      [conversation]: {
        _id: conversation,
        observed_turn: turn.observed_turn,
        local_lease_deadline: 6000,
      },
    });
    const observed = web.store.getState().fencedObservedTurns[conversation];
    await act(async () => web.backend.set(feed, { prompts: [], turn }));
    expect(web.store.getState().fencedPromptAddresses).toEqual({});
    expect(web.store.getState().fencedObservedTurns[conversation]).toBe(
      observed,
    );
    await act(async () => web.backend.set(feed, { prompts: [prompt], turn }));
    await web.rerender(<PromptAndTurn id={other} />);
    expect(web.store.getState().fencedObservedTurns).toEqual({});
    expect(web.store.getState().fencedPromptAddresses).toEqual({
      [prompt._id]: prompt,
    });
  } finally {
    clock.mockRestore();
    await web.close();
  }
});
