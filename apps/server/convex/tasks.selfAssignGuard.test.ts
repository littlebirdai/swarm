// tasks.update must not announce a self-assignment. Agents run under the
// owner's token, so an `assignee: "me"` from a CLI claim resolves to the owner;
// before this guard every agent claim notified the owner that they assigned
// themselves and enrolled them as assignee. webUpdate already had the guard;
// update mirrors it.
import { describe, expect, test } from "bun:test";
import { taskTest } from "../test-helpers/tasks.testkit";
import { api } from "./_generated/api";

const TOKEN = "self-assign-token";

async function setup() {
  const world = await taskTest("self assignment", TOKEN, [
    { short_id: "ct-1", source: "agent" },
  ]);
  const [task] = world.taskIds;
  return {
    ...world,
    readTask: () => world.t.run(async ({ db }) => (await db.get(task))!),
    assignments: async () =>
      (
        await world.t.run(({ db }) => db.query("notifications").collect())
      ).filter((n) => n.type === "task_assigned"),
  };
}

describe("tasks.update self-assign guard", () => {
  test("assignee 'me' resolves to the actor: no task_assigned, no assignee enrollment", async () => {
    const { t, owner, readTask, assignments, subscriptions } = await setup();
    await t.mutation(api.tasks.update, {
      api_token: TOKEN,
      short_id: "ct-1",
      status: "in_progress",
      assignee: "me",
    });
    expect((await readTask()).assignee).toBe(owner);
    expect(await assignments()).toEqual([]);
    expect(
      (await subscriptions()).filter((s) => s.reason === "assignee"),
    ).toEqual([]);
  });

  test("assigning someone else still notifies and enrolls them", async () => {
    const { t, bob, assignments, subscriptions } = await setup();
    await t.mutation(api.tasks.update, {
      api_token: TOKEN,
      short_id: "ct-1",
      assignee: "bob",
    });
    expect((await assignments()).map((e) => e.recipient_user_id)).toEqual([
      bob,
    ]);
    expect(
      (await subscriptions())
        .filter((s) => s.reason === "assignee")
        .map((s) => s.user_id),
    ).toEqual([bob]);
  });

  test("an agent claim (session binding, no assignee) leaves assignee unset", async () => {
    const { t, readTask, assignments } = await setup();
    await t.mutation(api.tasks.update, {
      api_token: TOKEN,
      short_id: "ct-1",
      status: "in_progress",
      conversation_id: "sess-1",
    });
    expect((await readTask()).status).toBe("in_progress");
    expect((await readTask()).assignee).toBeUndefined();
    expect(await assignments()).toEqual([]);
  });
});
