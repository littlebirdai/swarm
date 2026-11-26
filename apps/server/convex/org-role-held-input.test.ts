import { expect, test } from "bun:test";
import { api } from "./_generated/api";
import { asUser, serverTest } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";

for (const standing_session of ["keep", "retire"] as const) {
  test(`retiring a role with held input and standing_session=${standing_session}`, async () => {
    const t = serverTest();
    const { user, role, anchor, conversation, held, queued } = await t.run(
      async ({ db }) => {
        const rows = fixtureRows(db, "org role held input");
        const user = await rows.user({ name: "Owner" });
        const bot = await rows.user({ is_bot: true, bot_kind: "role" });
        const conversation = await rows.conversation(user, {
          has_pending_messages: true,
        });
        const anchor = await db.insert("anchors", {
          scope_type: "user",
          scope_user_id: user,
          host_user_id: user,
          bot_user_id: bot,
          conversation_id: conversation,
          name: "Standing agent",
          status: "active",
          created_at: Date.now(),
        });
        const role = await rows.role(user, {
          anchor_id: anchor,
          scope_user_id: user,
        });
        await db.patch(anchor, { org_role_id: role });
        await db.patch(conversation, {
          anchor_id: anchor,
          standing_role_id: role,
          acting_user_id: bot,
        });
        const input = {
          conversation_id: conversation,
          from_user_id: user,
          status: "held" as const,
          created_at: Date.now(),
          retry_count: 0,
        };
        const held = await db.insert("pending_messages", {
          ...input,
          content: "Standing input",
        });
        const queued = await db.insert("pending_messages", {
          ...input,
          content: "Queued for the end of the turn",
          queued: true,
        });
        return { user, role, anchor, conversation, held, queued };
      },
    );

    await asUser(t, user).mutation(api.orgRoles.retire, {
      role_id: role,
      standing_session,
    });

    const kept = standing_session === "keep";
    const state = await t.run(async ({ db }) => ({
      role: await db.get(role),
      anchor: await db.get(anchor),
      conversation: await db.get(conversation),
      held: await db.get(held),
      queued: await db.get(queued),
    }));
    expect(state.role?.status).toBe("retired");
    expect(state.anchor?.status).toBe(kept ? "active" : "decommissioned");
    expect(state.conversation?.status).toBe(kept ? "active" : "completed");
    expect(state.conversation?.standing_role_id).toBeUndefined();
    expect(state.held?.status).toBe(kept ? "pending" : "cancelled");
    expect(state.queued?.status).toBe(kept ? "pending" : "cancelled");
  });
}
