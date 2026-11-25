import { afterEach, beforeEach, jest } from "bun:test";
import type { FunctionArgs } from "convex/server";
import { asUser, scheduledJobs, serverTest } from "./database.testkit";
import { fixtureRows, type NewRow } from "./rows.testkit";
import { api, internal } from "../convex/_generated/api";
import type { Id, TableNames } from "../convex/_generated/dataModel";
import { patchPullRequest } from "../convex/prShepherd";
import {
  settleClientResolution,
  withdrawCore,
} from "../convex/sessionDecisions";

export const USER = "u_user";
export const TEAM = "team_1";
export const REPO = "acme/app";
const TOKEN = "task-waits-test-token";

export function waitClock() {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });
}

export const task = (
  shortId: string,
  fields: Record<string, unknown> = {},
) => ({
  _id: `task_${shortId}`,
  short_id: shortId,
  title: `Task ${shortId}`,
  status: "open",
  priority: "medium",
  source: "human",
  project_path: "/src/app",
  created_at: 1,
  updated_at: 1,
  ...fields,
});

export const pr = (number: number, fields: Record<string, unknown> = {}) => ({
  _id: `pr_${number}`,
  github_pr_id: number,
  repository: REPO,
  number,
  title: `PR ${number}`,
  body: "",
  state: "open",
  author_github_username: "someone",
  linked_session_ids: [],
  created_at: 1,
  updated_at: 1,
  ...fields,
});

export const decision = (n: number, fields: Record<string, unknown> = {}) => ({
  _id: `dec_${n}`,
  short_id: `sd-${n}`,
  conversation_id: "conv_asker",
  session_id: "s",
  question: "Ship it?",
  blocking: true,
  options: [{ label: "Ship it" }, { label: "Hold" }],
  status: "pending",
  created_at: 1,
  ...fields,
});

export const owner = (taskShortId: string) => ({
  _id: "conv_owner",
  short_id: "jx7own",
  status: "active",
  active_task_id: `task_${taskShortId}`,
  updated_at: 1,
});

type Seeds = Partial<
  Record<
    | "tasks"
    | "pull_requests"
    | "session_decisions"
    | "conversations"
    | "session_owners"
    | "conversation_execution_heads"
    | "github_app_installations",
    (Record<string, any> & { _id: string })[]
  >
>;

