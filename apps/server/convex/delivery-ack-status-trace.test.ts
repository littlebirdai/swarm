import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import { sessionMachine, type SessionFact } from "@codecast/session-contract";
import { api } from "./_generated/api";
import {
  insertEnqueuedPendingMessage,
  insertRiskResendPendingMessage,
} from "./pendingMessageWrites";
import { asUser, serverTest } from "../test-helpers/database.testkit";
import { fixtureRows, type NewRow } from "../test-helpers/rows.testkit";

const now = 1_750_000_000_000;
const then = now - 1000;
let limiterShard: ReturnType<typeof spyOn>;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(now);
  limiterShard = spyOn(Math, "random").mockReturnValue(0.5);
});

afterEach(() => {
  limiterShard.mockRestore();
  jest.clearAllTimers();
  jest.useRealTimers();
});

type AsyncSyscall = (operation: string, args: string) => Promise<string>;
type Write = {
  table: string;
  id: string;
  operation: "insert" | "patch";
  fields: Record<string, unknown>;
};

async function recordWrites<T>(run: () => Promise<T>) {
  const runtime = (globalThis as unknown as { Convex: object }).Convex;
  const original = Object.getOwnPropertyDescriptor(runtime, "asyncSyscall")!;
  const writes: Write[] = [];
  const tables = [
    "pending_messages",
    "conversations",
    "managed_sessions",
    "session_heartbeats",
    "anchors",
    "org_roles",
  ];
  Object.defineProperty(runtime, "asyncSyscall", {
    ...original,
    get() {
      const call: AsyncSyscall = original.get!.call(runtime);
      return async (operation: string, json: string) => {
        if (operation !== "1.0/insert" && operation !== "1.0/shallowMerge")
          return call(operation, json);
        const { table, id, value } = JSON.parse(json);
        const target = tables.find(
          (name) => table === name || id?.endsWith(name),
        );
        if (target && operation === "1.0/shallowMerge")
          writes.push({ table: target, id, operation: "patch", fields: value });
        const result = await call(operation, json);
        if (target && operation === "1.0/insert")
          writes.push({
            table: target,
            id: JSON.parse(result)._id,
            operation: "insert",
            fields: value,
          });
        return result;
      };
    },
  });
  try {
    return { result: await run(), writes };
  } finally {
    Object.defineProperty(runtime, "asyncSyscall", original);
  }
}

async function seed() {
  const t = serverTest();
  const ids = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "delivery status replay");
    const user = await rows.user({ name: "Owner" });
    const conversation = await rows.conversation(user, {
      session_id: "delivery-status-trace",
      has_pending_messages: true,
      pending_kill_generation: 7,
    });
    const session = await rows.session(user, {
      conversation_id: conversation,
      session_id: "delivery-status-trace",
      agent_status: "working",
      agent_status_updated_at: then,
      agent_status_write_at: then,
      last_heartbeat: then,
    });
    const heartbeat = await db.insert("session_heartbeats", {
      managed_session_id: session,
      user_id: user,
      heartbeat_at: then,
    });
    return { user, conversation, session, heartbeat };
  });
  return {
    t,
    viewer: asUser(t, ids.user),
    ...ids,
    message: (fields: Partial<NewRow<"pending_messages">> = {}) =>
      t.run(({ db }) =>
        db.insert("pending_messages", {
          conversation_id: ids.conversation,
          from_user_id: ids.user,
          content: "Queued input",
          status: "injected",
          created_at: then,
          retry_count: 2,
          ...fields,
        }),
      ),
  };
}

function patch(
  table: string,
  id: string,
  fields: Record<string, unknown>,
): Write {
  return { operation: "patch", table, id, fields };
}

const delivered = { status: "delivered", delivered_at: now };
const ready = { status: "pending" };

for (const path of [
  "last pending",
  "another pending",
  "terminal",
  "fenced",
] as const) {
  test(`explicit acknowledgment preserves the ${path} trace`, async () => {
    const { t, viewer, conversation, message } = await seed();
    const target = await message({
      status: path === "terminal" ? "cancelled" : "pending",
      ...(path === "fenced" ? { delivery_protocol_version: 2 } : {}),
      delivery_disposition_reason: "unconfirmed",
    });
    const other = await message({
      status: path === "another pending" ? "pending" : "injected",
    });
    const { result, writes } = await recordWrites(() =>
      viewer.mutation(api.managedSessions.markMessageDelivered, {
        message_id: target,
      }),
    );
    const skipped = path === "terminal" || path === "fenced";
    expect(result).toEqual(
      skipped ? { success: true, skipped: true } : { success: true },
    );
    expect(writes).toEqual(
      skipped
        ? []
        : [
            patch("pending_messages", target, delivered),
            ...(path === "last pending"
              ? [
                  patch("conversations", conversation, {
                    has_pending_messages: false,
                  }),
                ]
              : []),
          ],
    );
    const stored = await t.run(async ({ db }) => [
      await db.get(target),
      await db.get(other),
    ]);
    expect(stored[0]).toMatchObject({
      status: skipped
        ? path === "terminal"
          ? "cancelled"
          : "pending"
        : "delivered",
      delivery_disposition_reason: "unconfirmed",
    });
    expect(stored[1]?.status).toBe(
      path === "another pending" ? "pending" : "injected",
    );
  });
}

