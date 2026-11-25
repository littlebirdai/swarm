import { expect, test } from "bun:test";
import { serverTest } from "../test-helpers/database.testkit";
import { fixtureRows, type NewRow } from "../test-helpers/rows.testkit";
import { makeLifecycleEventDb, noteWriteCause } from "./lifecycleEvents";

async function setup(fields: Partial<NewRow<"conversations">> = {}) {
  const t = serverTest();
  const { user, conversation } = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "lifecycle event");
    const user = await rows.user();
    const conversation = await rows.conversation(user, fields);
    return { user, conversation };
  });
  return {
    t,
    user,
    conversation,
    events: () => t.run(({ db }) => db.query("conversation_events").collect()),
  };
}

test("a dismiss records the change and the cause the mutation named", async () => {
  const { t, conversation, events } = await setup();
  await t.run(async ({ db }) => {
    const ctx = { db: makeLifecycleEventDb(db, db) };
    noteWriteCause(ctx, "web:killSession");
    await ctx.db.patch(conversation, { inbox_dismissed_at: 5, title: "x" });
  });
  const recorded = await events();
  expect(recorded).toHaveLength(1);
  expect(recorded[0]).toMatchObject({
    conversation_id: conversation,
    kind: "lifecycle",
    cause: "web:killSession",
    changes: { inbox_dismissed_at: [null, "5"] },
  });
});

test("re-asserting a value that is already set records nothing", async () => {
  const { t, conversation, events } = await setup({ status: "completed" });
  await t.run(async ({ db }) => {
    const writer = makeLifecycleEventDb(db, db);
    await writer.patch(conversation, { status: "completed" });
    await writer.patch(conversation, { title: "only a title" });
  });
  expect(await events()).toHaveLength(0);
});

test("without a cause the writer's stack is kept", async () => {
  const { t, conversation, events } = await setup();
  await t.run(async ({ db }) => {
    await makeLifecycleEventDb(db, db).patch(conversation, {
      status: "completed",
    });
  });
  const [event] = await events();
  expect(event.cause).toBeUndefined();
  expect(event.stack).toContain("lifecycleEvents.test");
});

test("a pending message ending cancelled is recorded under its conversation", async () => {
  const { t, user, conversation, events } = await setup();
  await t.run(async ({ db }) => {
    const message = await db.insert("pending_messages", {
      conversation_id: conversation,
      from_user_id: user,
      content: "Queued message",
      retry_count: 0,
      status: "pending",
      created_at: 1,
    });
    const ctx = { db: makeLifecycleEventDb(db, db) };
    noteWriteCause(ctx, "killSession");
    await ctx.db.patch(message, { status: "cancelled" });
  });
  expect((await events())[0]).toMatchObject({
    conversation_id: conversation,
    kind: "message_cancelled",
    cause: "killSession",
  });
});

test("a raw managed-session delete removes its heartbeat and records the lifecycle event", async () => {
  const { t, user, conversation, events } = await setup();
  const heartbeat = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "lifecycle heartbeat");
    const session = await rows.session(user, { conversation_id: conversation });
    return db.insert("session_heartbeats", {
      managed_session_id: session,
      user_id: user,
      heartbeat_at: 123,
    });
  });
  await t.run(async ({ db }) => {
    const session = (await db.get(heartbeat))!.managed_session_id;
    const writer = makeLifecycleEventDb(db, db);
    await writer.delete(session);
    await writer.delete(conversation);
  });
  expect(await t.run(({ db }) => db.get(heartbeat))).toBeNull();
  expect((await events()).map((event) => event.kind)).toEqual([
    "managed_session_deleted",
    "deleted",
  ]);
});
