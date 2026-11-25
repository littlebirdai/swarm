import { expect, test } from "bun:test";
import { api, internal } from "./_generated/api";
import {
  asUser,
  scheduledJobs,
  serverTest,
} from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";

type Counts = readonly [
  documentsRead: number,
  bytesRead: number,
  documentsWritten: number,
  bytesWritten: number,
  databaseQueries: number,
];

const cases = [
  {
    name: "daemon active",
    counts: [5, 1292, 2, 503, 5],
    before: "idle",
    after: "working",
  },
  {
    name: "daemon reassertion",
    counts: [5, 1298, 2, 503, 4],
    before: "working",
    after: "working",
  },
  {
    name: "daemon clears boundary",
    counts: [3, 978, 1, 320, 2],
    before: "idle",
    after: "idle",
    boundaryBefore: true,
  },
  {
    name: "daemon turn end",
    counts: [9, 2546, 3, 797, 15],
    before: "working",
    after: "idle",
    turnEnd: true,
  },
  {
    name: "daemon permission settle",
    counts: [4, 1252, 1, 320, 7],
    before: "permission_blocked",
    after: "idle",
  },
  {
    name: "daemon stale",
    counts: [2, 615, 0, 0, 2],
    before: "working",
    after: "idle",
    stale: true,
  },
  {
    name: "daemon park",
    counts: [4, 1224, 1, 349, 5],
    before: "idle",
    after: "hibernated",
    park: true,
  },
  {
    name: "daemon resume boundary",
    counts: [3, 990, 1, 343, 4],
    before: "hibernated",
    after: "idle",
    resume: true,
  },
  {
    name: "hosted seed",
    counts: [5, 1243, 4, 988, 7],
    route: "hosted",
    before: null,
    after: "working",
  },
  {
    name: "hosted unmarked",
    counts: [6, 1617, 3, 839, 5],
    route: "hosted",
    before: "idle",
    after: "working",
  },
  {
    name: "hosted existing",
    counts: [9, 2541, 3, 802, 15],
    route: "hosted",
    before: "working",
    after: "idle",
    hosted: true,
    turnEnd: true,
  },
] as const satisfies ReadonlyArray<
  { name: string; counts: Counts } & Record<string, unknown>
>;

for (const scenario of cases) {
  test(`${scenario.name} matches the pre-move status trace`, async () => {
    const t = serverTest(true);
    const at = Date.now() - 1000;
    const hosted = "route" in scenario;
    const { user, conversationId } = await t.run(async (ctx) => {
      const rows = fixtureRows(ctx.db, "status trace");
      const user = await rows.user();
      const conversationId = await rows.conversation(user, {
        session_id: "status-trace",
        agent_type: hosted ? "codecast" : "claude_code",
        activity: { text: "Reading", tool: "Read", at },
      });
      if (scenario.before) {
        const id = await ctx.db.insert("managed_sessions", {
          session_id: "status-trace",
          user_id: user,
          conversation_id: conversationId,
          started_at: at,
          pid: hosted ? 0 : 1,
          last_heartbeat: at,
          agent_status: scenario.before,
          agent_status_updated_at: at,
          agent_status_write_at: at,
          ...("boundaryBefore" in scenario
            ? { agent_status_boundary: true }
            : {}),
          ...("hosted" in scenario ? { hosted: true } : {}),
          ...("resume" in scenario ? { hibernated_at: at } : {}),
        });
        await ctx.db.insert("session_heartbeats", {
          managed_session_id: id,
          user_id: user,
          heartbeat_at: at,
        });
      }
      return { user, conversationId };
    });
    const trace = await asUser(t, user).mutation(async (ctx) => {
      const args = {
        conversation_id: conversationId,
        agent_status: scenario.after,
        ...("turnEnd" in scenario ? { turn_completed_at: at + 2 } : {}),
      };
      const result = hosted
        ? await ctx.runMutation(
            internal.managedSessions.setHostedAgentStatus,
            args,
          )
        : await ctx.runMutation(api.managedSessions.updateAgentStatus, {
            ...args,
            client_ts: at + ("stale" in scenario ? -1 : 1),
            ...("park" in scenario ? { hibernated_at: at + 1 } : {}),
            ...("resume" in scenario
              ? { hibernated_at: null, session_boundary: true }
              : {}),
          });
      const m = await ctx.meta.getTransactionMetrics();
      return {
        result,
        counts: [
          m.documentsRead.used,
          m.bytesRead.used,
          m.documentsWritten.used,
          m.bytesWritten.used,
          m.databaseQueries.used,
        ],
      };
    });
    const jobs = (await scheduledJobs(t)).map((job) => job.name).sort();
    const persisted = await t.run(async (ctx) => {
      const row = await ctx.db
        .query("managed_sessions")
        .withIndex("by_conversation_id", (q) =>
          q.eq("conversation_id", conversationId),
        )
        .unique();
      if ("boundaryBefore" in scenario)
        expect(row?.agent_status_boundary).toBeUndefined();
      const conv = await ctx.db.get(conversationId);
      const beats = await ctx.db.query("session_heartbeats").collect();
      return {
        agent: row?.agent_status,
        boundary: row?.agent_status_boundary === true,
        parked: row?.hibernated_at !== undefined,
        turnEnded: row?.turn_completed_at === at + 2,
        hosted: row?.hosted === true,
        activity: !!conv?.activity,
        mirrorsAgree:
          beats.length === 1 && beats[0].heartbeat_at === row?.last_heartbeat,
      };
    });
    const stale = "stale" in scenario;
    const ended = "turnEnd" in scenario;
    expect(trace.counts).toEqual(scenario.counts);
    expect(trace.result).toEqual(
      stale ? { applied: false, reason: "stale_status" } : { applied: true },
    );
    expect(jobs).toEqual(
      ended || scenario.before === "permission_blocked"
        ? ["idleSummary:classifySettle", "notifications:checkNeedsInput"]
        : [],
    );
    expect(persisted).toEqual({
      agent: stale ? scenario.before : scenario.after,
      activity: !ended,
      boundary: "resume" in scenario,
      parked: "park" in scenario,
      turnEnded: ended,
      hosted,
      mirrorsAgree: true,
    });
  });
}
