import { afterAll, expect, mock, test } from "bun:test";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import type { Message } from "../../store/inboxStore";
import { api } from "@codecast/convex/convex/_generated/api";
import { act, type ComponentProps } from "react";
import { WARM_DEEP_ROWS } from "../../hooks/inboxWarm";
import { webBuilders } from "../../test-helpers/builders";
import { ConversationLayoutStandIn } from "../../test-helpers/ConversationLayoutStandIn";
import { expectPresent } from "../../test-helpers/domExpect";
import { mountWeb } from "../../test-helpers/mountWeb";
import { pending } from "../../test-helpers/testConvex";
import type { ConversationDiffLayout } from "../ConversationDiffLayout";

type LayoutProps = ComponentProps<typeof ConversationDiffLayout>;
let rendered: LayoutProps | undefined;
const layout = { ...(await import("../ConversationDiffLayout")) };
mock.module("../ConversationDiffLayout", () => ({
  ...layout,
  ConversationDiffLayout: (props: LayoutProps) => {
    rendered = props;
    return (
      <div
        data-target={props.targetMessageId ?? ""}
        data-nonce={props.targetNonce ?? ""}
      >
        <ConversationLayoutStandIn {...props} />
      </div>
    );
  },
}));
afterAll(() => mock.module("../ConversationDiffLayout", () => layout));
const { AnchorConversation } = await import("./AnchorConversation");

type Props = ComponentProps<typeof AnchorConversation>;
const noSince: "since" extends keyof Props ? never : true = true;
void noSince;
const { session: sessions, message } = webBuilders(
  "AnchorConversation.jump.mount.test.tsx",
);
const session = sessions.build({ message_count: 3 });
const target = message.build({
  content: "op-7",
  role: "assistant",
  timestamp: 50,
});
const setupRow = message.build({
  content: "Here is the review.",
  role: "assistant",
  timestamp: 49,
});
const earlier = message.build({
  content: "An earlier note",
  role: "assistant",
  timestamp: 48,
});
const decoy = message.build({
  content: "op-7 looks fine",
  role: "user",
  timestamp: 51,
});
const live = {
  ...message.build({ content: "Latest reply", timestamp: 60 }),
  role: "assistant" as const,
};
function messageWindow(messages: Message[], hasMoreBelow = false) {
  return {
    messages,
    oldest_timestamp: messages[0]?.timestamp ?? null,
    last_timestamp: messages.at(-1)?.timestamp ?? null,
    has_more_above: false,
    has_more_below: hasMoreBelow,
  };
}

const around = api.conversations.getMessagesAroundTimestamp;

const view = (jump: Props["jump"]) => (
  <AnchorConversation conversationId={session._id} hideHeader jump={jump} />
);
const mount = (jump?: Props["jump"], finding = false) =>
  mountWeb(view(jump), {
    setup(backend, store) {
      store.syncTable("sessions", [session]);
      store.setMessages(session._id, [live], {
        initialized: true,
        hasMoreAbove: false,
      });
      backend.set(api.conversations.listMessages, {
        page: [
          {
            ...live,
            _id: live._id as Id<"messages">,
            _creationTime: live.timestamp,
            conversation_id: session._id as Id<"conversations">,
          },
        ],
        isDone: true,
        continueCursor: "",
      });
      backend.set(api.conversations.listMessagesTail, pending);
      backend.set(api.conversations.getConversationWithMeta, pending);
      backend.set(api.conversations.getTranscriptWatermark, pending);
      backend.set(api.conversations.getUserMessages, pending);
      backend.set(
        api.messages.getMessageTimestamp,
        ({ conversation_id, message_id }) =>
          conversation_id === session._id
            ? message_id === target._id
              ? { timestamp: target.timestamp }
              : message_id === live._id
                ? { timestamp: live.timestamp }
                : null
            : null,
      );
      backend.set(
        around,
        ({ conversation_id, center_timestamp, limit_before }) => {
          if (conversation_id !== session._id) return null;
          if (finding && limit_before === 0) return pending;
          if (finding) return messageWindow([earlier, setupRow], true);
          if (center_timestamp === target.timestamp)
            return messageWindow([setupRow, target, decoy]);
          return messageWindow([setupRow]);
        },
      );
    },
  });
