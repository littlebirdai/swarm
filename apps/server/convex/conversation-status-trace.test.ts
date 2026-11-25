import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import { sessionMachine } from "@codecast/session-contract";
import { spawnSessionCore } from "./spawn";
import { api } from "./_generated/api";
import {
  asUser,
  scheduledJobs,
  serverTest,
} from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";

let limiterShard: ReturnType<typeof spyOn>;
beforeEach(() => {
  jest.useFakeTimers();
  limiterShard = spyOn(Math, "random").mockReturnValue(0.5);
});
afterEach(() => {
  limiterShard.mockRestore();
  jest.clearAllTimers();
  jest.useRealTimers();
});

const baseline = {
  childStashed: false,
  closed: false,
  commands: [],
  dismissed: false,
  killed: false,
  originalStatus: null,
  ownerDeviceId: null,
  stashHidden: null,
  stashed: false,
  status: "active",
};
const legacy = {
  complete: { counts: [8, 5, 10], state: { status: "completed" } },
  activate: { counts: [8, 5, 9] },
  kill: {
    counts: [26, 12, 34],
    state: { commands: ["kill_session"], killed: true, status: "completed" },
  },
  "hide kill": {
    counts: [35, 16, 42],
    state: {
      commands: ["kill_session"],
      dismissed: true,
      killed: true,
      status: "completed",
    },
  },
  close: {
    counts: [17, 9, 25],
    state: { closed: true, dismissed: true, commands: ["kill_session"] },
  },
  stash: { counts: [16, 9, 21], state: { stashed: true, childStashed: true } },
  restore: { counts: [8, 5, 12], state: { status: "completed" } },
  "web restore": {
    counts: [17, 9, 18],
    state: { stashed: true, status: "completed" },
  },
  retire: {
    counts: [35, 16, 49],
    state: {
      commands: ["kill_session"],
      dismissed: true,
      killed: true,
      status: "completed",
    },
  },
  "blocked pin": { counts: [16, 8, 17] },
  restart: {
    counts: [9, 7, 13],
    state: { commands: ["kill_session", "resume_session"] },
  },
  "restart twin": {
    counts: [9, 7, 13],
    state: { commands: ["kill_session", "resume_session"] },
  },
  "restart ghost": {
    counts: [11, 10, 16],
    state: { commands: ["kill_session", "resume_session"] },
  },
  "message fork": {
    counts: [33, 19, 38],
    state: {
      commands: ["fork_session", "resume_session"],
      originalStatus: "active",
    },
  },
  move: {
    counts: [10, 7, 13],
    state: { commands: ["resume_session"], ownerDeviceId: "target" },
  },
  reassign: {
    counts: [11, 7, 13],
    state: { commands: ["resume_session"], ownerDeviceId: "target" },
  },
  reparent: {
    counts: [16, 10, 20],
    state: { commands: ["resume_session"], ownerDeviceId: "target" },
  },
  "quick start": {
    counts: [12, 10, 15],
    state: { commands: ["start_session"], originalStatus: "active" },
  },
  "web start": {
    counts: [13, 10, 19],
    state: { commands: ["start_session"], originalStatus: "active" },
  },
  spawn: {
    counts: [3, 3, 4],
    jobs: [],
    state: { commands: ["start_session"], originalStatus: "active" },
  },
  "shared fork": {
    counts: [25, 14, 28],
    state: { originalStatus: "active", status: "completed" },
  },
} satisfies Record<
  string,
  {
    counts: number[];
    jobs?: string[];
    state?: Partial<Record<keyof typeof baseline, unknown>>;
  }
>;
type Scenario = keyof typeof legacy;
const session = "status-trace";

