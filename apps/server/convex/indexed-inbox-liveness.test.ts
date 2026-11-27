import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { LIVE_INBOX_LEASE_END } from "@codecast/inbox/inboxProjection";
import { HEARTBEAT_ALIVE_MS } from "@codecast/sessions/agentStatus";
import { api } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { asUser, serverTest } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";

const now = 1_750_000_020_000;
const hour = 60 * 60 * 1000;
let previousFlags: [string | undefined, string | undefined];

beforeEach(() => {
  previousFlags = [
    process.env.INBOX_INDEXED_LIVENESS,
    process.env.INBOX_LIVENESS_LEASES,
  ];
  delete process.env.INBOX_INDEXED_LIVENESS;
  process.env.INBOX_LIVENESS_LEASES = "1";
  jest.useFakeTimers();
  jest.setSystemTime(now);
});

afterEach(() => {
  for (const [index, name] of [
    "INBOX_INDEXED_LIVENESS",
    "INBOX_LIVENESS_LEASES",
  ].entries()) {
    const value = previousFlags[index];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  jest.useRealTimers();
});

type AsyncSyscall = (op: string, args: string) => Promise<string>;

async function measureReads<T>(run: () => Promise<T>) {
  const runtime = (globalThis as unknown as { Convex: object }).Convex;
  const original = Object.getOwnPropertyDescriptor(runtime, "asyncSyscall")!;
  let bytes = 0;
  let managed = 0;
  let heartbeats = 0;
  let documents = 0;
  let dbCalls = 0;

  function count(row: { _id?: string } | null) {
    if (!row?._id) return;
    documents++;
    bytes += Buffer.byteLength(JSON.stringify(row));
    if (row._id.endsWith("managed_sessions")) managed++;
    if (row._id.endsWith("session_heartbeats")) heartbeats++;
  }

  Object.defineProperty(runtime, "asyncSyscall", {
    ...original,
    get() {
      const call: AsyncSyscall = original.get!.call(runtime);
      return async (op: string, args: string) => {
        const result = await call(op, args);
        if (op === "1.0/get") {
          dbCalls++;
          count(JSON.parse(result));
        }
        if (op === "1.0/queryStreamNext") {
          dbCalls++;
          count(JSON.parse(result).value);
        }
        if (op === "1.0/queryPage") {
          dbCalls++;
          for (const row of JSON.parse(result).page) count(row);
        }
        return result;
      };
    },
  });
  try {
    return {
      result: await run(),
      documents,
      managed,
      heartbeats,
      bytes,
      dbCalls,
    };
  } finally {
    Object.defineProperty(runtime, "asyncSyscall", original);
  }
}

async function fixture() {
  const t = serverTest(true);
  const ids = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "indexed inbox liveness");
    const user = await rows.user();
    const stranger = await rows.user();
    const pin = await rows.conversation(user, {
      inbox_pinned_at: now - 4 * hour,
      updated_at: now - 4 * hour,
      last_message_role: "assistant",
      message_count: 1,
    });
    const liveIds = [];
    for (let i = 0; i < 20; i++) {
      const conversation = await rows.conversation(user, {
        updated_at: now - 30_000,
        last_message_role: "assistant",
        message_count: 1,
      });
      const last = i < 2 ? now - 30_000 : now - 2 * hour;
      liveIds.push(conversation);
      await db.insert("managed_sessions", {
        session_id: `live-${i}`,
        conversation_id: conversation,
        user_id: user,
        pid: i,
        started_at: now - 2 * hour,
        last_heartbeat: last,
        agent_status: "working",
        ...(i !== 0 && {
          liveness_lease: { end: last + HEARTBEAT_ALIVE_MS, expired: false },
        }),
      });
    }
    const old = {
      user_id: user,
      pid: 21,
      started_at: now - 8 * hour,
      last_heartbeat: now - 4 * hour,
      agent_status: "done",
    } satisfies Partial<Doc<"managed_sessions">>;
    await db.insert("managed_sessions", {
      ...old,
      session_id: "pinned",
      conversation_id: pin,
    });
    await db.insert("managed_sessions", {
      ...old,
      session_id: "unrelated-user",
      user_id: stranger,
      last_heartbeat: now,
      conversation_id: pin,
    });
    return { user, pin, liveIds, old };
  });
  return { ...ids, t, viewer: asUser(t, ids.user) };
}

