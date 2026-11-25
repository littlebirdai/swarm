import { api } from "@codecast/convex/convex/_generated/api";
import type { InboxSession, Message, useInboxStore } from "../store/inboxStore";
import type { Doc, Id } from "@codecast/convex/convex/_generated/dataModel";
import { pending, type testConvex } from "./testConvex";

export function seedConversationMessages(
  backend: ReturnType<typeof testConvex>,
  store: ReturnType<typeof useInboxStore.getState>,
  session: InboxSession,
  tail: (Message & { role: Doc<"messages">["role"] })[] = [],
) {
  store.syncTable("sessions", [session]);
  store.setMessages(session._id, tail, {
    initialized: true,
    hasMoreAbove: false,
  });
  backend.set(api.conversations.listMessages, {
    page: [...tail].reverse().map((message) => ({
      _id: message._id as Id<"messages">,
      _creationTime: message.timestamp,
      conversation_id: session._id as Id<"conversations">,
      role: message.role,
      content: message.content,
      timestamp: message.timestamp,
    })),
    isDone: true,
    continueCursor: "",
  });
  backend.set(api.conversations.listMessagesTail, pending);
  backend.set(api.conversations.getConversationWithMeta, pending);
  backend.set(api.conversations.getTranscriptWatermark, pending);
  backend.set(api.conversations.getUserMessages, pending);
}

export function messageWindow(messages: Message[], hasMoreBelow = false) {
  return {
    messages,
    oldest_timestamp: messages[0]?.timestamp ?? null,
    last_timestamp: messages.at(-1)?.timestamp ?? null,
    has_more_above: false,
    has_more_below: hasMoreBelow,
  };
}