async function observe(scenario: Scenario) {
  const t = serverTest(true);
  const at = Date.now() - 1000;
  const { user, id, child, twin } = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "conversation status trace");
    const user = await rows.user();
    const revive = [
      "restore",
      "web restore",
      "restart",
      "restart twin",
    ].includes(scenario);
    const id = await rows.conversation(user, {
      session_id: session,
      title: "Status trace",
      message_count: 3,
      ...(scenario === "activate" ? { status: "completed" as const } : {}),
      ...(scenario === "shared fork" ? { share_token: "share-status" } : {}),
      ...(revive
        ? {
            status: "completed" as const,
            inbox_killed_at: at,
            inbox_dismissed_at: at,
            inbox_stashed_at: at,
          }
        : {}),
      ...(scenario === "blocked pin"
        ? { inbox_stashed_at: at, inbox_dismissed_at: at }
        : {}),
      ...(scenario === "stash" ? { inbox_stash_hidden: true } : {}),
      ...(["move", "reassign", "reparent"].includes(scenario)
        ? {
            status: "completed" as const,
            project_path: "/work/repo",
            git_root: "/work/repo",
          }
        : {}),
    });
    if (scenario === "stash")
      await db.patch(id, { agent_team_name: "team", agent_name: "lead" });
    const child =
      scenario === "stash"
        ? await rows.conversation(user, {
            spawned_by_conversation_id: id,
            agent_team_name: "team",
            agent_name: "worker",
            message_count: 2,
          })
        : null;
    const twin =
      scenario === "restart twin"
        ? await rows.conversation(user, {
            session_id: session,
            status: "completed",
            inbox_killed_at: at,
            inbox_dismissed_at: at,
          })
        : null;
    if (scenario === "restart twin" || scenario === "restart ghost")
      await db.delete(id);
    if (["move", "reassign", "reparent"].includes(scenario)) {
      await rows.device(user, { device_id: "target", last_seen: at });
    }
    return { user, id, child, twin };
  });
  const operation = await asUser(t, user).mutation(async (ctx) => {
    let target = twin ?? id;
    switch (scenario) {
      case "complete":
        await ctx.runMutation(api.conversations.markSessionCompleted, {
          conversation_id: id,
        });
        break;
      case "activate":
        await ctx.runMutation(api.conversations.markSessionActive, {
          conversation_id: id,
        });
        break;
      case "kill":
        await ctx.runMutation(api.conversations.killSession, {
          conversation_id: id,
          mark_completed: true,
        });
        break;
      case "hide kill":
      case "stash":
      case "restore":
        await ctx.runMutation(api.conversations.cliSetSessionVisibility, {
          session,
          action:
            scenario === "hide kill"
              ? "kill"
              : scenario === "stash"
                ? "dismiss"
                : "undismiss",
        });
        break;
      case "close":
      case "web restore":
        await ctx.runMutation(api.dispatch.dispatch, {
          action: scenario === "close" ? "closeSession" : "restoreSession",
          args: [id],
          patches: {
            conversations: {
              [id]: { inbox_dismissed_at: scenario === "close" ? at : null },
            },
          },
        });
        break;
      case "retire":
        await ctx.runMutation(api.conversations.cliRetireSession, {
          session,
          expected_message_count: 3,
        });
        break;
      case "blocked pin":
        await ctx.runMutation(api.conversations.setThreadState, {
          session,
          text: "Waiting",
          status: "blocked",
        });
        break;
      case "restart":
      case "restart twin":
      case "restart ghost":
        target = (
          await ctx.runMutation(api.conversations.restartSession, {
            conversation_id: id,
            session_id: session,
          })
        ).conversation_id;
        break;
      case "quick start":
        target = await ctx.runMutation(api.conversations.createQuickSession, {
          session_id: "new-session",
        });
        break;
      case "web start":
        await ctx.runMutation(api.dispatch.dispatch, {
          action: "createSession",
          args: [{ session_id: "web-session", agent_type: "claude_code" }],
        });
        target = (await ctx.db
          .query("conversations")
          .withIndex("by_session_id", (q) => q.eq("session_id", "web-session"))
          .unique())!._id;
        break;
      case "spawn":
        target = (await spawnSessionCore(ctx, user, { title: "Spawned" }))
          .conversationId;
        break;
      case "shared fork":
        target = await ctx.runMutation(api.conversations.forkConversation, {
          share_token: "share-status",
        });
        break;
      case "message fork":
        target = (
          await ctx.runMutation(api.conversations.forkFromMessage, {
            conversation_id: id,
            session_id: "new-fork",
          })
        ).conversation_id;
        break;
      case "move":
        await ctx.runMutation(api.devices.moveSessionToDevice, {
          conversation_id: id,
          owner_device_id: "target",
          project_path: "/work/repo",
        });
        break;
      case "reassign":
        await ctx.runMutation(api.devices.reassignToDevice, {
          conversation_id: id,
          device_id: "target",
        });
        break;
      case "reparent":
        await ctx.runMutation(api.devices.reparentSessionToDevice, {
          session_id: session,
          device_id: "target",
        });
        break;
    }
    const m = await ctx.meta.getTransactionMetrics();
    return {
      target,
      counts: [
        m.documentsRead.used,
        m.documentsWritten.used,
        m.databaseQueries.used,
      ],
    };
  });
  const jobs = (await scheduledJobs(t)).map((job) => job.name).sort();
  const state = await t.run(async ({ db }) => {
    const row = await db.get(operation.target);
    if (!row) throw new Error(`No result row for ${scenario}`);
    const original = operation.target === id ? null : await db.get(id);
    return {
      status: row.status,
      killed: !!row.inbox_killed_at,
      closed: !!row.inbox_closed_at,
      dismissed: !!row.inbox_dismissed_at,
      ownerDeviceId: row.owner_device_id ?? null,
      stashHidden: row.inbox_stash_hidden ?? null,
      stashed: !!row.inbox_stashed_at,
      childStashed: child ? !!(await db.get(child))?.inbox_stashed_at : false,
      commands: (await db.query("daemon_commands").collect()).map(
        (command) => command.command,
      ),
      originalStatus: original?.status ?? null,
    };
  });
  return { counts: operation.counts, jobs, state };
}

