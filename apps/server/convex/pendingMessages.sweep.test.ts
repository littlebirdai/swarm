import { expect, setSystemTime, test } from "bun:test";
import { convexTest } from "convex-test";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  applyStuckMessages,
  planStuckMessages,
  DEAD_SESSION_REVIVES_PER_PASS,
  STUCK_MESSAGE_PAGES_PER_RUN,
  STUCK_MESSAGE_RUN_BUDGET_MS,
  STUCK_MESSAGES_PER_PAGE,
  STUCK_SESSIONS_PER_CONVERSATION,
} from "./pendingMessages";
import schema from "./schema";
import { allModules } from "./testModules.testkit";

const STATUSES = ["pending", "injected", "failed", "undeliverable"] as const;

function fixture(modules = allModules) {
  const t = convexTest({
    schema,
    modules,
    transactionLimits: {
      // One cursor, one page per status, and one conversation plus its
      // session sample per candidate. The real planner must fit this budget.
      documentsRead:
        1 +
        STUCK_MESSAGES_PER_PAGE *
          (STATUSES.length + 1 + STUCK_SESSIONS_PER_CONVERSATION),
    },
  });
  const now = Date.now();
  return { t, now };
}

test("sweeps oldest first across statuses and revisits rows skipped in an earlier pass", async () => {
  const { t, now } = fixture();
  const createdAt = now - 10 * 60_000;
  const {
    blocked,
    eligible,
    busySession,
    blockedConversation,
    idleConversation,
  } = await t.run(async ({ db }) => {
    const owner = await db.insert("users", { name: "Owner" });
    const blockedConversation = await db.insert("conversations", {
      user_id: owner,
      session_id: "busy",
      agent_type: "claude_code",
      status: "active",
    });
    const idleConversation = await db.insert("conversations", {
      user_id: owner,
      session_id: "idle",
      agent_type: "claude_code",
      status: "active",
    });
    const busySession = await db.insert("managed_sessions", {
      user_id: owner,
      conversation_id: blockedConversation,
      session_id: "busy",
      pid: 1,
      started_at: createdAt,
      last_heartbeat: now,
      agent_status: "working",
    });
    await db.insert("managed_sessions", {
      user_id: owner,
      conversation_id: idleConversation,
      session_id: "idle",
      pid: 2,
      started_at: createdAt,
      last_heartbeat: now,
      agent_status: "idle",
    });
    const message = (
      conversation_id: Id<"conversations">,
      status: Doc<"pending_messages">["status"],
      created_at: number,
    ) =>
      db.insert("pending_messages", {
        conversation_id,
        from_user_id: owner,
        status,
        created_at,
        content: "Queued text",
        retry_count: 6,
      });
    const blocked = [];
    for (let i = 0; i < STUCK_MESSAGES_PER_PAGE; i++) {
      blocked.push(
        await message(blockedConversation, "pending", createdAt - 1),
      );
    }
    // Seed a younger row before the rest to distinguish message age from
    // insertion order. The remaining rows tie on age across the page cut.
    const youngest = await message(idleConversation, "failed", createdAt + 1);
    const eligible = [];
    for (let i = 0; i < STUCK_MESSAGES_PER_PAGE + 1; i++) {
      eligible.push(
        await message(
          idleConversation,
          i === STUCK_MESSAGES_PER_PAGE - 1
            ? "injected"
            : STATUSES[i % STATUSES.length],
          createdAt,
        ),
      );
    }
    return {
      blocked,
      eligible: [...eligible, youngest],
      busySession,
      blockedConversation,
      idleConversation,
    };
  });

  const plan = () =>
    t.query(internal.pendingMessages.planStuckMessages, { now });
  const sweep = () => t.action(internal.pendingMessages.retryStuckMessages, {});
  const blockedPage = await plan();
  expect(blockedPage.groups).toEqual([]);
  await t.mutation(internal.pendingMessages.checkpointStuckMessagePage, {
    now,
    next: blockedPage.next,
    updates: [],
  });

  const first = await plan();
  expect(first.groups).toEqual([
    {
      conversationId: idleConversation,
      ids: eligible.slice(0, STUCK_MESSAGES_PER_PAGE),
    },
  ]);
  await t.mutation(internal.pendingMessages.applyStuckMessages, {
    ids: first.groups[0].ids,
    now,
    deadRevivesRemaining: DEAD_SESSION_REVIVES_PER_PASS,
    allowHostedWake: true,
  });
  await t.mutation(internal.pendingMessages.checkpointStuckMessagePage, {
    now,
    next: first.next,
    updates: [],
  });
  expect((await plan()).groups).toEqual([
    {
      conversationId: idleConversation,
      ids: eligible.slice(STUCK_MESSAGES_PER_PAGE),
    },
  ]);
  await sweep();
  await t.run(async ({ db }) => {
    for (const id of eligible)
      expect(await db.get(id)).toMatchObject({
        status: "pending",
        retry_count: 0,
      });
    for (const id of blocked)
      expect(await db.get(id)).toMatchObject({
        status: "pending",
        retry_count: 6,
      });
    await db.patch(busySession, { agent_status: "idle" });
  });
  expect((await plan()).groups).toEqual([
    { conversationId: blockedConversation, ids: blocked },
  ]);
  await sweep();
  await t.run(async ({ db }) => {
    for (const id of blocked)
      expect(await db.get(id)).toMatchObject({
        status: "pending",
        retry_count: 0,
      });
  });
});

