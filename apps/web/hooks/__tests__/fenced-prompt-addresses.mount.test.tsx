import { expect, spyOn, test } from "bun:test";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import type { FunctionReturnType } from "convex/server";
import { act } from "react";
import { mountWeb } from "../../test-helpers/mountWeb";
import { useCollectionRows } from "../useCollectionRows";
import { useSyncFencedPromptAddresses } from "../use-sync-fenced-prompt-addresses";

const feed = api.permissions.listAnswerablePromptAddresses;
type Row = FunctionReturnType<typeof feed>[number];

const conversation = "a".repeat(32) as Id<"conversations">;
const other = "b".repeat(32) as Id<"conversations">;
function row(conversation_id: Id<"conversations">, prompt_id: string): Row {
  const lease_id = conversation_id as string as Id<"run_leases">;
  return {
    _id: conversation_id,
    conversation_id,
    lease_remaining_ms: 5000,
    observed_turn: null,
    prompts: [
      {
        _id: JSON.stringify([lease_id, "turn", prompt_id]),
        lease_id,
        conversation_id,
        run: 1,
        turn_id: "turn",
        prompt_id,
        kind: "question",
        questions: [{ id: "question", is_secret: true }],
      },
    ],
  };
}

function Feed({
  enabled,
  id = conversation,
}: {
  enabled: boolean;
  id?: typeof conversation;
}) {
  useSyncFencedPromptAddresses(id, enabled);
  const rows = useCollectionRows<Row>("fencedPromptAddresses");
  return (
    <output>
      {rows
        .flatMap(({ prompts }) => prompts.map(({ prompt_id }) => prompt_id))
        .sort()
        .join(",")}
    </output>
  );
}

test("a conversation feed inserts and removes its addresses without dropping other conversations", async () => {
  const sibling = row(other, "sibling");
  const prompt = row(conversation, "ask");
  const clock = spyOn(performance, "now").mockReturnValue(1000);
  const web = await mountWeb(<Feed enabled={false} />, {
    authenticated: true,
    setup(backend, store) {
      backend.set(feed, [prompt]);
      store.syncTable("fencedPromptAddresses", [sibling]);
    },
  });
  try {
    expect(web.backend.queryRequests).toEqual([]);
    expect(web.container.querySelector("output")?.textContent).toBe("sibling");
    await web.rerender(<Feed enabled />);
    expect(web.backend.queryRequests).toEqual([
      {
        name: "permissions:listAnswerablePromptAddresses",
        args: { conversation_id: conversation },
      },
    ]);
    expect(web.container.querySelector("output")?.textContent).toBe(
      "ask,sibling",
    );
    expect(
      web.store.getState().fencedPromptAddresses[prompt._id],
    ).toMatchObject({ prompts: prompt.prompts, local_lease_deadline: 6000 });
    const before = web.store.getState().fencedPromptAddresses[prompt._id];
    await act(async () => web.backend.set(feed, [structuredClone(prompt)]));
    expect(web.store.getState().fencedPromptAddresses[prompt._id]).toBe(before);
    const revised: Row = {
      ...prompt,
      prompts: prompt.prompts.map((p) => ({
        ...p,
        questions: [{ id: "second", is_secret: false }],
      })),
    };
    await act(async () => web.backend.set(feed, [revised]));
    expect(
      web.store.getState().fencedPromptAddresses[prompt._id],
    ).toMatchObject({ prompts: revised.prompts, local_lease_deadline: 6000 });
    await act(async () => web.backend.set(feed, []));
    expect(web.container.querySelector("output")?.textContent).toBe("sibling");
    expect(
      web.store.getState().fencedPromptAddresses[prompt._id],
    ).toBeUndefined();
  } finally {
    clock.mockRestore();
    await web.close();
  }
});

test("changing conversation clears the old feed row", async () => {
  const prompt = row(conversation, "ask");
  const web = await mountWeb(<Feed enabled />, {
    authenticated: true,
    setup(backend) {
      backend.set(feed, (args) =>
        args.conversation_id === conversation ? [prompt] : [],
      );
    },
  });
  try {
    expect(web.container.querySelector("output")?.textContent).toBe("ask");
    await web.rerender(<Feed enabled id={other} />);
    expect(web.container.querySelector("output")?.textContent).toBe("");
    expect(
      web.store.getState().fencedPromptAddresses[conversation],
    ).toBeUndefined();
  } finally {
    await web.close();
  }
});
