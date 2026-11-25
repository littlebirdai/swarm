import { expect, test } from "bun:test";
import type { ReplicationMessage } from "@platform/engine";
import { useInboxStore } from "../inboxStore";
import { applyUpdatesToStore, followerActionTee } from "../sync-replication";

test("a field mirror keeps the action's lock identity for a later echo", () => {
  const id = "j".repeat(32);
  const key = `sessions:${id}:inbox_dismissed_at`;
  const lock = { type: "field", value: 20, ts: 10, lock: "follower.1" };
  const row = { _id: id, session_id: id, inbox_dismissed_at: 20 };
  const messages: ReplicationMessage[] = [];
  const tee = followerActionTee(
    { post: (message) => messages.push(message), onMessage: () => () => {} },
    "follower",
  );
  useInboxStore
    .getState()
    .syncTable("sessions", [{ ...row, inbox_dismissed_at: 1 }], {
      isDelta: true,
    });
  tee(
    "renameSession",
    [{ op: "replace", path: ["sessions", id, "inbox_dismissed_at"] }],
    {
      sessions: { [id]: row },
      pending: { [key]: lock },
    },
  );
  const [message] = messages;
  if (message?.type !== "mut") throw new Error("Missing follower write");
  applyUpdatesToStore(message.updates, { optimistic: true });
  expect(useInboxStore.getState().pending[key]).toEqual(lock);
});