test("bounds planner reads with full status pages and many live sessions", async () => {
  const { t, now } = fixture();
  const createdAt = now - 10 * 60_000;
  const owner = await t.run(({ db }) => db.insert("users", { name: "Owner" }));
  const oldest = await t.run(async ({ db }) => {
    const ids: Id<"pending_messages">[] = [];
    for (let i = 0; i < STUCK_MESSAGES_PER_PAGE; i++) {
      const conversation = await db.insert("conversations", {
        session_id: `candidate-${i}`,
        user_id: owner,
        agent_type: "claude_code",
        status: "active",
      });
      // The oldest heartbeats fill the planner sample. The ready session
      // outside it must still allow this conversation to retry.
      for (let j = 0; j <= STUCK_SESSIONS_PER_CONVERSATION; j++) {
        await db.insert("managed_sessions", {
          user_id: owner,
          conversation_id: conversation,
          session_id: `candidate-${i}-${j}`,
          pid: j,
          started_at: createdAt,
          last_heartbeat: now - 1_000 + j,
          agent_status:
            j === STUCK_SESSIONS_PER_CONVERSATION ? "idle" : "working",
        });
      }
      for (const status of STATUSES) {
        const id = await db.insert("pending_messages", {
          conversation_id: conversation,
          from_user_id: owner,
          status,
          created_at: createdAt + i + (status === "pending" ? 0 : 1_000),
          content: "Queued text",
          retry_count: 6,
        });
        if (status === "pending") ids.push(id);
        await db.insert("pending_messages", {
          conversation_id: conversation,
          from_user_id: owner,
          status,
          created_at: createdAt + 2_000,
          content: "Newer text",
          retry_count: 6,
        });
      }
      await db.insert("managed_sessions", {
        user_id: owner,
        session_id: `unrelated-${i}`,
        pid: i,
        started_at: createdAt,
        last_heartbeat: now,
        agent_status: "idle",
      });
    }
    return ids;
  });
  const plan = await t.query(internal.pendingMessages.planStuckMessages, {
    now,
  });
  expect(plan.groups.map((group) => group.ids)).toEqual(
    oldest.map((id) => [id]),
  );
  await t.action(internal.pendingMessages.retryStuckMessages, {});
  await t.run(async ({ db }) => {
    for (const id of oldest)
      expect(await db.get(id)).toMatchObject({
        status: "pending",
        retry_count: 0,
      });
  });
});

test("recovers a new stuck message within three ticks even when an older sweep is in progress", async () => {
  const { t, now } = fixture();
  try {
    setSystemTime(now);
    const backlog = 513;
    const owner = await t.run(({ db }) =>
      db.insert("users", { name: "Owner" }),
    );
    await t.run(async ({ db }) => {
      const offline = await db.insert("conversations", {
        user_id: owner,
        session_id: "offline",
        agent_type: "claude_code",
        status: "active",
      });
      for (let i = 0; i < backlog; i++) {
        await db.insert("pending_messages", {
          conversation_id: offline,
          from_user_id: owner,
          status: "pending",
          created_at: now - 7 * 24 * 60 * 60_000,
          content: "Waiting for an offline daemon",
          retry_count: 6,
        });
      }
    });

    const sweep = () =>
      t.action(internal.pendingMessages.retryStuckMessages, {});
    await sweep();
    expect(
      await t.run(({ db }) => db.query("pending_message_sweep_state").first()),
    ).toMatchObject({
      cursor: { through: now },
    });

    setSystemTime(now + 1);
    const { id, session } = await t.run(async ({ db }) => {
      const idle = await db.insert("conversations", {
        user_id: owner,
        session_id: "idle",
        agent_type: "claude_code",
        status: "active",
      });
      const session = await db.insert("managed_sessions", {
        conversation_id: idle,
        user_id: owner,
        session_id: "idle",
        pid: 1,
        started_at: now,
        last_heartbeat: now,
        agent_status: "idle",
      });
      const id = await db.insert("pending_messages", {
        conversation_id: idle,
        from_user_id: owner,
        status: "failed",
        created_at: Date.now(),
        content: "Retry this promptly",
        retry_count: 6,
      });
      return { id, session };
    });
    for (let tick = 1; tick <= 3; tick++) {
      setSystemTime(now + tick * 60_000);
      await t.run(({ db }) =>
        db.patch(session, { last_heartbeat: Date.now() }),
      );
      await sweep();
    }
    expect(await t.run(({ db }) => db.get(id))).toMatchObject({
      status: "pending",
      retry_count: 0,
    });
  } finally {
    setSystemTime();
  }
});