test("indexed personal liveness reads the same documents as unrelated history grows", async () => {
  const { t, viewer, pin, liveIds, old } = await fixture();
  const read = () =>
    measureReads(() => viewer.query(api.conversations.sessionsLiveness, {}));
  process.env.INBOX_INDEXED_LIVENESS = "1";
  const small = await read();

  await t.run(async ({ db }) => {
    for (let i = 0; i < 1979; i++) {
      await db.insert("managed_sessions", {
        ...old,
        session_id: `expired-${i}`,
      });
    }
  });

  delete process.env.INBOX_INDEXED_LIVENESS;
  const legacy = await read();
  process.env.INBOX_INDEXED_LIVENESS = "1";
  const bounded = await read();

  expect(legacy.managed).toBe(2000);
  expect(bounded.managed).toBe(21);
  expect(bounded.heartbeats).toBe(0);
  expect(bounded.documents).toBe(42);
  expect(bounded.documents).toBe(small.documents);
  expect(bounded.dbCalls).toBe(small.dbCalls);
  expect(bounded.dbCalls).toBeLessThanOrEqual(80);
  expect(bounded.bytes).toBe(small.bytes);
  expect(bounded.documents).toBeLessThan(legacy.documents / 30);
  expect(bounded.bytes).toBeLessThan(legacy.bytes / 30);
  expect(bounded.result).toEqual(legacy.result);
  expect(bounded.result.liveness[pin]?.agent_status).toBe("done");
  expect(bounded.result.liveness[liveIds[0]]?.is_connected).toBe(true);
  expect(bounded.result.liveness[liveIds[1]]?.liveness_lease_end).toBe(
    LIVE_INBOX_LEASE_END,
  );
});

test("the indexed read requires inbox lease writes", async () => {
  const { viewer } = await fixture();
  const read = () =>
    measureReads(() => viewer.query(api.conversations.sessionsLiveness, {}));
  delete process.env.INBOX_LIVENESS_LEASES;
  const legacy = await read();
  process.env.INBOX_INDEXED_LIVENESS = "1";
  expect(await read()).toEqual(legacy);
});

test("indexed liveness keeps the latest daemon fallback separate from hosted turns", async () => {
  const t = serverTest(true);
  const { user, shell } = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "indexed daemon fallback");
    const user = await rows.user();
    const shell = await rows.conversation(user, {
      updated_at: now - 120_000,
      last_message_role: "assistant",
      message_count: 1,
    });
    const hosted = await rows.conversation(user, {
      agent_type: "codecast",
      updated_at: now - 1000,
    });
    const anchor = now - 3 * 60_000;
    await db.insert("managed_sessions", {
      session_id: "last-daemon",
      user_id: user,
      pid: 1,
      started_at: now - hour,
      last_heartbeat: anchor,
      liveness_lease: { end: anchor + HEARTBEAT_ALIVE_MS, expired: true },
    });
    await db.insert("managed_sessions", {
      session_id: "active-hosted",
      conversation_id: hosted,
      user_id: user,
      hosted: true,
      pid: 0,
      started_at: now - hour,
      last_heartbeat: now,
      liveness_lease: { end: now + HEARTBEAT_ALIVE_MS, expired: false },
    });
    return { user, shell };
  });
  const viewer = asUser(t, user);
  const legacy = await viewer.query(api.conversations.sessionsLiveness, {});
  process.env.INBOX_INDEXED_LIVENESS = "1";
  const indexed = await viewer.query(api.conversations.sessionsLiveness, {});
  expect(indexed).toEqual(legacy);
  expect(indexed.liveness[shell]?.daemon_alive_until).toBe(now + 3 * 60_000);
});

test("indexed liveness retains live children beyond the inbox child window", async () => {
  const t = serverTest(true);
  const { user, childIds } = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "indexed child overflow");
    const user = await rows.user();
    const parent = await rows.conversation(user, { updated_at: now });
    const childIds = [];
    for (let i = 0; i < 513; i++) {
      const child = await rows.conversation(user, {
        is_subagent: true,
        parent_conversation_id: parent,
        updated_at: now - 10_000,
        message_count: 1,
        last_message_role: "assistant",
      });
      childIds.push(child);
      await db.insert("managed_sessions", {
        session_id: `child-${i}`,
        conversation_id: child,
        user_id: user,
        pid: i,
        started_at: now - 2 * hour,
        last_heartbeat: now - 2 * hour,
        agent_status: "working",
        liveness_lease: {
          end: now - 2 * hour + HEARTBEAT_ALIVE_MS,
          expired: false,
        },
      });
    }
    return { user, childIds };
  });
  process.env.INBOX_INDEXED_LIVENESS = "1";
  const { liveness } = await asUser(t, user).query(
    api.conversations.sessionsLiveness,
    {},
  );
  expect(
    childIds.filter((id) => liveness[id]?.agent_status === "working"),
  ).toHaveLength(513);
});
