import { expect } from "bun:test";
import { api } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { asUser, type ServerTest } from "./database.testkit";
import { fixtureRows } from "./rows.testkit";

export async function seedSeat(
  t: ServerTest,
  triggerCount: number,
  prompt = "Check in",
) {
  return t.run(async ({ db }) => {
    const fixtures = fixtureRows(db, "role-trigger-handoff");
    const oldRunner = await fixtures.user();
    const runner = await fixtures.user();
    const otherSeat = await fixtures.conversation(oldRunner);
    const seat = await fixtures.conversation(runner, {
      armed_trigger_kind: "once",
    });
    async function roleAt(conversation: typeof seat, handle: string) {
      const anchor = await db.insert("anchors", {
        conversation_id: conversation,
        scope_type: "user",
        scope_user_id: oldRunner,
        host_user_id: oldRunner,
        bot_user_id: oldRunner,
        name: handle,
        status: "active",
        created_at: 1,
      });
      return db.insert("org_roles", {
        anchor_id: anchor,
        short_id: handle,
        scope_type: "user",
        scope_user_id: oldRunner,
        host_user_id: oldRunner,
        name: handle,
        handle,
        scope: { project_ids: [], plan_ids: [] },
        reports_to: { kind: "user", user_id: oldRunner },
        status: "active",
        created_by: oldRunner,
        created_at: 1,
        updated_at: 1,
      });
    }
    const role = await roleAt(seat, "seated-role");
    const otherRole = await roleAt(otherSeat, "other-role");
    const trigger = (data: Partial<Doc<"agent_tasks">> = {}) =>
      db.insert("agent_tasks", {
        user_id: oldRunner,
        originating_conversation_id: seat,
        title: "Follow up",
        prompt,
        mode: "apply",
        schedule_type: "once",
        status: "scheduled",
        created_at: 1,
        retry_count: 0,
        run_count: 0,
        ...data,
      });
    const personal = await trigger();
    const offSeat = await trigger({ role_id: otherRole });
    const alreadyOwned = await trigger({ user_id: runner, role_id: role });
    const moved = [];
    for (let i = 0; i < triggerCount; i++) {
      moved.push(
        await trigger({
          role_id: role,
          schedule_type: i === triggerCount - 1 ? "recurring" : "once",
        }),
      );
    }
    return {
      seat,
      runner,
      oldRunner,
      moved,
      personal,
      offSeat,
      alreadyOwned,
      role,
      otherSeat,
    };
  });
}

export async function undoRetirement(
  t: ServerTest,
  owner: Id<"users">,
  role: Id<"org_roles">,
) {
  const batch = await t.run(async ({ db }) => {
    const change = await db
      .query("org_changes")
      .withIndex("by_subject", (q) => q.eq("subject.id", role))
      .first();
    return change!.batch;
  });
  await asUser(t, owner).mutation(api.orgChanges.undo, { batch });
  expect((await t.run(({ db }) => db.get(role)))?.status).toBe("active");
}
