import { expect, test } from "bun:test";
import { HEARTBEAT_ALIVE_MS } from "@codecast/sessions/agentStatus";
import { api } from "./_generated/api";
import { TASK_LEASE_MS } from "./lib/claims";
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
    name: "working",
    before: "working",
    after: "working",
    sideRow: true,
    updated: 1,
    settles: false,
    single: [4, 972, 1, 211, 3],
    batch: [4, 972, 1, 211, 3],
  },
  {
    name: "settled",
    before: "idle",
    after: "idle",
    sideRow: true,
    updated: 0,
    settles: false,
    single: [3, 789, 0, 0, 3],
    batch: [3, 789, 0, 0, 3],
  },
  {
    name: "missing side row",
    before: "idle",
    after: "idle",
    sideRow: false,
    updated: 0,
    settles: false,
    single: [2, 609, 1, 180, 3],
    batch: [2, 609, 1, 180, 3],
  },
  {
    name: "missing managed row",
    before: null,
    after: "working",
    sideRow: false,
    updated: 0,
    settles: false,
    single: [0, 0, 0, 0, 1],
    batch: [0, 0, 0, 0, 1],
  },
  {
    name: "settle transition",
    before: "working",
    after: "idle",
    sideRow: true,
    updated: 1,
    settles: true,
    single: [6, 1584, 2, 573, 6],
    batch: [6, 1584, 2, 573, 6],
  },
] as const satisfies ReadonlyArray<{
  name: string;
  before: "working" | "idle" | null;
  after: "working" | "idle";
  sideRow: boolean;
  updated: number;
  settles: boolean;
  single: Counts;
  batch: Counts;
}>;

for (const entry of ["single", "batch"] as const) {
  for (const scenario of cases) {
    const { name, before, after, sideRow, updated, settles } = scenario;
    test(`${entry} heartbeat, ${name}, stays within the transaction budget`, async () => {
      const t = serverTest(true);
      const at = Date.now();
      const sessionId = "heartbeat-trace";
      const user = await t.run(async (ctx) => {
        const rows = fixtureRows(ctx.db, "heartbeat trace");
        const userId = await rows.user();
        if (before !== null) {
          const conversationId = await rows.conversation(userId, {
            session_id: sessionId,
          });
          const managedId = await ctx.db.insert("managed_sessions", {
            session_id: sessionId,
            user_id: userId,
            conversation_id: conversationId,
            pid: 1,
            started_at: at - 1000,
            last_heartbeat: at - 1000,
            agent_status: before,
            agent_status_updated_at: at - 1000,
            agent_status_write_at: at - 1000,
            liveness_lease: {
              end: at - 1000 + HEARTBEAT_ALIVE_MS,
              expired: false,
            },
          });
          if (sideRow)
            await ctx.db.insert("session_heartbeats", {
              managed_session_id: managedId,
              user_id: userId,
              heartbeat_at: at - 1000,
            });
        }
        return userId;
      });
      const trace = await asUser(t, user).mutation(async (ctx) => {
        const beat = {
          session_id: sessionId,
          agent_status: after,
          client_ts: at,
        };
        const result =
          entry === "single"
            ? await ctx.runMutation(api.managedSessions.heartbeat, beat)
            : await ctx.runMutation(api.managedSessions.heartbeatBatch, {
                sessions: [beat],
              });
        const metrics = await ctx.meta.getTransactionMetrics();
        const counts: Counts = [
          metrics.documentsRead.used,
          metrics.bytesRead.used,
          metrics.documentsWritten.used,
          metrics.bytesWritten.used,
          metrics.databaseQueries.used,
        ];
        return { result, counts };
      });
      expect(trace.counts).toEqual(scenario[entry]);
      expect(trace.result).toEqual(
        entry === "single"
          ? before === null
            ? { found: false }
            : { found: true, dismissed: false }
          : { updated, unknown: before === null ? [sessionId] : [] },
      );
      const jobs = (await scheduledJobs(t)).map((job) => job.name).sort();
      expect(jobs).toEqual(
        settles
          ? ["idleSummary:classifySettle", "notifications:checkNeedsInput"]
          : [],
      );
    });
  }
}

for (const entry of ["single", "batch"] as const) {
  test(`${entry} heartbeat with a bound task stays within its budget`, async () => {
    const t = serverTest(true);
    const at = Date.now();
    const sessionId = "heartbeat-bound-task";
    const { userId, taskId } = await t.run(async (ctx) => {
      const rows = fixtureRows(ctx.db, "heartbeat bound trace");
      const userId = await rows.user();
      const taskId = await rows.task(userId, { short_id: "ct-900" });
      const conversationId = await rows.conversation(userId, {
        session_id: sessionId,
        active_task_id: taskId,
      });
      const managedId = await ctx.db.insert("managed_sessions", {
        session_id: sessionId,
        user_id: userId,
        conversation_id: conversationId,
        pid: 1,
        started_at: at - 1000,
        last_heartbeat: at - 1000,
        agent_status: "working",
        agent_status_updated_at: at - 1000,
        agent_status_write_at: at - 1000,
        liveness_lease: {
          end: at - 1000 + HEARTBEAT_ALIVE_MS,
          expired: false,
        },
      });
      await ctx.db.insert("session_heartbeats", {
        managed_session_id: managedId,
        user_id: userId,
        heartbeat_at: at - 1000,
      });
      await ctx.db.insert("claims", {
        kind: "task",
        task_id: taskId,
        holder: userId,
        token: 1,
        lease_until: at + TASK_LEASE_MS / 2 - 1,
        request_id: "bound-req",
        request_holder: userId,
        task: { conversation_id: conversationId },
      });
      return { userId, taskId };
    });
    const trace = await asUser(t, userId).mutation(async (ctx) => {
      const beat = {
        session_id: sessionId,
        agent_status: "working" as const,
        client_ts: at,
      };
      if (entry === "single") {
        await ctx.runMutation(api.managedSessions.heartbeat, beat);
      } else {
        await ctx.runMutation(api.managedSessions.heartbeatBatch, {
          sessions: [beat],
        });
      }
      const metrics = await ctx.meta.getTransactionMetrics();
      return [
        metrics.documentsRead.used,
        metrics.bytesRead.used,
        metrics.documentsWritten.used,
        metrics.bytesWritten.used,
        metrics.databaseQueries.used,
      ] as const;
    });
    const claim = await t.run(({ db }) =>
      db
        .query("claims")
        .withIndex("by_task_kind", (q) =>
          q.eq("task_id", taskId).eq("kind", "task"),
        )
        .unique(),
    );
    expect(claim?.lease_until).toBeGreaterThanOrEqual(at + TASK_LEASE_MS);
    expect(trace).toEqual([6, 1673, 2, 532, 4]);
  });
}
