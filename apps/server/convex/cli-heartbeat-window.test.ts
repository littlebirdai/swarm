import { afterEach, expect, spyOn, test } from "bun:test";
import { inboxForCLI } from "./cliInbox";
import { listInboxSessions } from "./inboxLists";
import { sessionsLiveness } from "./inboxLiveness";
import { _resetChildAuqProbeCacheForTests } from "./lib/inboxLivenessPlacement";
import schema from "./schema";
import { makeFakeDb, schemaIndexes } from "./testDb";

const minute = 60_000;
const now = 1_800_000_000_000;
const viewer = "users_viewer";
const old = now - 45 * minute;

afterEach(() => _resetChildAuqProbeCacheForTests());

function account(age: number, source: "lease" | "legacy" | "rollback") {
  const conversations: Record<string, unknown>[] = [];
  const managed_sessions: Record<string, unknown>[] = [];
  const session_heartbeats: Record<string, unknown>[] = [];
  const beat = now - age;
  const session = (
    name: string,
    agent_status?: string,
    fields: Record<string, unknown> = {},
    daemon: Record<string, unknown> = {},
    heartbeat = beat,
  ) => {
    const _id = `conversations_${name}`;
    conversations.push({
      _id,
      user_id: viewer,
      session_id: name,
      title: name,
      project_path: "/src/watch",
      agent_type: "claude_code",
      is_private: true,
      status: "active",
      started_at: now - 60 * minute,
      updated_at: now - 3 * minute,
      message_count: 1,
      last_message_role: "assistant",
      ...fields,
    });
    if (agent_status === undefined) return _id;
    const managed = `managed_sessions_${name}`;
    managed_sessions.push({
      _id: managed,
      user_id: viewer,
      conversation_id: _id,
      session_id: name,
      agent_status,
      agent_status_updated_at: old,
      last_heartbeat: source === "lease" ? old : heartbeat,
      ...(source === "lease" && heartbeat > old
        ? { liveness_lease: { end: heartbeat + 2 * minute, expired: false } }
        : {}),
      ...daemon,
    });
    if (source !== "legacy")
      session_heartbeats.push({
        _id: `session_heartbeats_${name}`,
        managed_session_id: managed,
        user_id: viewer,
        heartbeat_at: source === "rollback" ? old : heartbeat,
      });
    return _id;
  };
  session("statusless", undefined, {
    has_pending_messages: true,
    last_message_role: "user",
  });
  session("working", "working", { inbox_pinned_at: now - 5 * minute });
  const parent = session("parent", "idle");
  session("child", "working", {
    is_subagent: true,
    parent_conversation_id: parent,
    updated_at: now - 7 * minute,
  });
  session("permission", "permission_blocked", {
    spawned_by_conversation_id: parent,
  });
  session(
    "hosted",
    "working",
    { agent_type: "codecast" },
    { hosted: true },
    now - 100,
  );
  session("hibernated", "hibernated", {}, { hibernated_at: old });
  session("stopped", "stopped");
  session("dead under one hour", "working", { updated_at: old }, {}, old);
  session("parked", "done", { inbox_stashed_at: now - 10 * minute });
  return {
    conversations,
    managed_sessions,
    session_heartbeats,
    users: [{ _id: viewer }],
    inbox_buckets: [
      { _id: "inbox_buckets_review", user_id: viewer, name: "Review" },
    ],
    bucket_assignments: [
      {
        _id: "bucket_assignments_working",
        user_id: viewer,
        bucket_id: "inbox_buckets_review",
        conversation_id: "conversations_working",
      },
    ],
  };
}

async function run(
  tables: ReturnType<typeof account>,
  queryFunction: unknown = inboxForCLI,
  at = now,
) {
  _resetChildAuqProbeCacheForTests();
  const db = makeFakeDb(tables, { indexes: schemaIndexes(schema) });
  let heartbeatReads = 0;
  const clock = spyOn(Date, "now").mockReturnValue(at);
  try {
    const result = await (queryFunction as any)._handler(
      {
        auth: { getUserIdentity: async () => ({ subject: `${viewer}|test` }) },
        db: {
          ...db,
          query: (table: string) => {
            const query = db.query(table);
            if (table !== "session_heartbeats") return query;
            return {
              ...query,
              withIndex(name: string, range: (q: any) => unknown) {
                const indexed = query.withIndex(name, range);
                return {
                  ...indexed,
                  async collect() {
                    const rows = await indexed.collect();
                    heartbeatReads += rows.length;
                    return rows;
                  },
                };
              },
            };
          },
        },
      },
      { api_token: "unused", show_all: true, limit: 200 },
    );
    return { result, heartbeatReads };
  } finally {
    clock.mockRestore();
  }
}