export async function setup(seeds: Seeds) {
  const t = serverTest();
  const ids = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "task waits");
    const user = await rows.user({ name: "User" });
    const bob = await rows.user({ name: "Bob", github_username: "bob" });
    const team = await rows.team();
    const otherTeam = await rows.team();
    await rows.membership(user, team);
    await rows.token(user, TOKEN);
    await db.insert("directory_team_mappings", {
      user_id: user,
      path_prefix: "/src/app",
      repository: REPO,
      auto_share: false,
      created_at: 1,
    });
    const users: Record<string, Id<"users">> = { [USER]: user, u_bob: bob };
    const conversations: Record<string, Id<"conversations">> = {};
    for (const {
      _id,
      user_id,
      team_id,
      active_task_id: _,
      ...fields
    } of seeds.conversations ?? []) {
      conversations[_id] = await rows.conversation(users[user_id] ?? user, {
        team_id: team_id ? team : undefined,
        ...fields,
      });
    }
    if (
      !conversations.conv_asker &&
      seeds.session_decisions?.some(
        (seed) => seed.conversation_id === "conv_asker",
      )
    ) {
      const asker = await rows.conversation(user);
      await db.delete(asker);
      conversations.conv_asker = asker;
    }
    const plan = seeds.tasks?.some((seed) => seed.plan_id)
      ? await rows.plan(user)
      : undefined;
    const tasks: Record<string, Id<"tasks">> = {};
    for (const {
      _id,
      user_id,
      team_id,
      assignee,
      plan_id,
      parent_id: _,
      conversation_ids,
      ...fields
    } of seeds.tasks ?? []) {
      const taskUser = users[user_id] ?? user;
      tasks[_id] = await rows.task(taskUser, {
        ...fields,
        team_id: team_id ? team : undefined,
        assignee: users[assignee] ?? assignee,
        plan_id: plan_id ? plan : undefined,
        conversation_ids: conversation_ids?.map(
          (label: string) => conversations[label],
        ),
      });
    }
    for (const seed of seeds.tasks ?? []) {
      const blockedBy = seed.blocked_by as string[] | undefined;
      if (!seed.parent_id && !blockedBy?.some((ref) => tasks[ref])) continue;
      await db.patch(tasks[seed._id], {
        parent_id: tasks[seed.parent_id],
        blocked_by: blockedBy?.map((ref) => tasks[ref] ?? ref),
      });
    }
    for (const seed of seeds.conversations ?? []) {
      if (seed.active_task_id)
        await db.patch(conversations[seed._id], {
          active_task_id: tasks[seed.active_task_id],
        });
    }
    if (plan)
      await db.patch(plan, {
        task_ids: (seeds.tasks ?? [])
          .filter((row) => row.plan_id)
          .map((row) => tasks[row._id]),
      });

    const pullRequests: Record<string, Id<"pull_requests">> = {};
    for (const { _id, team_id, ...fields } of seeds.pull_requests ?? []) {
      pullRequests[_id] = await db.insert("pull_requests", {
        ...fields,
        team_id: team_id === "team_other" ? otherTeam : team,
      } as NewRow<"pull_requests">);
    }
    const decisions: Record<string, Id<"session_decisions">> = {};
    for (const {
      _id,
      user_id,
      conversation_id,
      ...fields
    } of seeds.session_decisions ?? []) {
      decisions[_id] = await db.insert("session_decisions", {
        ...fields,
        user_id: users[user_id] ?? user,
        conversation_id: conversations[conversation_id],
      } as NewRow<"session_decisions">);
    }
    for (const { conversation_id, user_id, added_by } of seeds.session_owners ??
      []) {
      await db.insert("session_owners", {
        conversation_id: conversations[conversation_id],
        user_id: users[user_id],
        added_by: users[added_by],
        added_at: 1,
      });
    }
    for (const { conversation_id } of seeds.conversation_execution_heads ??
      []) {
      await db.insert("conversation_execution_heads", {
        conversation_id: conversations[conversation_id],
        owner_user_id: user,
        protocol_state: "legacy-quiescing",
        protocol_version: 1,
        next_conversation_sequence: 1,
        next_nonterminal_sequence: 1,
        created_at: 1,
        updated_at: 1,
      });
    }
    for (const {
      _id,
      scope_user_id,
      ...fields
    } of seeds.github_app_installations ?? []) {
      await db.insert("github_app_installations", {
        ...fields,
        scope_user_id: users[scope_user_id],
      } as NewRow<"github_app_installations">);
    }
    return {
      user,
      bob,
      team,
      otherTeam,
      tasks,
      conversations,
      decisions,
      pullRequests,
    };
  });
  const actor = asUser(t, ids.user);
  const id = (shortId: string) => ids.tasks[`task_${shortId}`];
  const decisionId = (n: number) => ids.decisions[`dec_${n}`];
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
  const drain = async () => {
    for (const job of await scheduledJobs(t)) {
      if (job.state.kind !== "pending") continue;
      if (job.name === "taskWaits:settlePr") {
        await t.run(({ scheduler }) => scheduler.cancel(job._id));
        await t.mutation(internal.taskWaits.settlePr, job.args[0]);
      } else if (job.name === "taskWaits:settleDecision") {
        await t.run(({ scheduler }) => scheduler.cancel(job._id));
        await t.mutation(internal.taskWaits.settleDecision, job.args[0]);
      }
    }
  };
  const answer = async (
    n: number,
    verdict: Partial<NewRow<"session_decisions">>,
    settle = true,
  ) => {
    await t.run(async (ctx) => {
      const id = decisionId(n);
      const pending = (await ctx.db.get(id))!;
      await ctx.db.patch(id, verdict);
      await settleClientResolution(ctx, pending, verdict, ids.user, Date.now());
    });
    if (settle) await drain();
  };
  return {
    ...ids,
    t,
    actor,
    id,
    decisionId,
    read,
    row,
    drain,
    answer,
    add: (
      args: Omit<FunctionArgs<typeof api.taskWaits.addWait>, "api_token">,
    ) => t.mutation(api.taskWaits.addWait, { api_token: TOKEN, ...args }),
    remove: (
      args: Omit<FunctionArgs<typeof api.taskWaits.removeWait>, "api_token">,
    ) => t.mutation(api.taskWaits.removeWait, { api_token: TOKEN, ...args }),
    create: (args: Omit<FunctionArgs<typeof api.tasks.create>, "api_token">) =>
      t.mutation(api.tasks.create, { api_token: TOKEN, ...args }),
    update: (args: Omit<FunctionArgs<typeof api.tasks.update>, "api_token">) =>
      t.mutation(api.tasks.update, { api_token: TOKEN, ...args }),
    comments: async (shortId: string) =>
      (await read("task_comments"))
        .filter((comment) => comment.task_id === id(shortId))
        .map((comment) => `${comment.comment_type}: ${comment.text}`),
    wakes: async () =>
      (await read("pending_messages")).map((message) => message.content),
    timed: async () =>
      (await scheduledJobs(t, internal.taskWaits.settleTimeWait)).map(
        (job) => ({ at: job.scheduledTime, args: job.args[0] }),
      ),
    reopen: (n: number) =>
      actor.mutation(api.sessionDecisions.reopen, {
        decision_id: decisionId(n),
      }),
    roleAnswer: (n: number) =>
      t.run(async ({ db }) => {
        const rows = fixtureRows(db, "role grant on decision");
        const role = await rows.role(ids.user);
        const grant = await db.insert("decision_grants", {
          role_id: role,
          category: "review",
          scope_key: `role:${role}`,
          granted_by: ids.user,
          granted_at: 1,
          expires_at: Date.now() + 60_000,
        });
        await db.patch(decisionId(n), {
          status: "answered",
          answer_index: 0,
          answered_by: { kind: "role", id: role },
          grant_id: grant,
        });
      }),
    withdraw: (n: number, origin?: Id<"conversations">) =>
      t.run(async (ctx) =>
        withdrawCore(
          ctx,
          (await ctx.db.get(decisionId(n)))!,
          Date.now(),
          origin,
        ),
      ),
    movePr: async (
      number: number,
      fields: Partial<NewRow<"pull_requests">>,
    ) => {
      await t.run((ctx) =>
        patchPullRequest(ctx, ids.pullRequests[`pr_${number}`], fields),
      );
      await drain();
    },
  };
}
