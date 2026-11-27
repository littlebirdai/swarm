import { expect, spyOn, test } from "bun:test";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import type { FunctionArgs } from "convex/server";
import { act } from "react";
import { FencedObservedTurnFeeder } from "../../hooks/use-sync-fenced-prompt-addresses";
import {
  createComposerMount,
  owner,
} from "../../test-helpers/composer-control-fixture";
import { mountWeb } from "../../test-helpers/mountWeb";
import { pending } from "../../test-helpers/testConvex";

const conversation = "t".repeat(32) as Id<"conversations">;
const feed = api.permissions.getFencedPromptFeed;
const turn = { id: "current-turn", run: 4, start_event_seq: 19 };
const row = {
  _id: conversation,
  observed_turn: turn,
  lease_remaining_ms: 30_000,
};
const emptyFeed = { prompts: [], turn: null };
const activeFeed = { prompts: [], turn: row };
const mountComposer = createComposerMount(mountWeb);

function Surface({
  feeding = true,
  agentStatus = "working",
}: {
  feeding?: boolean;
  agentStatus?: "working" | "idle";
}) {
  return (
    <>
      {feeding && <FencedObservedTurnFeeder conversationId={conversation} />}
      {owner(conversation, undefined, { agentStatus })}
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
          ? {
              prompts: [],
              turn: {
                ...row,
                observed_turn: { id: "previous", run: 3, start_event_seq: 8 },
              },
            }
          : emptyFeed,
      );
    },
  });
  try {
    await ui.type("Hello from the composer");
    if (enabled) await act(async () => ui.backend.set(feed, activeFeed));
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

test.each([
  "expired lease",
  "remount without a push",
  "ended turn",
  "query error",
] as const)("Enter sends ordinarily after %s", async (scenario) => {
  let now = 200_000;
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  const ui = await mountComposer(<Surface />, {
    setup(backend) {
      backend.set(feed, activeFeed);
    },
  });
  try {
    expect(ui.store.getState().fencedObservedTurns[conversation]).toMatchObject(
      {
        observed_turn: turn,
        local_lease_deadline: now + row.lease_remaining_ms,
      },
    );
    if (scenario === "expired lease") now += row.lease_remaining_ms;
    else if (scenario === "remount without a push") {
      await ui.rerender(<Surface feeding={false} />);
      ui.backend.set(feed, pending);
      await ui.rerender(<Surface />);
    } else {
      await act(async () =>
        ui.backend.set(
          feed,
          scenario === "ended turn" ? emptyFeed : new Error("feed unavailable"),
        ),
      );
    }
    await ui.type("No active turn to steer");
    await ui.press("Enter");
    expect(
      ui.backend.mutations
        .filter((entry) => entry.name === "dispatch:dispatch")
        .map((entry) => entry.args)
        .filter((args: any) => args.action === "sendMessage"),
    ).toEqual([expect.objectContaining({ result: null })]);
  } finally {
    clock.mockRestore();
    await ui.close();
  }
});

test("a queued draft drains without observing the active turn", async () => {
  const ui = await mountComposer(<Surface />, {
    setup(backend, store) {
      backend.set(feed, activeFeed);
      store.setQueuedMessagesFor(conversation, ["Queued before the switch"]);
    },
  });
  try {
    expect(
      ui.store.getState().fencedObservedTurns[conversation]?.observed_turn,
    ).toEqual(turn);
    await ui.rerender(<Surface agentStatus="idle" />);
    expect(
      ui.backend.mutations
        .filter((entry) => entry.name === "dispatch:dispatch")
        .map((entry) => entry.args)
        .filter((args: any) => args.action === "sendMessage"),
    ).toEqual([
      expect.objectContaining({
        args: [
          conversation,
          "Queued before the switch",
          null,
          expect.any(String),
          null,
          "Queued before the switch",
        ],
        result: null,
      }),
    ]);
  } finally {
    await ui.close();
  }
});
