import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import {
  rowHeartbeatAliveAt,
  deriveLiveAt,
} from "@codecast/inbox/inboxProjection";
import {
  HEARTBEAT_ALIVE_MS,
  HEARTBEAT_FLUSH_INTERVAL_MS,
} from "@codecast/sessions/agentStatus";
import { api } from "./_generated/api";
import {
  asUser,
  scheduledJobs,
  serverTest,
} from "../test-helpers/database.testkit";
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

async function seed(heartbeatAge = 58_000, establishedLease = true) {
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
        ...(establishedLease && {
          liveness_lease: {
            end: now - heartbeatAge + HEARTBEAT_ALIVE_MS,
            expired: false,
          },
        }),
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

for (const { name, age } of [
  { name: "within the refresh window", age: 10_000 },
  { name: "when refreshing liveness", age: 58_000 },
]) {
  test(`a routine heartbeat ${name} leaves the inbox read sets untouched`, async () => {
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

    const cli = await recordDocuments(() =>
      viewer.query(api.conversations.inboxForCLI, { api_token: token }),
    );
    expect(beat.writes).toEqual(new Set([working.beat]));
    for (const query of [base, personal, scoped, legacy, cli]) {
      expect([...beat.writes].filter((id) => query.reads.has(id))).toEqual([]);
    }
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

test("a legacy row gains a lease, renews off the heartbeat path, and expires at the old timeout", async () => {
  const { viewer, t, working } = await seed(0, false);
  const latest = async () => {
    const result = await viewer.query(api.conversations.sessionsLiveness, {});
    if (!("liveness" in result)) throw new Error("Expected whole liveness");
    const row = result.liveness[working.conversation];
    if (!row) throw new Error("Missing inbox liveness row");
    return row;
  };
  const heartbeat = () =>
    viewer.mutation(api.managedSessions.heartbeatBatch, {
      sessions: [
        {
          session_id: "working-trace",
          agent_status: "working",
          client_ts: Date.now(),
        },
      ],
    });
  const advance = async (ms: number) => {
    jest.advanceTimersByTime(ms);
    await t.finishInProgressScheduledFunctions();
  };

  expect((await latest()).last_heartbeat).toBe(now);
  await heartbeat();
  const first = await latest();
  expect(first.liveness_lease_end).toBe(now + HEARTBEAT_ALIVE_MS);
  expect((await scheduledJobs(t)).map((job) => job.name)).toEqual([
    "managedSessions:checkInboxLivenessLease",
  ]);

  const refreshAt = now + 2 * HEARTBEAT_FLUSH_INTERVAL_MS;
  await advance(refreshAt - now);
  await heartbeat();
  expect(await latest()).toMatchObject({
    liveness_lease_end: first.liveness_lease_end,
    last_heartbeat: first.last_heartbeat,
  });

  const checkAt = now + HEARTBEAT_ALIVE_MS - HEARTBEAT_FLUSH_INTERVAL_MS;
  await advance(checkAt - refreshAt);
  const refreshed = await latest();
  const deadline = refreshAt + HEARTBEAT_ALIVE_MS;
  expect(refreshed.liveness_lease_end).toBe(deadline);
  expect(refreshed.last_heartbeat).toBe(refreshAt);

  const legacyClient = { ...refreshed, liveness_lease_end: undefined };
  expect(
    rowHeartbeatAliveAt({ ...refreshed, last_heartbeat: now }, deadline - 1),
  ).toBe(true);
  expect(
    rowHeartbeatAliveAt({ ...legacyClient, last_heartbeat: now }, deadline - 1),
  ).toBe(false);
  for (const row of [refreshed, legacyClient]) {
    expect(rowHeartbeatAliveAt(row, deadline - 1)).toBe(true);
    expect(rowHeartbeatAliveAt(row, deadline)).toBe(false);
    expect(deriveLiveAt(row, deadline - 1).daemon_alive).toBe(true);
    expect(deriveLiveAt(row, deadline).daemon_alive).toBe(false);
  }
  await advance(deadline - checkAt);
  expect(
    (await t.run(({ db }) => db.get(working.managed)))?.liveness_lease,
  ).toEqual({
    end: deadline,
    expired: true,
  });
  await heartbeat();
  expect((await latest()).liveness_lease_end).toBe(
    deadline + HEARTBEAT_ALIVE_MS,
  );
});
