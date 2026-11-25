import { asUser, serverTest } from "./database.testkit";
import { fixtureRows, type NewRow } from "./rows.testkit";
import type { Id, TableNames } from "../convex/_generated/dataModel";

export const USER = "u_user";
export const OTHER = "u_other";
export const TOKEN = "task-links-test-token";
export const SESSION = "sess-bound";

type TaskSeed = Omit<
  Partial<NewRow<"tasks">>,
  "user_id" | "team_id" | "parent_id" | "plan_id" | "conversation_ids"
> & {
  short_id: string;
  user_id?: string;
  team_id?: string;
  parent_id?: string;
  plan_id?: string;
  conversation_ids?: string[];
};

export const task = (
  short_id: string,
  fields: Partial<TaskSeed> = {},
): TaskSeed => ({
  short_id,
  title: `Title ${short_id}`,
  created_at: 1,
  updated_at: 1,
  ...fields,
});

export async function setup(
  tasks: TaskSeed[],
  session: { active_task_id?: string } = {},
) {
  const t = serverTest();
  const ids = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "task links");
    const owner = await rows.user({ name: "User" });
    const other = await rows.user({ name: "Other" });
    const teams = { team_x: await rows.team(), team_t: await rows.team() };
    const conversation = await rows.conversation(owner, {
      session_id: SESSION,
      is_private: true,
    });
    const plan = tasks.some((seed) => seed.plan_id)
      ? await rows.plan(owner, { short_id: "pl-1", title: "P" })
      : undefined;
    await rows.token(owner, TOKEN);
    await db.insert("counters", { name: "ct", value: 100 });

    const tasksByAlias = new Map<string, Id<"tasks">>();
    for (const seed of tasks) {
      const {
        user_id,
        team_id,
        workspace,
        parent_id,
        plan_id,
        conversation_ids,
        ...fields
      } = seed;
      const user = user_id === OTHER ? other : owner;
      const team =
        team_id === "team_x"
          ? teams.team_x
          : team_id === "team_t"
            ? teams.team_t
            : undefined;
      const key =
        workspace &&
        (team && workspace.startsWith("team:")
          ? `team:${team}`
          : `user:${user}`);
      const id = await rows.task(user, {
        ...fields,
        team_id: team,
        workspace: key,
        plan_id: plan_id ? plan : undefined,
        conversation_ids: conversation_ids?.map(() => conversation),
      });
      tasksByAlias.set(`task_${seed.short_id}`, id);
    }
    const deleted = await rows.task(owner);
    await db.delete(deleted);
    tasksByAlias.set("task_ct-404", deleted);
    const toRef = (ref: string) => tasksByAlias.get(ref) ?? ref;
    for (const seed of tasks) {
      const parent = seed.parent_id && tasksByAlias.get(seed.parent_id);
      const needsLegacyIds = [
        ...(seed.blocks ?? []),
        ...(seed.blocked_by ?? []),
        ...(seed.related ?? []),
      ].some((ref) => tasksByAlias.has(ref));
      if (!parent && !needsLegacyIds) continue;
      await db.patch(tasksByAlias.get(`task_${seed.short_id}`)!, {
        parent_id: parent || undefined,
        blocks: seed.blocks?.map(toRef),
        blocked_by: seed.blocked_by?.map(toRef),
        related: seed.related?.map(toRef),
      });
    }
    if (session.active_task_id)
      await db.patch(conversation, {
        active_task_id: tasksByAlias.get(session.active_task_id),
      });
    if (plan)
      await db.patch(plan, {
        task_ids: tasks
          .filter((seed) => seed.plan_id)
          .map((seed) => tasksByAlias.get(`task_${seed.short_id}`)!),
      });
    return {
      owner,
      teams,
      conversation,
      tasksByAlias: Object.fromEntries(tasksByAlias),
    };
  });
  const actor = asUser(t, ids.owner);
  const id = (shortId: string) => ids.tasksByAlias[`task_${shortId}`];
  const read = <Table extends TableNames>(table: Table) =>
    t.run(({ db }) => db.query(table).collect());
  const row = (shortId: string) =>
    t.run(async ({ db }) => {
      const task = await db
        .query("tasks")
        .withIndex("by_short_id", (q) => q.eq("short_id", shortId))
        .unique();
      if (!task) throw new Error(`Missing task ${shortId}`);
      return task;
    });
  return {
    ...ids,
    t,
    actor,
    id,
    read,
    row,
    comments: async (shortId: string) => {
      const task = await row(shortId);
      return (await read("task_comments"))
        .filter((c) => c.task_id === task._id)
        .map((c) => c.text);
    },
    history: async (shortId: string, field: string) => {
      const task = await row(shortId);
      return (await read("task_history"))
        .filter((h) => h.task_id === task._id && h.field === field)
        .map((h) => [h.old_value, h.new_value]);
    },
    join: (team: keyof typeof ids.teams) =>
      t.run(({ db }) =>
        fixtureRows(db, "task links membership").membership(
          ids.owner,
          ids.teams[team],
        ),
      ),
  };
}