for (const scenario of Object.keys(legacy) as Scenario[]) {
  test(`${scenario} matches its conversation status trace`, async () => {
    const observed = await observe(scenario);
    const expected = legacy[scenario];
    expect(observed.counts).toEqual(expected.counts);
    expect(observed.jobs).toEqual(
      "jobs" in expected ? expected.jobs : ["syncOutbox:drain"],
    );
    expect(observed.state).toEqual({
      ...baseline,
      ...("state" in expected ? expected.state : {}),
    });
  });
}

test("conversation replay reports only the known lifecycle gaps", async () => {
  const scope = { session, run: 1 };
  const initial = sessionMachine.initial(scope);
  const ended = sessionMachine.apply(initial, {
    kind: "provider.event",
    event: {
      ...scope,
      v: 1,
      seq: 1,
      at: 1,
      source: "provider",
      turn: null,
      kind: "session.ended",
      body: { reason: "completed" },
    },
  }).state;
  const steps = [
    ["complete", ended.status],
    ["kill", initial.status],
    ["hide kill", initial.status],
    ["retire", initial.status],
    ["activate", ended.status],
    ["restart", ended.status],
    ["restart twin", ended.status],
    ["restart ghost", ended.status],
    ["move", ended.status],
    ["reassign", ended.status],
    ["reparent", ended.status],
    ["quick start", initial.status],
    ["web start", initial.status],
    ["spawn", initial.status],
    ["message fork", initial.status],
    ["shared fork", initial.status],
    ["close", initial.status],
    ["stash", initial.status],
    ["restore", ended.status],
    ["web restore", ended.status],
    ["blocked pin", initial.status],
  ] as const;
  const gaps = [];
  for (const [step, contract] of steps) {
    const { state } = await observe(step);
    if (state.status !== contract)
      gaps.push({ step, legacy: state.status, contract });
  }
  console.log("Conversation replay divergences", JSON.stringify(gaps));
  expect(gaps).toEqual([
    ...["kill", "hide kill", "retire"].map((step) => ({
      step,
      legacy: "completed",
      contract: "active",
    })),
    ...[
      "activate",
      "restart",
      "restart twin",
      "restart ghost",
      "move",
      "reassign",
      "reparent",
    ].map((step) => ({ step, legacy: "active", contract: "completed" })),
    { step: "shared fork", legacy: "completed", contract: "active" },
  ]);
});
