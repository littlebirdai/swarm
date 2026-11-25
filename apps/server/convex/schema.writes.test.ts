import { expect, test } from "bun:test";
import { defineSchema } from "convex/server";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import { hashToken } from "./apiTokens";
import schema from "./schema";
import { allModules } from "./testModules.testkit";

const strictSchema = defineSchema(schema.tables);
const apiToken = "schema-writes-test-token";

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
      role: "member",
      joined_at: 1,
    });
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
