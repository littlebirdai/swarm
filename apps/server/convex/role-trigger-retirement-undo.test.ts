import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { asUser, serverTest } from "../test-helpers/database.testkit";
import { seedSeat, undoRetirement } from "../test-helpers/role-trigger.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { api } from "./_generated/api";
import { handRoleTriggersToRunner } from "./lib/agentTaskRows";

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test("undo of a completed team retirement restarts the interrupted handoff for 500 triggers", async () => {
  const t = serverTest({});
  const { seat, role, oldRunner, runner, moved } = await seedSeat(t, 500);
  await t.run(async ({ db }) => {
    const fixtures = fixtureRows(db, "team role retirement undo");
    const team_id = await fixtures.team({ features: { org: true } });
    await fixtures.membership(oldRunner, team_id, { role: "admin" });
    await fixtures.membership(runner, team_id);
    const anchor = (await db.get(role))!.anchor_id!;
    const scope = {
      team_id,
      scope_type: "team" as const,
      scope_user_id: undefined,
    };
    const bot = await fixtures.user({ is_bot: true });
    await fixtures.membership(bot, team_id);
    await db.patch(anchor, { ...scope, bot_user_id: bot });
    await db.patch(role, scope);
    await db.patch(seat, {
      team_id,
      is_private: false,
      team_visibility: "full",
    });
  });
  const last = moved.at(-1)!;
  await t.run((ctx) => handRoleTriggersToRunner(ctx, seat));
  jest.runOnlyPendingTimers();
  await t.finishInProgressScheduledFunctions();
  expect((await t.run(({ db }) => db.get(moved[0])))?.user_id).toBe(runner);
  expect((await t.run(({ db }) => db.get(last)))?.user_id).toBe(oldRunner);
  await asUser(t, oldRunner).mutation(api.orgRoles.retire, {
    role_id: role,
    standing_session: "retire",
  });
  await t.finishAllScheduledFunctions(() => jest.runAllTimers());
  expect(await t.run(({ db }) => db.get(last))).toMatchObject({
    user_id: oldRunner,
    status: "cancelled",
  });
  await undoRetirement(t, oldRunner, role);
  expect((await t.run(({ db }) => db.get(last)))?.status).toBe("scheduled");
  await t.finishAllScheduledFunctions(() => jest.runAllTimers());
  expect(await t.run(({ db }) => db.get(last))).toMatchObject({
    user_id: runner,
    status: "scheduled",
  });
});