for (const path of [
  "observed",
  "observed with queued input",
  "presumed",
] as const) {
  test(`${path} agent status preserves verified-paste acknowledgment order`, async () => {
    const { t, viewer, conversation, message, heartbeat, session } =
      await seed();
    const first = await message({ paste_verified_at: then });
    const unverified = await message();
    const second = await message({ paste_verified_at: then + 1 });
    if (path === "observed with queued input")
      await message({ status: "pending" });
    const { result, writes } = await recordWrites(() =>
      viewer.mutation(api.managedSessions.updateAgentStatus, {
        conversation_id: conversation,
        agent_status: "working",
        client_ts: now,
        ...(path === "presumed" ? { presumed: true } : {}),
      }),
    );
    expect(result).toEqual({ applied: true });
    expect(writes).toEqual([
      patch("session_heartbeats", heartbeat, {
        heartbeat_at: now,
        agent_status_write_at: now,
      }),
      patch("managed_sessions", session, {
        agent_status: "working",
        agent_status_boundary: { $undefined: null },
        last_heartbeat: now,
        liveness_lease: { end: now + 120_000, expired: false },
        liveness_lease_generation: 1,
      }),
      ...(path === "presumed"
        ? []
        : [
            patch("pending_messages", first, delivered),
            patch("pending_messages", second, delivered),
          ]),
      ...(path === "observed"
        ? [
            patch("conversations", conversation, {
              has_pending_messages: false,
            }),
          ]
        : []),
    ]);
    expect((await t.run(({ db }) => db.get(unverified)))?.status).toBe(
      "injected",
    );
  });
}

for (const path of [
  "legacy",
  "standing hold",
  "shared queue",
  "fenced",
  "risk resend",
] as const) {
  test(`${path} admission preserves the inserted delivery row`, async () => {
    const { t, user, conversation } = await seed();
    const fenced = path === "fenced" || path === "risk resend";
    const delivery = {
      protocolVersion: 2,
      deliveryId: "admission-trace",
      conversationSequence: 5,
      executionEpoch: 2,
    };
    const fields = {
      conversationId: conversation,
      fromUserId: user,
      ownerUserId: user,
      clientId: delivery.deliveryId,
      content: "New input",
      createdAt: now,
    };
    const { result: id, writes } = await recordWrites(() =>
      t.run((ctx) =>
        path === "risk resend"
          ? insertRiskResendPendingMessage(ctx, {
              ...fields,
              delivery,
              resendOfDeliveryId: "old-attempt",
            })
          : insertEnqueuedPendingMessage(ctx, {
              ...fields,
              ...(path === "standing hold" ? { held: true } : {}),
              ...(path === "shared queue" ? { queued: true } : {}),
              ...(fenced ? { delivery } : {}),
            }),
      ),
    );
    const status =
      path === "standing hold" || path === "shared queue" ? "held" : "pending";
    expect(writes).toEqual([
      {
        table: "pending_messages",
        id,
        operation: "insert",
        fields: {
          conversation_id: conversation,
          kill_generation: 7,
          from_user_id: user,
          owner_user_id: user,
          content: "New input",
          client_id: delivery.deliveryId,
          status,
          created_at: now,
          retry_count: 0,
          ...(path === "shared queue" ? { queued: true } : {}),
          ...(fenced
            ? {
                delivery_protocol_version: 2,
                delivery_id: delivery.deliveryId,
                conversation_sequence: 5,
                execution_epoch: 2,
                delivery_status: "pending",
              }
            : {}),
          ...(path === "risk resend"
            ? { resend_of_delivery_id: "old-attempt" }
            : {}),
        },
      },
    ]);
    expect((await t.run(({ db }) => db.get(id)))?.status).toBe(status);
  });
}

for (const path of ["explicit release", "turn settle"] as const) {
  test(`${path} publishes only end-of-turn queue rows in order`, async () => {
    const { t, viewer, conversation, heartbeat, session, message } =
      await seed();
    const first = await message({ status: "held", queued: true });
    const standing = await message({ status: "held" });
    const second = await message({ status: "held", queued: true });
    const { result, writes } = await recordWrites(() =>
      path === "explicit release"
        ? viewer.mutation(api.pendingMessages.releaseQueued, {
            conversation_id: conversation,
          })
        : viewer.mutation(api.managedSessions.updateAgentStatus, {
            conversation_id: conversation,
            agent_status: "idle",
            client_ts: now,
          }),
    );
    expect(result).toEqual(path === "explicit release" ? 2 : { applied: true });
    expect(writes).toEqual([
      ...(path === "turn settle"
        ? [
            patch("session_heartbeats", heartbeat, {
              agent_status_write_at: now,
            }),
            patch("managed_sessions", session, {
              agent_status: "idle",
              agent_status_updated_at: now,
              agent_status_write_at: now,
              agent_status_boundary: { $undefined: null },
            }),
          ]
        : []),
      patch("pending_messages", first, ready),
      patch("pending_messages", second, ready),
    ]);
    expect((await t.run(({ db }) => db.get(standing)))?.status).toBe("held");
  });
}