type Mount = Awaited<ReturnType<typeof mount>>;
const calls = (web: Mount, name: string) =>
  web.backend.queryRequests
    .filter((call) => call.name === name)
    .map((call) => call.args);
const windows = (web: Mount) =>
  calls(web, "conversations:getMessagesAroundTimestamp");
function checkTarget(web: Mount, id?: string, nonce?: number) {
  const node = web.container.querySelector("[data-target]");
  expectPresent(node);
  expect(node.getAttribute("data-target")).toBe(id ?? "");
  expect(node.getAttribute("data-nonce")).toBe(
    nonce === undefined ? "" : String(nonce),
  );
}
const mode = (web: Mount) =>
  web.container
    .querySelector("[data-conv-target-mode]")
    ?.getAttribute("data-conv-target-mode");

test("a jump to a message reaches the hook as the target and nonce, and the layout", async () => {
  const web = await mount({ messageId: target._id, nonce: 1 });
  expect(calls(web, "messages:getMessageTimestamp")).toEqual([
    { conversation_id: session._id, message_id: target._id },
  ]);
  expect(windows(web)).toEqual([
    {
      conversation_id: session._id,
      center_timestamp: 50,
      limit_before: 50,
      limit_after: 50,
    },
  ]);
  checkTarget(web, target._id, 1);
});

test("a jump to a time calls jumpToTimestamp once, and again only on a new nonce", async () => {
  const web = await mount({ timestamp: 5, nonce: 2 });
  const first = {
    conversation_id: session._id,
    center_timestamp: 5,
    limit_before: 50,
    limit_after: 50,
  };
  expect(windows(web)).toEqual([first]);
  expect(calls(web, "messages:getMessageTimestamp")).toEqual([]);
  checkTarget(web, undefined, 2);
  await web.rerender(view({ timestamp: 6, nonce: 2 }));
  expect(windows(web)).toEqual([first]);
  await web.rerender(view({ timestamp: 7, nonce: 3 }));
  expect(windows(web)).toEqual([first, { ...first, center_timestamp: 7 }]);
  await web.rerender(view(null));
  checkTarget(web);
  expect(windows(web)).toHaveLength(2);
  expect(calls(web, "messages:getMessageTimestamp")).toEqual([]);
});

test("a timestamp jump finds the card on the next page, under the same nonce, without re-arming the hook", async () => {
  const web = await mount({ timestamp: 9, find: "op-7", nonce: 4 }, true);
  checkTarget(web, undefined, 4);
  expect(windows(web)).toEqual([
    {
      conversation_id: session._id,
      center_timestamp: 9,
      limit_before: 50,
      limit_after: 50,
    },
    {
      conversation_id: session._id,
      center_timestamp: setupRow.timestamp,
      limit_before: 0,
      limit_after: WARM_DEEP_ROWS,
    },
  ]);
  await act(async () => {
    web.backend.set(around, ({ limit_before }) =>
      limit_before === 0
        ? messageWindow([target, decoy])
        : messageWindow([earlier, setupRow], true),
    );
  });
  checkTarget(web, target._id, 4);
  expect(calls(web, "messages:getMessageTimestamp")).toEqual([]);
  expect(windows(web)).toHaveLength(2);
});

