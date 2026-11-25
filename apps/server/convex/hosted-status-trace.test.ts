import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import { sessionMachine, type SessionFact } from "@codecast/session-contract";
import { api, internal } from "./_generated/api";
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

const legacyState = {
  agent: null,
  continues: false,
  pin: null,
  result: null,
  stashed: false,
  stop: null,
  turns: [],
};
const drain = "syncOutbox:drain";
const runJobs = ["assistant/turns:expire", "assistant/turns:run"];
const legacy = {
  "hosted start": {
    counts: [12, 11, 17],
    jobs: [drain],
    state: { agent: "idle" },
  },
  queue: {
    counts: [8, 4, 23],
    jobs: [],
    state: { agent: "waiting", turns: ["queued"] },
  },
  "start turn": {
    counts: [21, 14, 33],
    jobs: [...runJobs, drain],
    state: { agent: "working", turns: ["running"] },
  },
  promote: {
    counts: [17, 10, 26],
    jobs: runJobs,
    state: { agent: "working", turns: ["running"] },
  },
  "budget stop": {
    counts: [43, 22, 51],
    jobs: [drain, "titleGeneration:generateTitle"],
    state: { agent: "idle", stop: "budget", turns: ["done"] },
  },
  "resume approval": {
    counts: [8, 3, 10],
    jobs: [],
    state: { continues: true, turns: ["done", "running"] },
  },
  "pin blocked": {
    counts: [16, 8, 17],
    jobs: [drain],
    state: { pin: "blocked", result: '{"ready":true}' },
  },
  "replace pin": {
    counts: [7, 4, 10],
    jobs: [drain],
    state: { pin: "done", stashed: true },
  },
} as const;
const session = "status-trace";

async function observeStatus(scenario: keyof typeof legacy) {
  const t = serverTest(true);
  const at = Date.now();
  const pin = scenario === "pin blocked" || scenario === "replace pin";
  const { user, conversationId, target } = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "hosted status trace");
    const user = await rows.user({ emailVerificationTime: 1 });
    const conversationId = await rows.conversation(user, {
      session_id: session,
      agent_type: pin ? "claude_code" : "codecast",
      title: "Status fixture",
      ...(scenario === "start turn" ? { hosted_stop: "budget" } : {}),
      ...(pin
        ? {
            inbox_stashed_at: at,
            thread_state_result: "{}",
            thread_state_result_at: at,
          }
        : {}),
    });
    const turn = {
      user_id: user,
      conversation_id: conversationId,
      cost_reserved_usd: 0,
    };
    if (scenario === "queue") {
      for (let i = 0; i < 2; i++) {
        const other = await rows.conversation(user, {
          agent_type: "codecast",
        });
        await db.insert("assistant_turns", {
          ...turn,
          conversation_id: other,
          status: "running",
          started_at: at,
        });
      }
    }
    if (
      scenario === "queue" ||
      scenario === "start turn" ||
      scenario === "promote"
    )
      await db.insert("pending_messages", {
        conversation_id: conversationId,
        from_user_id: user,
        content: "Continue",
        created_at: at,
        status: "pending",
        human: true,
        retry_count: 0,
      });
    if (scenario === "promote")
      await db.insert("assistant_turns", { ...turn, status: "queued" });
    if (scenario === "resume approval")
      await db.insert("assistant_turns", {
        ...turn,
        status: "waiting",
        reason: "approval",
        ended_at: at,
      });
    const target =
      scenario === "budget stop" || scenario === "resume approval"
        ? await db.insert("assistant_turns", {
            ...turn,
            status: "running",
            started_at: at,
            model: "claude-haiku-5-5",
          })
        : null;
    return { user, conversationId, target };
  });
  const trace = await asUser(t, user).mutation(async (ctx) => {
    if (scenario === "hosted start") {
      const result = await ctx.runMutation(
        api.assistant.entry.startConversation,
        {
          session_id: "hosted-new",
          title: "New hosted",
        },
      );
      expect(result.conversation_id).toBeDefined();
    } else if (scenario === "budget stop" && target) {
      await ctx.runMutation(internal.assistant.turns.finish, {
        turn_id: target,
        reason: "budget",
        cost_usd: 0,
        pending: [],
      });
    } else if (scenario === "resume approval" && target) {
      expect(
        await ctx.runMutation(internal.assistant.turns.begin, {
          turn_id: target,
        }),
      ).not.toBeNull();
    } else if (pin) {
      await ctx.runMutation(api.conversations.setThreadState, {
        session,
        text: "Progress",
        status: scenario === "pin blocked" ? "blocked" : "done",
        ...(scenario === "pin blocked" ? { result: '{"ready":true}' } : {}),
      });
    } else {
      await ctx.runMutation(internal.assistant.entry.wake, {
        conversation_id: conversationId,
        cause: "message",
      });
    }
    const m = await ctx.meta.getTransactionMetrics();
    return [
      m.documentsRead.used,
      m.documentsWritten.used,
      m.databaseQueries.used,
    ];
  });
  const jobs = (await scheduledJobs(t)).map((job) => job.name).sort();
  const state = await t.run(async ({ db }) => {
    const conv =
      scenario === "hosted start"
        ? await db
            .query("conversations")
            .withIndex("by_session_id", (q) => q.eq("session_id", "hosted-new"))
            .unique()
        : await db.get(conversationId);
    if (!conv) throw new Error("Missing conversation");
    const turns = (await db.query("assistant_turns").collect()).filter(
      (row) => row.conversation_id === conv._id,
    );
    const managed = await db
      .query("managed_sessions")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conv._id))
      .unique();
    return {
      turns: turns.map((row) => row.status),
      continues: !!turns.find((row) => row.continues),
      stop: conv.hosted_stop ?? null,
      pin: conv.thread_state_status ?? null,
      result: conv.thread_state_result ?? null,
      stashed: !!conv.inbox_stashed_at,
      agent: managed?.agent_status ?? null,
    };
  });
  return { trace, jobs, state };
}

