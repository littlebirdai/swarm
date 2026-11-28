// The line's review station (the-line.md L3, final product review): spawned
// with review_for_task, the new session is stamped review_of_task_id and
// filed under no role, while the role doing the task's work pays for it
// from its hand cap. Spawned with spawner_session instead, the same role's
// session would make it a hand (org_role_id).
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { createSessionFromCli } from "./spawn";

const OWNER = "users_owner";
const ROLE = "org_roles_r";

function fixture(roleExtra: Record<string, any> = {}) {
  const tables: Record<string, any[]> = {
    users: [{ _id: OWNER, name: "Owner" }],
    org_roles: [
      {
        _id: ROLE,
        short_id: "or-1",
        name: "Infra",
        handle: "infra",
        status: "active",
        trust: "direct",
        host_user_id: OWNER,
        scope_type: "user",
        scope_user_id: OWNER,
        ...roleExtra,
      },
    ],
    tasks: [
      {
        _id: "tasks_1",
        short_id: "ct-1",
        title: "Add the thing",
        user_id: OWNER,
        status: "in_review",
        conversation_ids: ["conversations_hand"],
      },
    ],
    conversations: [
      {
        _id: "conversations_hand",
        user_id: OWNER,
        session_id: "hand-uuid",
        status: "active",
        org_role_id: ROLE,
        active_task_id: "tasks_1",
      },
    ],
    managed_sessions: [],
  };
  const db = makeFakeDb(tables);
  const ctx = {
    db,
    auth: { getUserIdentity: async () => ({ subject: `${OWNER}|session` }) },
  } as any;
  return { ctx, tables, db };
}

describe("cast spawn review_for_task", () => {
  test("the review hand is stamped review_of_task_id, carries no role, and counts against the role's cap", async () => {
    const { ctx, tables, db } = fixture();
    const result = await (createSessionFromCli as any)._handler(ctx, {
      agent_type: "codex",
      review_for_task: "ct-1",
      prompt: "review it",
    });
    const row = await db.get(result.conversation_id);
    expect(row.review_of_task_id).toBe("tasks_1");
    expect(row.org_role_id).toBeUndefined();
    expect(row.spawned_by_conversation_id).toBeUndefined();
    expect(tables.org_roles[0].counters.hands).toBe(1);
  });

  test("resolves the role from a live cross-workspace claim holder not in conversation_ids", async () => {
    const { ctx, tables } = fixture();
    tables.tasks[0].conversation_ids = [];
    tables.claims = [
      {
        _id: "claims_1",
        kind: "task",
        task_id: "tasks_1",
        holder: OWNER,
        token: 1,
        lease_until: Date.now() + 60_000,
        task: { conversation_id: "conversations_hand" },
      },
    ];
    await (createSessionFromCli as any)._handler(ctx, {
      agent_type: "codex",
      review_for_task: "ct-1",
      prompt: "review it",
    });
    expect(tables.org_roles[0].counters.hands).toBe(1);
  });

  test("the role's cap gates the review hand too", async () => {
    const { ctx } = fixture({
      caps: { hands_per_day: 1, wakes_per_day: 10, tokens_per_day: 1000000 },
      counters: {
        day: new Date().toISOString().slice(0, 10),
        hands: 1,
        wakes: 0,
        tokens: 0,
      },
    });
    await expect(
      (createSessionFromCli as any)._handler(ctx, {
        agent_type: "codex",
        review_for_task: "ct-1",
      }),
    ).rejects.toThrow(/today's limit of 1 hands/);
  });

  test("a task with no role behind it spawns a plain reviewer and counts nothing", async () => {
    const { ctx, tables, db } = fixture();
    delete tables.conversations[0].org_role_id;
    const result = await (createSessionFromCli as any)._handler(ctx, {
      agent_type: "codex",
      review_for_task: "ct-1",
    });
    const row = await db.get(result.conversation_id);
    expect(row.review_of_task_id).toBe("tasks_1");
    expect(tables.org_roles[0].counters).toBeUndefined();
  });

  test("an unknown task is refused", async () => {
    const { ctx } = fixture();
    await expect(
      (createSessionFromCli as any)._handler(ctx, {
        agent_type: "codex",
        review_for_task: "ct-404",
      }),
    ).rejects.toThrow(/Task not found/);
  });

  test("spawned as the role's hand instead, the same session is filed under the role", async () => {
    const { ctx, db } = fixture();
    const result = await (createSessionFromCli as any)._handler(ctx, {
      agent_type: "codex",
      spawner_session: "hand-uuid",
    });
    const row = await db.get(result.conversation_id);
    expect(row.org_role_id).toBe(ROLE);
    expect(row.review_of_task_id).toBeUndefined();
  });

  test("teammate cannot inspect or consume a private cross-workspace claim holder role", async () => {
    const { tables, db } = fixture({
      caps: { hands_per_day: 1, wakes_per_day: 10, tokens_per_day: 1000000 },
      counters: {
        day: new Date().toISOString().slice(0, 10),
        hands: 1,
        wakes: 0,
        tokens: 0,
      },
    });
    const TEAMMATE = "users_teammate";
    const TEAM = "teams_t1";
    tables.users.push({ _id: TEAMMATE, name: "Teammate" });
    tables.team_memberships = [
      { _id: "tm_1", user_id: OWNER, team_id: TEAM },
      { _id: "tm_2", user_id: TEAMMATE, team_id: TEAM },
    ];
    tables.tasks[0].team_id = TEAM;
    tables.tasks[0].workspace = `team:${TEAM}`;
    tables.tasks[0].conversation_ids = [];
    tables.conversations[0].is_private = true;
    delete tables.conversations[0].team_id;
    tables.claims = [
      {
        _id: "claims_1",
        kind: "task",
        task_id: "tasks_1",
        holder: OWNER,
        token: 1,
        lease_until: Date.now() + 60_000,
        task: { conversation_id: "conversations_hand" },
      },
    ];
    const teammateCtx = {
      db,
      auth: {
        getUserIdentity: async () => ({ subject: `${TEAMMATE}|session` }),
      },
    } as any;
    const result = await (createSessionFromCli as any)._handler(teammateCtx, {
      agent_type: "codex",
      review_for_task: "ct-1",
      prompt: "review it",
    });
    const row = await db.get(result.conversation_id);
    expect(row.review_of_task_id).toBe("tasks_1");
    expect(tables.org_roles[0].counters.hands).toBe(1);
  });
});
