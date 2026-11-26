import { afterEach, beforeEach, expect, test } from "bun:test";
import { HEARTBEAT_ALIVE_MS } from "@codecast/sessions/agentStatus";
import { api } from "./_generated/api";
import {
  asUser,
  scheduledJobs,
  serverTest,
} from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";

let originalLeaseFlag: string | undefined;

beforeEach(() => {
  originalLeaseFlag = process.env.INBOX_LIVENESS_LEASES;
  process.env.INBOX_LIVENESS_LEASES = "1";
});

afterEach(() => {
  if (originalLeaseFlag === undefined) delete process.env.INBOX_LIVENESS_LEASES;
  else process.env.INBOX_LIVENESS_LEASES = originalLeaseFlag;
});

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
    single: [5, 1219, 1, 211, 4],
    batch: [4, 972, 1, 211, 3],
  },
  {
    name: "settled",
    before: "idle",
    after: "idle",
    sideRow: true,
    updated: 0,
    settles: false,
    single: [4, 1036, 0, 0, 4],
    batch: [3, 789, 0, 0, 3],
  },
  {
    name: "missing side row",
    before: "idle",
    after: "idle",
    sideRow: false,
    updated: 0,
    settles: false,
    single: [3, 856, 1, 180, 4],
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
    single: [7, 1831, 2, 573, 7],
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
