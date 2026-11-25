// A CLI write names "this session" by uuid, but conversations.session_id can
// go stale (the daemon's rebind at link/resume can lose — stranded task-run
// stub, cross-machine handover). These tests pin the two halves of the fix:
// resolveSessionConversation falls back to the managed_sessions link, and the
// task mutations treat an unresolvable session as enrichment to drop, never a
// reason to reject the write itself. Regression for the jx73p8k strand, where
// every `cast task comment/done/update` failed "Conversation not found" for a
// whole session and the comment text was lost.
import { describe, expect, test } from "bun:test";
import { serverTest } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { api } from "./_generated/api";
import { resolveSessionConversation } from "./lib/access";

const TOKEN = "backlink-test-token";

const LIVE_UUID = "8b830e0a-live-uuid";
const STALE_UUID = "1baf79ed-stub-uuid";

async function setup(link: "managed" | "private" | "missing" = "missing") {
  const t = serverTest();
  const ids = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "task session backlink");
    const owner = await rows.user();
    await rows.token(owner, TOKEN);
    const task = await rows.task(owner, { short_id: "ct-10", source: "agent" });
    const conversation = await rows.conversation(
      link === "private" ? await rows.user() : owner,
      {
        session_id: link === "private" ? LIVE_UUID : STALE_UUID,
        is_private: true,
      },
    );
    if (link === "managed") {
      await rows.session(owner, {
        session_id: LIVE_UUID,
        conversation_id: conversation,
      });
    }
    return { owner, task, conversation };
  });
  return {
    t,
    ...ids,
    resolve: () =>
      t.run((ctx) => resolveSessionConversation(ctx, ids.owner, LIVE_UUID)),
    readTask: () => t.run(async ({ db }) => (await db.get(ids.task))!),
  };
}

describe("resolveSessionConversation", () => {
  test("a live uuid the row no longer carries resolves via managed_sessions", async () => {
    const { conversation, resolve } = await setup("managed");
    expect((await resolve())?._id).toBe(conversation);
  });

  test("a uuid known nowhere returns null instead of throwing", async () => {
    const { resolve } = await setup();
    expect(await resolve()).toBeNull();
  });

  test("another user's private conversation is null, not a leak", async () => {
    const { resolve } = await setup("private");
    expect(await resolve()).toBeNull();
  });
});

describe("task writes survive a stranded session_id", () => {
  test("addComment records the text and drops the back-link", async () => {
    const { t } = await setup();
    const res = await t.mutation(api.tasks.addComment, {
      api_token: TOKEN,
      short_id: "ct-10",
      text: "analysis",
      conversation_id: LIVE_UUID,
    });
    expect(res.id).toBeTruthy();
    const comments = await t.run(({ db }) =>
      db.query("task_comments").collect(),
    );
    expect(comments).toHaveLength(1);
    expect(comments[0].text).toBe("analysis");
    expect(comments[0].conversation_id).toBeUndefined();
  });

  test("addComment keeps the back-link when managed_sessions still knows the uuid", async () => {
    const { t, conversation } = await setup("managed");
    const { id } = await t.mutation(api.tasks.addComment, {
      api_token: TOKEN,
      short_id: "ct-10",
      text: "linked",
      conversation_id: LIVE_UUID,
    });
    expect((await t.run(({ db }) => db.get(id)))?.conversation_id).toBe(
      conversation,
    );
  });

  test("update applies the status change without the link", async () => {
    const { t, readTask } = await setup();
    await t.mutation(api.tasks.update, {
      api_token: TOKEN,
      short_id: "ct-10",
      status: "done",
      conversation_id: LIVE_UUID,
    });
    const task = await readTask();
    expect(task.status).toBe("done");
    expect(task.conversation_ids ?? []).toHaveLength(0);
  });

  test("create makes the task without a source conversation", async () => {
    const { t } = await setup();
    const { short_id } = await t.mutation(api.tasks.create, {
      api_token: TOKEN,
      title: "new task",
      conversation_id: LIVE_UUID,
    });
    const created = await t.run(({ db }) =>
      db
        .query("tasks")
        .withIndex("by_short_id", (q) => q.eq("short_id", short_id))
        .unique(),
    );
    expect(created?.title).toBe("new task");
    expect(created?.created_from_conversation).toBeUndefined();
  });
});