for (const choice of ["keep", "retire"] as const) {
  test(`role retirement with ${choice} preserves the held-row trace`, async () => {
    const { t, viewer, user, conversation, message } = await seed();
    const { anchor, role } = await t.run(async ({ db }) => {
      const rows = fixtureRows(db, "delivery replay standing role");
      const bot = await rows.user({ is_bot: true, bot_kind: "role" });
      const anchor = await db.insert("anchors", {
        scope_type: "user",
        scope_user_id: user,
        bot_user_id: bot,
        host_user_id: user,
        conversation_id: conversation,
        name: "Standing trace",
        status: "active",
        created_at: then,
      });
      const role = await rows.role(user, {
        anchor_id: anchor,
        scope_user_id: user,
      });
      await db.patch(anchor, { org_role_id: role });
      await db.patch(conversation, {
        anchor_id: anchor,
        standing_role_id: role,
      });
      return { anchor, role };
    });
    const held = await message({ status: "held" });
    const queued = await message({ status: "held", queued: true });
    const { result, writes } = await recordWrites(() =>
      viewer.mutation(api.orgRoles.retire, {
        role_id: role,
        standing_session: choice,
      }),
    );

    const kept = choice === "keep";
    const status = kept ? "pending" : "cancelled";
    expect(result).toMatchObject({
      status: "retired",
      standing_session: kept ? "kept" : "retired",
    });
    expect(writes).toEqual([
      patch("pending_messages", held, { status }),
      patch("pending_messages", queued, { status }),
      ...(kept
        ? [
            patch("anchors", anchor, {
              org_role_id: { $undefined: null },
              updated_at: now,
            }),
            patch("conversations", conversation, {
              standing_role_id: { $undefined: null },
              updated_at: now,
            }),
          ]
        : [
            patch("conversations", conversation, {
              inbox_pinned_at: { $undefined: null },
              persistent: false,
            }),
            patch("conversations", conversation, {
              inbox_killed_at: now,
              status: "completed",
            }),
            patch("conversations", conversation, {
              pending_kill_generation: 8,
            }),
            patch("conversations", conversation, {
              has_pending_messages: false,
            }),
            patch("anchors", anchor, {
              status: "decommissioned",
              updated_at: now,
            }),
            patch("conversations", conversation, {
              acting_user_id: { $undefined: null },
              anchor_id: { $undefined: null },
              standing_role_id: { $undefined: null },
              updated_at: now,
            }),
          ]),
      patch("org_roles", role, { status: "retired", updated_at: now }),
    ]);

    const rows = await t.run(async ({ db }) => [
      await db.get(held),
      await db.get(queued),
    ]);
    expect(rows.map((row) => row?.status)).toEqual([status, status]);
  });
}

test("the reducer preserves held input and requires per-delivery acknowledgment evidence", async () => {
  const scope = { session: "delivery-status-trace", run: 1 };
  const fence = { ...scope, fencing_token: "trace-fence" };
  const request = {
    ...fence,
    v: 1,
    delivery_id: "trace-delivery",
    attempt_id: "trace-attempt",
    seq: 1,
    intent: "steer",
    sender: { kind: "person", id: "owner" },
  } as const;
  const initial = sessionMachine.initial(scope);
  const held = sessionMachine.apply(initial, {
    ...request,
    kind: "inbox.submitted",
    expectedTurn: null,
    held: true,
  }).state;
  const released = sessionMachine.apply(held, {
    ...request,
    kind: "inbox.released",
  }).state;
  const cancelled = sessionMachine.apply(held, {
    ...request,
    kind: "inbox.cancelled",
  }).state;
  expect([
    held.inbox[0]?.status,
    released.inbox[0]?.status,
    cancelled.inbox[0]?.status,
  ]).toEqual(["held", "pending", "cancelled-by-supersession"]);

  const facts: SessionFact[] = [
    { ...fence, kind: "run.claimed", claimNumber: 1, expires_at: now + 1000 },
    { ...fence, kind: "run.runtimeReady" },
    { ...request, kind: "delivery.permitted", attemptNumber: 1 },
    { kind: "delivery.start", request, turn: null },
  ];
  const started = facts.reduce(
    (state, fact) => sessionMachine.apply(state, fact).state,
    released,
  );
  const { t, viewer, conversation, message } = await seed();
  const row = await message({ paste_verified_at: then });
  await viewer.mutation(api.managedSessions.updateAgentStatus, {
    conversation_id: conversation,
    agent_status: "working",
    client_ts: now,
  });
  const legacy = await t.run(({ db }) => db.get(row));
  expect([legacy?.status, started.inbox[0]?.status]).toEqual([
    "delivered",
    "delivery-started",
  ]);

  const settled = sessionMachine.apply(started, {
    kind: "delivery.settle",
    request: { ...request, outcome: "applied" },
  }).state;
  expect(settled.inbox[0]?.status).toBe("delivered");
});
