import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { api, internal } from "./_generated/api";
import type { Doc, Id, TableNames } from "./_generated/dataModel";
import { makeSessionStartsDb } from "./lib/sessionStarts";
import { getPendingMessagesForDaemon } from "./pendingMessages";
import schema from "./schema";
import { allModules } from "./testModules.testkit";

async function setup() {
  const t = convexTest(schema, allModules);
  const { owner, conversationId, messageId } = await t.run(async ({ db }) => {
    const owner = await db.insert("users", { name: "Owner" });
    const conversationId = await makeSessionStartsDb(db, db).insert("conversations", {
      user_id: owner,
      session_id: "local-session",
      agent_type: "codex",
      is_private: true,
      status: "active",
      started_at: 1,
      updated_at: 1,
      message_count: 0,
    });
    const messageId = await db.insert("pending_messages", {
      conversation_id: conversationId,
      from_user_id: owner,
      content: "Keep going",
      status: "pending",
      created_at: 2,
      retry_count: 0,
    });
    return { owner, conversationId, messageId };
  });
  const asOwner = t.withIdentity({ subject: `${owner}|session` });
  const pending = (device_id = "laptop") =>
    asOwner.query(api.pendingMessages.getPendingMessagesForDaemon, { device_id });
  const patch = (fields: Partial<Doc<"conversations">>) =>
    t.run(({ db }) => makeSessionStartsDb(db, db).patch(conversationId, fields));
  return { t, asOwner, owner, conversationId, messageId, pending, patch };
}

test("daemon pending messages use the session start across transcript updates", async () => {
  const { asOwner, conversationId, messageId, patch } = await setup();
  const read = () => asOwner.run((ctx) => {
    const db = {
      ...ctx.db,
      query: ctx.db.query.bind(ctx.db),
      get: (id: Id<TableNames>) => {
        expect(id).not.toBe(conversationId);
        return ctx.db.get(id);
      },
    };
    return (getPendingMessagesForDaemon as any)._handler({ ...ctx, db }, { device_id: "laptop" });
  });
  const before = await read();
  expect(before).toEqual([expect.objectContaining({ _id: messageId, conversation_agent_type: "codex" })]);
  await patch({ message_count: 1, updated_at: 3, last_message_role: "assistant" });
  expect(await read()).toEqual(before);
});

test("daemon pending messages follow device, owner, and agent changes", async () => {
  const { t, messageId, pending, patch } = await setup();
  await patch({ owner_device_id: "desktop", agent_type: "claude_code" });
  expect(await pending()).toEqual([]);
  expect(await pending("desktop")).toEqual([
    expect.objectContaining({ _id: messageId, conversation_agent_type: "claude_code" }),
  ]);
  await patch({ owner_device_id: undefined });
  expect(await pending()).toHaveLength(1);
  const nextOwner = await t.run(({ db }) => db.insert("users", { name: "New owner" }));
  await patch({ user_id: nextOwner });
  expect(await pending()).toEqual([]);
});

test("conversation delivery blocks take effect through the session start", async () => {
  const { t, owner, conversationId, pending, patch } = await setup();
  const migrationId = await t.run(({ db }) => db.insert("session_migrations", {
    user_id: owner,
    batch_id: "batch",
    conversation_id: conversationId,
    direction: "to_local",
    to_device_id: "desktop",
    executor_device_id: "laptop",
    status: "quiescing",
    position: 0,
    attempt: 1,
    created_at: 3,
    updated_at: 3,
  }));
  const transitions: [Partial<Doc<"conversations">>, Partial<Doc<"conversations">>][] = [
    [{ pending_api_error_kind: "safety" }, { pending_api_error_kind: undefined }],
    [{ session_error: "This request was blocked by our safety systems. Reason: Potentially unintended activity." }, { session_error: undefined }],
    [{ execution_protocol_state: "legacy-quiescing" }, { execution_protocol_state: undefined }],
    [{ cloud_placement: "pending" }, { cloud_placement: undefined }],
    [{ migration: { batch_id: "batch", migration_id: migrationId, to_device_id: "desktop", started_at: 3 } }, { migration: undefined }],
    [{ agent_type: "codecast" }, { agent_type: "codex" }],
  ];
  for (const [block, clear] of transitions) {
    await patch(block);
    expect(await pending()).toEqual([]);
    await patch(clear);
    expect(await pending()).toHaveLength(1);
  }
});

test("the session starts backfill replaces the legacy conversation fallback", async () => {
  const { t, messageId, pending, patch } = await setup();
  await patch({ owner_device_id: "desktop" });
  await t.run(async ({ db }) => {
    const start = (await db.query("session_starts").first())!;
    await db.patch(start._id, { daemon_delivery: undefined });
  });
  expect(await pending()).toEqual([]);
  const before = await pending("desktop");
  expect(before).toEqual([expect.objectContaining({ _id: messageId })]);
  expect(await t.mutation(internal.pageData.backfillSessionStarts, {})).toEqual({ done: 1, finished: true });
  const start = await t.run(({ db }) => db.query("session_starts").first());
  expect(start?.daemon_delivery).toEqual({ owner_device_id: "desktop", blocked: false });
  expect(await pending("desktop")).toEqual(before);
});
