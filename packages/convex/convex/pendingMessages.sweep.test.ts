import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  STUCK_MESSAGES_PER_PASS,
  STUCK_SESSIONS_PER_CONVERSATION,
} from "./pendingMessages";
import schema from "./schema";
import { allModules } from "./testModules.testkit";

const STATUSES = ["pending", "injected", "failed", "undeliverable"] as const;

function fixture() {
  const t = convexTest({
    schema,
    modules: allModules,
    transactionLimits: {
      // One cursor, one page per status, and one conversation plus its
      // session sample per candidate. The real planner must fit this budget.
      documentsRead: 1 + STUCK_MESSAGES_PER_PASS * (STATUSES.length + 1 + STUCK_SESSIONS_PER_CONVERSATION),
    },
  });
  const now = Date.now();
  return { t, now };
}

test("sweeps oldest first across statuses and revisits rows skipped in an earlier pass", async () => {
  const { t, now } = fixture();
  const createdAt = now - 10 * 60_000;
  const { blocked, eligible, busySession } = await t.run(async ({ db }) => {
    const owner = await db.insert("users", { name: "Owner" });
    const blockedConversation = await db.insert("conversations", {
      user_id: owner, session_id: "busy", agent_type: "claude_code", status: "active",
    });
    const idleConversation = await db.insert("conversations", {
      user_id: owner, session_id: "idle", agent_type: "claude_code", status: "active",
    });
    const busySession = await db.insert("managed_sessions", {
      user_id: owner, conversation_id: blockedConversation, session_id: "busy",
      pid: 1, started_at: createdAt, last_heartbeat: now, agent_status: "working",
    });
    await db.insert("managed_sessions", {
      user_id: owner, conversation_id: idleConversation, session_id: "idle",
      pid: 2, started_at: createdAt, last_heartbeat: now, agent_status: "idle",
    });
    const message = (conversation_id: Id<"conversations">, status: Doc<"pending_messages">["status"], created_at: number) =>
      db.insert("pending_messages", {
        conversation_id, from_user_id: owner, status, created_at, content: "Queued text", retry_count: 6,
      });
    const blocked = [];
    for (let i = 0; i < STUCK_MESSAGES_PER_PASS; i++) {
      blocked.push(await message(blockedConversation, "pending", createdAt - 1));
    }
    // Seed a younger row before the rest to distinguish message age from
    // insertion order. The remaining rows tie on age across the page cut.
    const youngest = await message(idleConversation, "failed", createdAt + 1);
    const eligible = [];
    for (let i = 0; i < STUCK_MESSAGES_PER_PASS + 1; i++) {
      eligible.push(await message(idleConversation, STATUSES[i % STATUSES.length], createdAt));
    }
    return { blocked, eligible: [...eligible, youngest], busySession };
  });

  const plan = () => t.query(internal.pendingMessages.planStuckMessages, { now });
  const sweep = () => t.action(internal.pendingMessages.retryStuckMessages, {});
  expect((await plan()).groups).toEqual([]);
  await sweep();

  expect((await plan()).groups).toEqual([eligible.slice(0, STUCK_MESSAGES_PER_PASS)]);
  await sweep();
  expect((await plan()).groups).toEqual([eligible.slice(STUCK_MESSAGES_PER_PASS)]);
  await sweep();
  await t.run(async ({ db }) => {
    for (const id of eligible) expect(await db.get(id)).toMatchObject({ status: "pending", retry_count: 0 });
    for (const id of blocked) expect(await db.get(id)).toMatchObject({ status: "pending", retry_count: 6 });
    await db.patch(busySession, { agent_status: "idle" });
  });
  expect((await plan()).groups).toEqual([blocked]);
  await sweep();
  await t.run(async ({ db }) => {
    for (const id of blocked) expect(await db.get(id)).toMatchObject({ status: "pending", retry_count: 0 });
  });
});

test("bounds planner reads with full status pages and many live sessions", async () => {
  const { t, now } = fixture();
  const createdAt = now - 10 * 60_000;
  const owner = await t.run(({ db }) => db.insert("users", { name: "Owner" }));
  const oldest = await t.run(async ({ db }) => {
    const ids: Id<"pending_messages">[] = [];
    for (let i = 0; i < STUCK_MESSAGES_PER_PASS; i++) {
      const conversation = await db.insert("conversations", {
        session_id: `candidate-${i}`, user_id: owner, agent_type: "claude_code", status: "active",
      });
      // The oldest heartbeats fill the planner sample. The ready session
      // outside it must still allow this conversation to retry.
      for (let j = 0; j <= STUCK_SESSIONS_PER_CONVERSATION; j++) {
        await db.insert("managed_sessions", {
          user_id: owner, conversation_id: conversation, session_id: `candidate-${i}-${j}`,
          pid: j, started_at: createdAt, last_heartbeat: now - 1_000 + j,
          agent_status: j === STUCK_SESSIONS_PER_CONVERSATION ? "idle" : "working",
        });
      }
      for (const status of STATUSES) {
        const id = await db.insert("pending_messages", {
          conversation_id: conversation, from_user_id: owner, status,
          created_at: createdAt + i + (status === "pending" ? 0 : 1_000), content: "Queued text", retry_count: 6,
        });
        if (status === "pending") ids.push(id);
        await db.insert("pending_messages", {
          conversation_id: conversation, from_user_id: owner, status,
          created_at: createdAt + 2_000, content: "Newer text", retry_count: 6,
        });
      }
      await db.insert("managed_sessions", {
        user_id: owner, session_id: `unrelated-${i}`, pid: i, started_at: createdAt,
        last_heartbeat: now, agent_status: "idle",
      });
    }
    return ids;
  });
  const plan = await t.query(internal.pendingMessages.planStuckMessages, { now });
  expect(plan.groups).toEqual(oldest.map((id) => [id]));
  await t.action(internal.pendingMessages.retryStuckMessages, {});
  await t.run(async ({ db }) => {
    for (const id of oldest) expect(await db.get(id)).toMatchObject({ status: "pending", retry_count: 0 });
  });
});
