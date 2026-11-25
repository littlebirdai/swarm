import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { defineSchema } from "convex/server";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import { hashToken } from "./apiTokens";
import schema from "./schema";
import { allModules } from "./testModules.testkit";

const strictSchema = defineSchema(schema.tables);
const apiToken = "schema-writes-test-token";

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

async function setup() {
  const t = convexTest({ schema: strictSchema, modules: allModules });
  const user = await t.run(async ({ db }) => {
    const user = await db.insert("users", { name: "Owner" });
    await db.insert("api_tokens", {
      user_id: user,
      token_hash: await hashToken(apiToken),
      name: "Schema test",
      created_at: 1,
      last_used_at: 1,
    });
    return user;
  });
  return { t, user };
}

async function enableOrg({ t, user }: Awaited<ReturnType<typeof setup>>) {
  return t.run(async ({ db }) => {
    const team = await db.insert("teams", {
      name: "Incident response",
      features: { org: true },
      invite_code: "schema-test",
      created_at: 1,
    });
    await db.insert("team_memberships", {
      user_id: user,
      team_id: team,
      role: "admin",
      joined_at: 1,
    });
    return team;
  });
}

test("provisioning a role stores a role bot", async () => {
  const fixture = await setup();
  await enableOrg(fixture);
  const { t } = fixture;
  await t.mutation(api.orgRoles.create, {
    api_token: apiToken,
    name: "Incident lead",
    handle: "incidents",
    provision: true,
  });
  const bots = await t.run(({ db }) =>
    db
      .query("users")
      .filter((q) => q.eq(q.field("is_bot"), true))
      .collect(),
  );
  expect(bots).toHaveLength(1);
  expect(bots[0]?.bot_kind).toBe("role");
});

test("routing a request stores the route source on the task", async () => {
  const fixture = await setup();
  await enableOrg(fixture);
  const { t, user } = fixture;
  const result = await t.action(api.orgRoute.route, {
    api_token: apiToken,
    request: "Check the on-call schedule",
    to: "me",
  });
  const task = await t.run(({ db }) =>
    db
      .query("tasks")
      .withIndex("by_short_id", (q) => q.eq("short_id", result.task!.short_id))
      .unique(),
  );
  expect(task).toMatchObject({ source: "route", assignee: user });
});

test("editing a trigger stores its previous agent and routing settings", async () => {
  const { t, user } = await setup();
  const { task, settings } = await t.run(async ({ db }) => {
    const conversation = await db.insert("conversations", {
      user_id: user,
      session_id: "incident-response",
      agent_type: "claude_code",
      started_at: 1,
      updated_at: 1,
      message_count: 0,
      is_private: true,
      status: "active",
    });
    const settings = {
      agent_definition: "incident-triage",
      originating_conversation_id: conversation,
      target_conversation_id: conversation,
      created_by_conversation_id: conversation,
      wake_creator: true,
    };
    const task = await db.insert("agent_tasks", {
      user_id: user,
      title: "Check incidents",
      prompt: "Find active incidents",
      schedule_type: "once",
      mode: "apply",
      status: "paused",
      run_count: 0,
      retry_count: 0,
      created_at: 1,
      ...settings,
    });
    return { task, settings };
  });
  await t.mutation(api.agentTasks.updateTask, {
    api_token: apiToken,
    task_id: task,
    prompt: "Summarize active incidents",
  });
  const revisions = await t.run(({ db }) =>
    db
      .query("agent_task_revisions")
      .withIndex("by_task", (q) => q.eq("task_id", task))
      .collect(),
  );
  expect(revisions).toHaveLength(1);
  expect(revisions[0]?.before).toMatchObject({
    prompt: "Find active incidents",
    ...settings,
  });
});

test("a person who creates a plan from a template stores a human source", async () => {
  const { t, user } = await setup();
  const template = await t.run(({ db }) =>
    db.insert("plan_templates", {
      user_id: user,
      name: "Incident response",
      goal_template: "Restore service",
      task_templates: [],
      created_at: 1,
      updated_at: 1,
    }),
  );
  await t.mutation(api.plans.createFromTemplate, {
    api_token: apiToken,
    template_id: template,
  });
  const plan = await t.run(({ db }) => db.query("plans").unique());
  expect(plan).toMatchObject({
    user_id: user,
    title: "Incident response",
    source: "human",
  });
});

test("a person who forks a plan stores a human source", async () => {
  const { t } = await setup();
  const { short_id } = await t.mutation(api.plans.create, {
    api_token: apiToken,
    title: "Restore service",
  });
  await t.mutation(api.plans.fork, {
    api_token: apiToken,
    source_short_id: short_id,
  });
  const plans = await t.run(({ db }) => db.query("plans").collect());
  expect(plans.map(({ title, source }) => [title, source])).toEqual([
    ["Restore service", "human"],
    ["Restore service (fork)", "human"],
  ]);
});

test("a task cannot assign a role ID outside its workspace", async () => {
  const fixture = await setup();
  const team = await enableOrg(fixture);
  const { t } = fixture;
  const role = await t.mutation(api.orgRoles.create, {
    api_token: apiToken,
    name: "Customer support lead",
    handle: "support",
    team_id: team,
  });
  await expect(
    t.mutation(api.tasks.create, {
      api_token: apiToken,
      title: "Check incidents",
      assignee: role._id,
      workspace: "personal",
    }),
  ).rejects.toThrow("a team role cannot take it");
  expect(await t.run(({ db }) => db.query("tasks").collect())).toEqual([]);
});