test("retries a failed apply on the next tick and uses the dead-session budget across pages", async () => {
  let failOnce = true;
  const { t, now } = fixture({
    ...allModules,
    "./pendingMessages.ts": async () => {
      const module = await import("./pendingMessages");
      return {
        ...module,
        applyStuckMessages: Object.assign(() => {}, applyStuckMessages, {
          _handler: (
            ...args: Parameters<(typeof applyStuckMessages)["_handler"]>
          ) => {
            if (failOnce) {
              failOnce = false;
              throw new Error("Test apply conflict");
            }
            return applyStuckMessages._handler(...args);
          },
        }),
      };
    },
  });
  try {
    setSystemTime(now);
    const old = now - 35 * 60_000;
    const ids = await t.run(async ({ db }) => {
      const owner = await db.insert("users", { name: "Owner" });
      const offline = await db.insert("conversations", {
        user_id: owner,
        session_id: "offline",
        agent_type: "claude_code",
        status: "active",
      });
      const ids: Id<"pending_messages">[] = [];
      for (let i = 0; i < DEAD_SESSION_REVIVES_PER_PASS + 2; i++) {
        const conversation = await db.insert("conversations", {
          user_id: owner,
          session_id: `dead-${i}`,
          agent_type: "claude_code",
          status: "active",
        });
        ids.push(
          await db.insert("pending_messages", {
            conversation_id: conversation,
            from_user_id: owner,
            status: "injected",
            created_at: old + i * STUCK_MESSAGES_PER_PAGE,
            content: "Recover me",
            retry_count: 6,
          }),
        );
        for (let j = 1; j < STUCK_MESSAGES_PER_PAGE; j++) {
          await db.insert("pending_messages", {
            conversation_id: offline,
            from_user_id: owner,
            status: "pending",
            created_at: old + i * STUCK_MESSAGES_PER_PAGE + j,
            content: "Waiting for a daemon",
            retry_count: 6,
          });
        }
      }
      const alreadyQueued = ids.length * STUCK_MESSAGES_PER_PAGE;
      for (
        let i = alreadyQueued;
        i <= STUCK_MESSAGES_PER_PAGE * STUCK_MESSAGE_PAGES_PER_RUN;
        i++
      ) {
        await db.insert("pending_messages", {
          conversation_id: offline,
          from_user_id: owner,
          status: "pending",
          created_at: old + i,
          content: "Waiting for a daemon",
          retry_count: 6,
        });
      }
      return ids;
    });

    const statuses = () =>
      t.run(
        async ({ db }) =>
          await Promise.all(ids.map(async (id) => (await db.get(id))?.status)),
      );
    const sweep = () =>
      t.action(internal.pendingMessages.retryStuckMessages, {});
    await sweep();
    expect(await statuses()).toEqual([
      "injected",
      ...Array(DEAD_SESSION_REVIVES_PER_PASS).fill("pending"),
      "injected",
    ]);
    const retries = () =>
      t.run(({ db }) => db.query("pending_message_sweep_retries").collect());
    expect(await retries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message_id: ids[0], reason: "apply_failed" }),
        expect.objectContaining({
          message_id: ids.at(-1),
          reason: "dead_revive_limit",
        }),
      ]),
    );

    setSystemTime(now + 60_000);
    // The cursor is already past both rows. Only the retry queue can reach
    // them during this tick.
    const finishPage = await t.query(
      internal.pendingMessages.planStuckMessages,
      { now },
    );
    expect(finishPage.groups).toEqual([]);
    await sweep();
    expect(await statuses()).toEqual(Array(ids.length).fill("pending"));
    expect(await retries()).toEqual([]);
  } finally {
    setSystemTime();
  }
});

