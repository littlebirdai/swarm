import { expect, test } from "bun:test";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import type { FunctionArgs } from "convex/server";
import { act } from "react";
import { FencedPromptAddressesFeeder } from "../../hooks/use-sync-fenced-prompt-addresses";
import {
  createComposerMount,
  owner,
} from "../../test-helpers/composer-control-fixture";
import { mountWeb } from "../../test-helpers/mountWeb";

const conversation = "t".repeat(32) as Id<"conversations">;
const feed = api.permissions.listAnswerablePromptAddresses;
const turn = { id: "current-turn", run: 4, start_event_seq: 19 };
const row = {
  _id: conversation,
  conversation_id: conversation,
  prompts: [],
  observed_turn: turn,
  lease_expires_at: Number.MAX_SAFE_INTEGER,
};
const mountComposer = createComposerMount(mountWeb);

function Surface() {
  return (
    <>
      <FencedPromptAddressesFeeder conversationId={conversation} />
      {owner(conversation, undefined, { agentStatus: "working" })}
    </>
  );
}

test.each([
  ["Enter observes the latest active turn", false, true],
  ["Cmd-Enter queues without a turn", true, true],
  ["flag off preserves the original send arguments", false, false],
] as const)("%s", async (_name, metaKey, enabled) => {
  const ui = await mountComposer(<Surface />, {
    setup(backend) {
      backend.set(
        feed,
        enabled
          ? [
              {
                ...row,
                observed_turn: { id: "previous", run: 3, start_event_seq: 8 },
              },
            ]
          : [],
      );
    },
  });
  try {
    await ui.type("Hello from the composer");
    if (enabled) await act(async () => ui.backend.set(feed, [row]));
    await ui.press("Enter", { metaKey });
    const calls = ui.backend.mutations
      .filter((entry) => entry.name === "dispatch:dispatch")
      .map((entry) => entry.args as FunctionArgs<typeof api.dispatch.dispatch>)
      .filter((args) => ["sendMessage", "queueMessage"].includes(args.action));
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.action).toBe(metaKey ? "queueMessage" : "sendMessage");
    expect(call.args).toEqual(
      metaKey
        ? [
            conversation,
            "Hello from the composer",
            expect.any(String),
            "Hello from the composer",
          ]
        : [
            conversation,
            "Hello from the composer",
            null,
            expect.any(String),
            null,
            "Hello from the composer",
          ],
    );
    expect(call.result).toEqual(
      !metaKey && enabled ? { observed_turn: turn } : null,
    );
  } finally {
    await ui.close();
  }
});
