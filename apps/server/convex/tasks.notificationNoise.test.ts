// The bell reaches the same people the Threads inbox does, for the same
// reasons: a person's comment, an agent comment that needs a person, a close
// the reader opted into, and one row per burst of machine assignments. These
// pin each rule against the real handlers (subscribe, emit).
import { describe, expect, test } from "bun:test";
import { serverTest } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";

const TOKEN = "noise-owner-token";
const BOT_TOKEN = "noise-bot-token";

async function setup(bobPrefs?: Doc<"users">["notification_preferences"]) {
  const t = serverTest();
  const ids = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "task notification noise");
    const owner = await rows.user({ github_username: "owner" });
    const bob = await rows.user({
      github_username: "bob",
      notification_preferences: bobPrefs,
    });
    const carol = await rows.user({ github_username: "carol" });
    const bot = await rows.user({ is_bot: true });
    const team = await rows.team();
    for (const member of [owner, bob, carol, bot])
      await rows.membership(member, team);
    await rows.token(owner, TOKEN);
    await rows.token(bot, BOT_TOKEN);
    await rows.conversation(owner, { session_id: "sess-1" });
    const taskFields = {
      source: "agent",
      team_id: team,
      workspace: `team:${team}`,
    } as const;
    const task = await rows.task(owner, { ...taskFields, short_id: "ct-1" });
    await rows.task(owner, { ...taskFields, short_id: "ct-2" });
    await rows.task(owner, { ...taskFields, short_id: "ct-3" });
    const subscription = {
      entity_type: "task",
      entity_id: task,
      reason: "commenter",
      muted: false,
      created_at: 0,
    } as const;
    await db.insert("entity_subscriptions", {
      ...subscription,
      user_id: bob,
      via: "human",
    });
    await db.insert("entity_subscriptions", {
      ...subscription,
      user_id: carol,
      via: "agent",
    });
    return { bob, carol, task };
  });

  const bell = async (
    type: Doc<"notifications">["type"],
    who?: Id<"users">,
  ) => {
    const notes = await t.run(({ db }) => db.query("notifications").collect());
    return notes.filter(
      (n) => n.type === type && (!who || n.recipient_user_id === who),
    );
  };
  return { t, ...ids, bell };
}

describe("task comments ring whom the Threads inbox files them for", () => {
  test("a person's comment reaches followers by their own hand, not ones an agent enrolled", async () => {
    const { t, bell, bob } = await setup();
    await t.mutation(api.tasks.addComment, {
      api_token: TOKEN,
      short_id: "ct-1",
      text: "looks good",
    });
    expect(
      (await bell("task_commented")).map((n) => n.recipient_user_id),
    ).toEqual([bob]);
  });

  test("an agent's progress note rings nobody; its blocker rings the followers", async () => {
    const { t, bell, bob } = await setup();
    await t.mutation(api.tasks.addComment, {
      api_token: TOKEN,
      short_id: "ct-1",
      text: "rebased",
      conversation_id: "sess-1",
    });
    expect(await bell("task_commented")).toHaveLength(0);
    await t.mutation(api.tasks.addComment, {
      api_token: TOKEN,
      short_id: "ct-1",
      text: "need a prod key",
      comment_type: "blocker",
      conversation_id: "sess-1",
    });
    expect(
      (await bell("task_commented")).map((n) => n.recipient_user_id),
    ).toEqual([bob]);
  });

  test("on an ephemeral task only a blocker or an @mention rings (TG9)", async () => {
    const { t, task, bell, bob, carol } = await setup();
    await t.run(({ db }) => db.patch(task, { ephemeral: true }));
    await t.mutation(api.tasks.addComment, {
      api_token: TOKEN,
      short_id: "ct-1",
      text: "looks good",
    });
    expect(await bell("task_commented")).toHaveLength(0);
    await t.mutation(api.tasks.addComment, {
      api_token: TOKEN,
      short_id: "ct-1",
      text: "@carol this needs your approval",
    });
    expect(
      (await bell("task_commented")).map((n) => n.recipient_user_id),
    ).toEqual([carol]);
    await t.mutation(api.tasks.addComment, {
      api_token: TOKEN,
      short_id: "ct-1",
      text: "need a prod key",
      comment_type: "blocker",
      conversation_id: "sess-1",
    });
    expect(await bell("task_commented", bob)).toHaveLength(1);
  });

  test("a bot account's note counts as an agent's even from a terminal", async () => {
    const { t, bell } = await setup();
    await t.mutation(api.tasks.addComment, {
      api_token: BOT_TOKEN,
      short_id: "ct-1",
      text: "READY FOR DECISION: waited 18 days",
    });
    expect(await bell("task_commented")).toHaveLength(0);
  });
});

describe("status changes are quiet unless the reader opts into closes", () => {
  test("no status move rings by default", async () => {
    const { t, bell } = await setup();
    await t.mutation(api.tasks.update, {
      api_token: TOKEN,
      short_id: "ct-1",
      status: "in_progress",
    });
    await t.mutation(api.tasks.update, {
      api_token: TOKEN,
      short_id: "ct-1",
      status: "done",
    });
    expect(await bell("task_status_changed")).toHaveLength(0);
  });

  test("an opted-in participant hears done, not in_progress", async () => {
    const { t, bell, bob } = await setup({
      team_session_start: true,
      mention: true,
      permission_request: true,
      task_status_changes: true,
    });
    await t.mutation(api.tasks.update, {
      api_token: TOKEN,
      short_id: "ct-1",
      status: "in_progress",
    });
    expect(await bell("task_status_changed")).toHaveLength(0);
    await t.mutation(api.tasks.update, {
      api_token: TOKEN,
      short_id: "ct-1",
      status: "done",
    });
    expect(
      (await bell("task_status_changed")).map((n) => n.recipient_user_id),
    ).toEqual([bob]);
  });
});

describe("machine assignment bursts fold into one row", () => {
  test("a bot assigning three tasks leaves one unread row that counts them", async () => {
    const { t, bell, bob } = await setup();
    for (const id of ["ct-1", "ct-2", "ct-3"]) {
      await t.mutation(api.tasks.update, {
        api_token: BOT_TOKEN,
        short_id: id,
        assignee: "bob",
      });
    }
    const rows = await bell("task_assigned", bob);
    expect(rows).toHaveLength(1);
    expect(rows[0].fold_count).toBe(3);
    expect(rows[0].message).toContain("assigned you 3 tasks, latest ct-3");
  });

  test("a person assigning by hand still gets one row per task", async () => {
    const { t, bell, bob } = await setup();
    for (const id of ["ct-1", "ct-2"]) {
      await t.mutation(api.tasks.update, {
        api_token: TOKEN,
        short_id: id,
        assignee: "bob",
      });
    }
    expect(await bell("task_assigned", bob)).toHaveLength(2);
  });
});