test.each([2 * minute, 5 * minute, 6 * minute])(
  "full CLI response handles the %i ms threshold with zero session_heartbeats reads",
  async (threshold) => {
    for (const offset of [-1, 0, 1]) {
      const tables = account(threshold + offset, "legacy");
      const { result, heartbeatReads } = await run(tables);
      expect(heartbeatReads).toBe(0);
      const rows = new Map(result.sessions.map((row: any) => [row.id, row]));
      expect(rows.get("conversations_statusless")).toMatchObject({
        is_live: threshold + offset <= 5 * minute,
      });
      expect(rows.get("conversations_working")).toMatchObject({
        agent_status: threshold + offset < 2 * minute ? "working" : "stopped",
        label: "Review",
        is_pinned: true,
      });
      expect(rows.get("conversations_hosted")).toMatchObject({ is_live: true });
      expect(rows.get("conversations_hibernated")).toMatchObject({
        is_live: false,
        agent_status: "hibernated",
      });
      expect(rows.get("conversations_stopped")).toMatchObject({
        is_live: false,
      });
      expect(rows.get("conversations_parent")).toMatchObject({
        work_state: threshold + offset < 2 * minute ? "dormant" : "needs_input",
      });
      expect(rows.get("conversations_dead under one hour")).toMatchObject({
        agent_status: "stopped",
      });
    }
  },
);

test("active liveness_lease keeps CLI and overlay live with an old last_heartbeat and reads no session_heartbeats", async () => {
  const tables = account(minute, "lease");
  const cli = await run(tables, inboxForCLI);
  expect(cli.heartbeatReads).toBe(0);
  const cliRows = new Map(cli.result.sessions.map((row: any) => [row.id, row]));
  expect(cliRows.get("conversations_working")).toMatchObject({
    is_live: true,
    agent_status: "working",
  });
  expect(cliRows.get("conversations_parent")).toMatchObject({
    work_state: "dormant",
  });

  const overlay = await run(tables, sessionsLiveness);
  expect(overlay.heartbeatReads).toBe(0);
  expect(overlay.result.liveness["conversations_working"]).toMatchObject({
    agent_status: "working",
    is_connected: true,
  });
});

test.each(["legacy", "rollback"] as const)(
  "full CLI response preserves %s heartbeats",
  async (source) => {
    for (const age of [
      2 * minute - 1,
      2 * minute,
      2 * minute + 1,
      5 * minute,
      6 * minute - 1,
      6 * minute,
      6 * minute + 1,
    ]) {
      const tables = account(age, source);
      const bounded = await run(tables);
      expect(bounded.heartbeatReads).toBe(0);
      expect(bounded.result.sessions).toContainEqual(
        expect.objectContaining({
          id: "conversations_statusless",
          is_live: age <= 5 * minute,
        }),
      );
    }
  },
);

test("the liveness overlay retains exact old heartbeat stamps", async () => {
  const tables = account(6 * minute + 1, "legacy");
  const { result, heartbeatReads } = await run(tables, sessionsLiveness);
  expect(heartbeatReads).toBe(0);
  expect(result.liveness["conversations_working"].last_heartbeat).toBe(
    now - 6 * minute - 1,
  );
});

test("the web inbox retains exact old heartbeat stamps", async () => {
  const tables = account(6 * minute + 1, "legacy");
  const { result, heartbeatReads } = await run(tables, listInboxSessions);
  expect(heartbeatReads).toBe(0);
  expect(result.sessions).toContainEqual(
    expect.objectContaining({
      _id: "conversations_working",
      last_heartbeat: now - 6 * minute - 1,
    }),
  );
});

test("full CLI response reads no session_heartbeats inside a minute and for future heartbeats", async () => {
  for (const at of [now + 1, now + minute - 1])
    for (const age of [-5 * minute, 2 * minute, 5 * minute, 6 * minute]) {
      const tables = account(age, "legacy");
      const cli = await run(tables, inboxForCLI, at);
      expect(cli.heartbeatReads).toBe(0);
    }
});
