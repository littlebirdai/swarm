import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { api } from "./_generated/api";
import { asUser, serverTest } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";

const now = 1_750_000_020_000;
const token = "b".repeat(64);

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(now);
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

type AsyncSyscall = (op: string, args: string) => Promise<string>;

async function recordDocuments<T>(run: () => Promise<T>) {
  const runtime = (globalThis as unknown as { Convex: object }).Convex;
  const original = Object.getOwnPropertyDescriptor(runtime, "asyncSyscall")!;
  const reads = new Set<string>();
  const writes = new Set<string>();
  Object.defineProperty(runtime, "asyncSyscall", {
    ...original,
    get() {
      const call: AsyncSyscall = original.get!.call(runtime);
      return async (op: string, args: string) => {
        const result = await call(op, args);
        switch (op) {
          case "1.0/get":
            reads.add(JSON.parse(args).id);
            break;
          case "1.0/queryStreamNext": {
            const { value } = JSON.parse(result);
            if (value?._id) reads.add(value._id);
            break;
          }
          case "1.0/queryPage":
            for (const row of JSON.parse(result).page) reads.add(row._id);
            break;
          case "1.0/insert":
            writes.add(JSON.parse(result)._id);
            break;
          case "1.0/shallowMerge":
          case "1.0/replace":
          case "1.0/remove":
            writes.add(JSON.parse(args).id);
            break;
        }
        return result;
      };
    },
  });
  try {
    return { result: await run(), reads, writes };
  } finally {
    Object.defineProperty(runtime, "asyncSyscall", original);
  }
}

async function seed(heartbeatAge = 58_000) {
  const t = serverTest(true);
  const fixture = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "inbox heartbeat read set");
    const team = await rows.team();
    const user = await rows.user({ active_team_id: team });
    await rows.token(user, token);
    await rows.membership(user, team);

    async function session(
      key: string,
      status: "working" | "idle",
      updatedAt: number,
    ) {
      const conversation = await rows.conversation(user, {
        session_id: key,
        team_id: team,
        started_at: now - 120_000,
        updated_at: updatedAt,
        message_count: 1,
        last_message_role: "assistant",
      });
      const managed = await db.insert("managed_sessions", {
        session_id: key,
        conversation_id: conversation,
        user_id: user,
        pid: 1,
        started_at: now - 120_000,
        last_heartbeat: now - heartbeatAge,
        agent_status: status,
        agent_status_updated_at: updatedAt,
      });
      const beat = await db.insert("session_heartbeats", {
        managed_session_id: managed,
        user_id: user,
        heartbeat_at: now - heartbeatAge,
      });
      return { conversation, managed, beat };
    }

    const working = await session("working-trace", "working", now - 2000);
    const idle = await session("idle-trace", "idle", now - 1000);
    return { team, user, working, idle };
  });
  return { ...fixture, viewer: asUser(t, fixture.user), t };
}

for (const { name, age, refreshes } of [
  { name: "within the refresh window", age: 10_000, refreshes: false },
  { name: "when refreshing liveness", age: 58_000, refreshes: true },
]) {
  test(`a routine heartbeat ${name} invalidates the inbox liveness queries`, async () => {
    const { viewer, team, working } = await seed(age);
    const base = await recordDocuments(() =>
      viewer.query(api.conversations.listInboxSessions, {
        include_liveness: false,
        fast_fields_in_overlay: true,
        split: true,
      }),
    );
    const personal = await recordDocuments(() =>
      viewer.query(api.conversations.sessionsLiveness, {}),
    );
    const scoped = await recordDocuments(() =>
      viewer.query(api.conversations.teamSessionsLiveness, {
        activeTeamId: team,
      }),
    );
    const legacy = await recordDocuments(() =>
      viewer.query(api.conversations.listInboxSessions, {}),
    );
    const beat = await recordDocuments(() =>
      viewer.mutation(api.managedSessions.heartbeatBatch, {
        sessions: [
          {
            session_id: "working-trace",
            agent_status: "working",
            client_ts: now,
          },
        ],
      }),
    );

    const expected = refreshes
      ? [working.beat, working.managed]
      : [working.managed];
    expect(beat.writes).toEqual(new Set(expected));
    for (const query of [personal, scoped, legacy]) {
      expect([...beat.writes].filter((id) => query.reads.has(id))).toEqual(
        expected,
      );
    }
    expect([...beat.writes].filter((id) => base.reads.has(id))).toEqual([]);
  });
}

test("an inbox status transition changes the actionable row order", async () => {
  const { viewer, working, idle } = await seed();
  const order = async () => {
    const result = await viewer.query(api.conversations.inboxForCLI, {
      api_token: token,
      show_all: true,
    });
    if (!("sessions" in result) || !result.sessions)
      throw new Error("Inbox query did not return sessions");
    return result.sessions.map(({ id, work_state }) => [id, work_state]);
  };
  expect(await order()).toEqual([
    [idle.conversation, "working"],
    [working.conversation, "working"],
  ]);
  await viewer.mutation(api.managedSessions.heartbeatBatch, {
    sessions: [
      {
        session_id: "working-trace",
        agent_status: "permission_blocked",
        client_ts: now,
      },
    ],
  });
  expect(await order()).toEqual([
    [working.conversation, "needs_input"],
    [idle.conversation, "working"],
  ]);
});

test("an active heartbeat keeps an older park from changing inbox status", async () => {
  const { viewer, t, working } = await seed(10_000);
  await viewer.mutation(api.managedSessions.heartbeatBatch, {
    sessions: [
      { session_id: "working-trace", agent_status: "working", client_ts: now },
    ],
  });
  const park = (clientTs: number) =>
    viewer.mutation(api.managedSessions.updateAgentStatus, {
      conversation_id: working.conversation,
      agent_status: "hibernated",
      hibernated_at: now,
      client_ts: clientTs,
    });
  expect(await park(now - 1000)).toEqual({
    applied: false,
    reason: "stale_status",
  });
  const unchanged = await t.run(({ db }) => db.get(working.managed));
  expect(unchanged).toMatchObject({
    agent_status: "working",
    agent_status_updated_at: now - 2000,
  });
  expect(await park(now + 1)).toMatchObject({ applied: true });
  const parked = await t.run(({ db }) => db.get(working.managed));
  expect(parked).toMatchObject({
    agent_status: "hibernated",
    agent_status_updated_at: now + 1,
    hibernated_at: now,
  });
});
