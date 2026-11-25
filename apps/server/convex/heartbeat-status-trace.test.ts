import { expect, test } from "bun:test";
import { api } from "./_generated/api";
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
    single: [5, 1326, 1, 326, 4],
    batch: [4, 1079, 1, 326, 3],
  },
  {
    name: "settled",
    before: "idle",
    after: "idle",
    sideRow: true,
    updated: 0,
    settles: false,
    single: [4, 997, 0, 0, 4],
    batch: [3, 750, 0, 0, 3],
  },
  {
    name: "missing side row",
    before: "idle",
    after: "idle",
    sideRow: false,
    updated: 0,
    settles: false,
    single: [3, 817, 1, 180, 4],
    batch: [2, 570, 1, 180, 3],
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
    single: [7, 1753, 2, 503, 7],
    batch: [6, 1506, 2, 503, 6],
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
    test(`${entry} heartbeat, ${name}, matches the legacy transaction trace`, async () => {
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
