import { expect, test } from "bun:test";
import { act } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import "../chat/ChatMessage";
import { mountWeb } from "../../test-helpers/mountWeb";
import { pending } from "../../test-helpers/testConvex";
import { testToasts } from "../../test-helpers/testToasts";
import { MessageInput } from "../MessageInput";

const conversationId = "jx70000000000000000000000sideqst";
const image = {
  storageId: "st_btw_1",
  name: "shot.png",
  type: "image/png",
  previewUrl: "blob:b",
};

async function press(
  text: string,
  input: KeyboardEventInit | "submit",
  { withImage = false, expectSend = false } = {},
) {
  const asked: string[] = [];
  const populate: Parameters<typeof MessageInput>[0]["onPopulateInput"] = {
    current: null,
  };
  let stops = 0;
  const sentToAgent = Promise.withResolvers<void>();
  const { backend, clock, container, store } = await mountWeb(
    <MessageInput
      conversationId={conversationId}
      status="active"
      agentType="claude_code"
      isThinking
      isConversationLive
      onPopulateInput={populate}
      onDidSend={() => sentToAgent.resolve()}
      onSendEscape={() => {
        stops++;
      }}
      onSideQuestion={(question) => {
        asked.push(question);
        return null;
      }}
    />,
    {
      clock: true,
      dispatch: true,
      setup: (backend, store) => {
        if (withImage) {
          store.setDraft(conversationId, {
            draft_message: text,
            draft_image_storage_ids: [image],
          });
        }
        backend.set(api.pendingMessages.getConversationPendingMessage, pending);
        backend.mutation(api.dispatch.dispatch, null);
        backend.set(api.images.getImageUrls, { [image.storageId]: null });
      },
    },
  );
  const toasts = testToasts();
  await act(() => populate.current!(text));
  const field = container.querySelector<HTMLTextAreaElement>(
    "[data-composer-field]",
  )!;
  expect(field.value).toBe(text);
  await act(async () => {
    if (input === "submit") {
      container
        .querySelector("form")!
        .dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
    } else {
      field.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          ...input,
        }),
      );
    }
    if (expectSend) await sentToAgent.promise;
  });
  await clock!.advance(320);
  const sent = [
    ...(store.getState().pendingMessages[conversationId] ?? []),
    ...backend.mutations.filter(
      ({ args }) =>
        args &&
        typeof args === "object" &&
        "action" in args &&
        /send|queue|stop/i.test(String(args.action)),
    ),
  ];
  expect(toasts.events().filter(({ kind }) => kind === "error")).toEqual([]);
  return {
    asked,
    sent,
    stops,
    draft: store.getState().getDraft(conversationId),
  };
}

for (const [name, keys] of [
  ["Enter asks the side question and sends nothing", { key: "Enter" }],
  [
    "⌘↵ asks the side question instead of queueing it",
    { key: "Enter", metaKey: true, ctrlKey: true },
  ],
  [
    "⇧Esc asks the side question and stops nothing",
    { key: "Escape", shiftKey: true },
  ],
] as const) {
  test(name, async () => {
    const { asked, sent, stops } = await press("/btw why 8 retries?", keys);
    expect(asked).toEqual(["why 8 retries?"]);
    expect(sent).toEqual([]);
    expect(stops).toBe(0);
  });
}

test("a /btw that does not open the message is for the agent", async () => {
  const { asked, sent } = await press(
    "check this /btw thing",
    { key: "Enter" },
    { expectSend: true },
  );
  expect(asked).toEqual([]);
  expect(sent.length).toBeGreaterThan(0);
});

test("pasted images stay in the draft after a side question", async () => {
  const { asked, draft, sent, stops } = await press(
    "/btw what is this?",
    "submit",
    {
      withImage: true,
    },
  );
  expect(asked).toEqual(["what is this?"]);
  expect(sent).toEqual([]);
  expect(stops).toBe(0);
  expect(draft?.draft_image_storage_ids?.[0]).toMatchObject({
    storageId: image.storageId,
  });
  expect(draft?.draft_message ?? null).toBeNull();
});
