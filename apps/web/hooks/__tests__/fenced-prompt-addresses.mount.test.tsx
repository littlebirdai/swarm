import { expect, test } from "bun:test";
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
    expect(web.store.getState().fencedPromptAddresses[prompt._id]).toEqual(
      prompt,
    );
    await act(async () => web.backend.set(feed, []));
    expect(web.container.querySelector("output")?.textContent).toBe("sibling");
    expect(
      web.store.getState().fencedPromptAddresses[prompt._id],
    ).toBeUndefined();
  } finally {
    await web.close();
  }
});