test("a message sent from the embed ends the request and jumps to the live tail; the next nonce arms again", async () => {
  const jump = { messageId: target._id, nonce: 5 };
  const web = await mount(jump);
  checkTarget(web, target._id, 5);
  await act(async () => {
    web.store.getState().addOptimisticMessage(session._id, "Approve it");
  });
  checkTarget(web);
  expect(mode(web)).toBe("live");
  expect(
    rendered?.conversation.messages.some((row) => row._id === live._id),
  ).toBe(true);
  await web.rerender(view(jump));
  checkTarget(web);
  await web.rerender(view({ ...jump, nonce: 6 }));
  checkTarget(web, target._id, 6);
  expect(mode(web)).toBe("target");
});

test("a send from a timestamp window returns to the live row only while a jump request is active", async () => {
  const web = await mount({ timestamp: 5, nonce: 9 });
  const send = (content: string) =>
    act(async () => {
      web.store.getState().addOptimisticMessage(session._id, content);
    });
  const rows = () => rendered?.conversation.messages.map(({ _id }) => _id);
  expect(mode(web)).toBe("target");
  expect(rows()).toContain(setupRow._id);
  expect(rows()).not.toContain(live._id);

  await send("Approve it");
  checkTarget(web);
  expect(mode(web)).toBe("live");
  expect(rows()).toContain(live._id);
  expect(rows()).not.toContain(setupRow._id);

  const jumpToTimestamp = rendered?.onJumpToTimestamp;
  if (!jumpToTimestamp) throw new Error("The layout has no timestamp jump");
  await act(async () => jumpToTimestamp(6));
  expect(mode(web)).toBe("target");
  expect(rows()).toContain(setupRow._id);
  await send("One more note");
  expect(mode(web)).toBe("target");
  expect(rows()).toContain(setupRow._id);
  expect(rows()).not.toContain(live._id);
});

test("consecutive nonces reopen the same message after the reader jumps to the end", async () => {
  const jump = { messageId: target._id, nonce: 20 };
  const web = await mount(jump);
  expect(mode(web)).toBe("target");
  const jumpToEnd = rendered?.onJumpToEnd;
  if (!jumpToEnd) throw new Error("The layout has no end jump");
  await act(async () => jumpToEnd());
  expect(mode(web)).toBe("live");
  checkTarget(web, target._id, 20);

  await web.rerender(view({ ...jump, nonce: 21 }));
  checkTarget(web, target._id, 21);
  expect(mode(web)).toBe("target");
  expect(rendered?.conversation.messages.map(({ _id }) => _id)).toContain(
    target._id,
  );
});

test("the request's onSettled runs once when the view settles its nonce, never for another nonce or a replaced request", async () => {
  const settled: number[] = [];
  const jump = {
    messageId: target._id,
    nonce: 7,
    onSettled: () => settled.push(7),
  };
  const web = await mount(jump);
  expect(typeof rendered?.onTargetSettled).toBe("function");
  const settle = (id: string, nonce: number) =>
    act(async () => rendered?.onTargetSettled?.(id, nonce));
  await settle(setupRow._id, 6);
  expect(settled).toEqual([]);
  await settle(target._id, 7);
  expect(settled).toEqual([7]);
  await settle(target._id, 7);
  expect(settled).toEqual([7]);
  await web.rerender(
    view({ ...jump, nonce: 8, onSettled: () => settled.push(8) }),
  );
  await settle(target._id, 7);
  expect(settled).toEqual([7]);
  await settle(target._id, 8);
  expect(settled).toEqual([7, 8]);
});

test("the root says whether the thread is live or a window around a target", async () => {
  const web = await mount();
  expect(mode(web)).toBe("live");
  await web.rerender(view({ messageId: target._id, nonce: 10 }));
  expect(mode(web)).toBe("target");
  expect(rendered?.conversation.messages.map(({ _id }) => _id)).toContain(
    target._id,
  );
  await web.rerender(view({ messageId: live._id, nonce: 11 }));
  checkTarget(web, live._id, 11);
  expect(mode(web)).toBe("live");
  expect(rendered?.conversation.messages.map(({ _id }) => _id)).toEqual([
    live._id,
  ]);
});
