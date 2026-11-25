import { describe, expect, test } from "bun:test";
import { scheduledJobs, serverTest } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { afterRoleDocWrite } from "./orgRoles";

async function setup() {
  const t = serverTest();
  const ids = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "role documents");
    const owner = await rows.user();
    const bot = await rows.user({ is_bot: true });
    const team = await rows.team({ features: { org: true } });
    const brief = await rows.doc(owner, { doc_type: "brief", team_id: team });
    const charter = await rows.doc(owner, {
      doc_type: "charter",
      team_id: team,
    });
    const note = await rows.doc(owner, { doc_type: "note", team_id: team });
    const role = await rows.role(owner, {
      scope_type: "team",
      scope_user_id: undefined,
      team_id: team,
      brief_doc_id: brief,
      charter_doc_id: charter,
    });
    const conversation = await rows.conversation(owner, {
      standing_role_id: role,
    });
    const anchor = await db.insert("anchors", {
      scope_type: "team",
      team_id: team,
      bot_user_id: bot,
      host_user_id: owner,
      conversation_id: conversation,
      org_role_id: role,
      name: "Infra lead",
      status: "active",
      created_at: 1,
    });
    await db.patch(role, { anchor_id: anchor });
    return { brief, charter, note, conversation, role, anchor };
  });

  return {
    write: (type: "brief" | "charter" | "note", content: string) =>
      t.run(async (ctx) =>
        afterRoleDocWrite(ctx, await ctx.db.get(ids[type]), content),
      ),
    readConversation: () =>
      t.run(async ({ db }) => (await db.get(ids.conversation))!),
    snapshot: () =>
      t.run(async ({ db }) => ({
        roles: await db.query("org_roles").collect(),
        anchors: await db.query("anchors").collect(),
        conversations: await db.query("conversations").collect(),
        docs: await db.query("docs").collect(),
        notifications: await db.query("notifications").collect(),
        pending: await db.query("pending_messages").collect(),
      })),
    jobs: () => scheduledJobs(t),
  };
}

describe("afterRoleDocWrite", () => {
  test("a brief's first line lands on the standing session's state", async () => {
    const { write, readConversation } = await setup();
    await write(
      "brief",
      "Infra lead standing by\nStatus: dormant waiting on CI\nNext: read the frame\n\nMore prose.",
    );
    const conv = await readConversation();
    expect(conv.thread_state).toMatch(/^Infra lead standing by/);
    expect(conv.thread_state).toContain("Next: read the frame");
    expect(conv.thread_state).not.toContain("More prose");
    expect(conv.thread_state_status).toBe("dormant");
  });

  test("a charter edit touches nothing: the role reads it at its next run", async () => {
    const { write, snapshot, jobs } = await setup();
    const before = await snapshot();
    await write("charter", "# Charter\nnew rules");
    expect(await snapshot()).toEqual(before);
    expect(await jobs()).toEqual([]);
  });

  test("any other document is left alone", async () => {
    const { write, snapshot, jobs } = await setup();
    const before = await snapshot();
    await write("note", "hello");
    expect(await snapshot()).toEqual(before);
    expect(await jobs()).toEqual([]);
  });
});