test("notifies and repends on the first eligible tick behind 1,025 older waiting rows", async () => {
  const { t, now } = fixture();
  try {
    setSystemTime(now);
    const owner = await t.run(({ db }) =>
      db.insert("users", { name: "Recipient" }),
    );
    await t.run(async ({ db }) => {
      const offline = await db.insert("conversations", {
        user_id: owner,
        session_id: "offline",
        agent_type: "claude_code",
        status: "active",
      });
      for (let i = 0; i < 1_025; i++) {
        await db.insert("pending_messages", {
          conversation_id: offline,
          from_user_id: owner,
          status: "pending",
          created_at: now - 7 * 24 * 60 * 60_000,
          content: "Waiting for a daemon",
          retry_count: 6,
        });
      }
    });
    const sweep = () =>
      t.action(internal.pendingMessages.retryStuckMessages, {});
    await sweep();

    setSystemTime(now + 1);
    const { pending, injected, heartbeat } = await t.run(async ({ db }) => {
      const sender = await db.insert("users", { name: "Sender" });
      const from = await db.insert("conversations", {
        user_id: sender,
        session_id: "sender",
        agent_type: "claude_code",
        status: "active",
      });
      const terminal = await db.insert("conversations", {
        user_id: owner,
        session_id: "terminal",
        agent_type: "claude_code",
        status: "active",
      });
      const idle = await db.insert("conversations", {
        user_id: owner,
        session_id: "idle",
        agent_type: "claude_code",
        status: "active",
      });
      const heartbeat = await db.insert("managed_sessions", {
        conversation_id: idle,
        user_id: owner,
        session_id: "idle",
        pid: 1,
        started_at: now,
        last_heartbeat: now,
        agent_status: "idle",
      });
      const pending = await db.insert("pending_messages", {
        conversation_id: terminal,
        from_conversation_id: from,
        from_user_id: sender,
        owner_user_id: owner,
        status: "pending",
        created_at: Date.now(),
        content: "Please review this",
        retry_count: 0,
        delivery_disposition_reason:
          "runs in Ghostty, which Codecast can't type into",
      });
      const injected = await db.insert("pending_messages", {
        conversation_id: idle,
        from_user_id: owner,
        status: "injected",
        created_at: Date.now(),
        content: "Retry this promptly",
        retry_count: 6,
      });
      return { pending, injected, heartbeat };
    });
    for (let tick = 1; tick <= 4; tick++) {
      const tickTime = now + tick * 60_000;
      setSystemTime(tickTime);
      await t.run(({ db }) =>
        db.patch(heartbeat, { last_heartbeat: tickTime }),
      );
      await sweep();
      await t.run(async ({ db }) => {
        const send = await db.get(pending);
        expect(send?.sender_notified_at).toBe(
          tick === 4 ? tickTime : undefined,
        );
        expect(await db.get(injected)).toMatchObject({
          status: tick < 3 ? "injected" : "pending",
        });
        if (tick === 4) {
          expect(await db.get(send!.sender_notice_id!)).toMatchObject({
            content: expect.stringContaining(
              "Its machine is up and keeps the message queued",
            ),
          });
        }
      });
    }
  } finally {
    setSystemTime();
  }
});

test("checkpoints the current page and stops starting pages at the action deadline", async () => {
  let planned = 0;
  const { t, now } = fixture({
    ...allModules,
    "./pendingMessages.ts": async () => ({
      ...(await import("./pendingMessages")),
      planStuckMessages: Object.assign(() => {}, planStuckMessages, {
        _handler: async (
          ...args: Parameters<(typeof planStuckMessages)["_handler"]>
        ) => {
          const page = await planStuckMessages._handler(...args);
          planned++;
          setSystemTime(args[1].now + STUCK_MESSAGE_RUN_BUDGET_MS);
          return page;
        },
      }),
    }),
  });
  try {
    setSystemTime(now);
    const created = now - 7 * 24 * 60 * 60_000;
    await t.run(async ({ db }) => {
      const owner = await db.insert("users", { name: "Owner" });
      const conversation = await db.insert("conversations", {
        user_id: owner,
        session_id: "offline",
        agent_type: "claude_code",
        status: "active",
      });
      for (let i = 0; i <= STUCK_MESSAGES_PER_PAGE; i++) {
        await db.insert("pending_messages", {
          conversation_id: conversation,
          from_user_id: owner,
          status: "pending",
          created_at: created + i,
          content: "Waiting for a daemon",
          retry_count: 0,
        });
      }
    });
    await t.action(internal.pendingMessages.retryStuckMessages, {});
    expect(planned).toBe(1);
    expect(
      await t.run(({ db }) => db.query("pending_message_sweep_state").first()),
    ).toMatchObject({
      cursor: { createdAt: created + STUCK_MESSAGES_PER_PAGE - 1 },
    });
  } finally {
    setSystemTime();
  }
});