for (const scenario of Object.keys(legacy) as Array<keyof typeof legacy>) {
  test(`${scenario} matches the legacy status trace`, async () => {
    const observed = await observeStatus(scenario);
    const expected = legacy[scenario];
    expect(observed.trace).toEqual(expected.counts);
    expect(observed.jobs).toEqual(expected.jobs);
    expect(observed.state).toEqual({ ...legacyState, ...expected.state });
  });
}

test("hosted turns and thread pins replay with only the known gaps", async () => {
  const scope = { session, run: 1 };
  const envelope = { ...scope, v: 1, source: "provider" } as const;
  const events: SessionFact[] = [
    {
      kind: "provider.event",
      event: {
        ...envelope,
        seq: 1,
        at: 1,
        kind: "session.started",
        turn: null,
        body: {},
      },
    },
    {
      kind: "provider.event",
      event: {
        ...envelope,
        seq: 2,
        at: 2,
        kind: "turn.started",
        turn: "first",
        body: {},
      },
    },
    {
      kind: "provider.event",
      event: {
        ...envelope,
        seq: 3,
        at: 3,
        kind: "prompt.opened",
        turn: "first",
        body: { prompt_id: "notice", kind: "permission" },
      },
    },
    {
      kind: "provider.event",
      event: {
        ...envelope,
        seq: 4,
        at: 4,
        kind: "prompt.settled",
        turn: "first",
        body: {
          prompt_id: "notice",
          by: { kind: "person", id: "owner" },
          answer: true,
        },
      },
    },
  ];
  const states = [sessionMachine.initial(scope)];
  for (const fact of events) {
    states.push(sessionMachine.apply(states[states.length - 1], fact).state);
  }
  const [, ready, running, , resumed] = states;
  const start = (await observeStatus("start turn")).state;
  expect(start.turns).toEqual([running.turn.status]);

  const queued = (await observeStatus("queue")).state;
  const stopped = (await observeStatus("budget stop")).state;
  const approval = (await observeStatus("resume approval")).state;
  const pin = (await observeStatus("pin blocked")).state;
  const gaps = {
    queue: [queued.turns[0], ready.turn.status],
    budget: [stopped.turns[0], running.turn.status],
    approval: [approval.turns, [resumed.turn.status]],
    pin: [pin.stashed, sessionMachine.whoActsNext(ready, "blocked")],
  };
  console.log("Hosted status replay gaps", gaps);
  expect(gaps).toEqual({
    queue: ["queued", "none"],
    budget: ["done", "running"],
    approval: [["done", "running"], ["running"]],
    pin: [false, "needs_input"],
  });
});
