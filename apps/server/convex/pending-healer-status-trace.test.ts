import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import { sessionMachine, type SessionFact } from "@codecast/session-contract";
import { UNCONFIRMED_DELIVERY_REASON } from "@codecast/sessions/pendingStatus";
import { api, internal } from "./_generated/api";
import { PANE_REFUSED_ERROR } from "./lib/paneRefusal";
import { resetConversationPendingMessages } from "./pendingMessages";
import { asUser, serverTest } from "../test-helpers/database.testkit";
import { fixtureRows, type NewRow } from "../test-helpers/rows.testkit";

const now = 1_750_000_000_000;
const minute = 60_000;
const age = 35 * minute;
const unset = { $undefined: null };
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

type Write = {
  id: string;
  fields: Record<string, unknown>;
  operation?: "insert";
};
type AsyncSyscall = (operation: string, args: string) => Promise<string>;

async function recordWrites<T>(run: () => Promise<T>) {
  const runtime = (globalThis as unknown as { Convex: object }).Convex;
  const original = Object.getOwnPropertyDescriptor(runtime, "asyncSyscall")!;
  const writes: Write[] = [];
  const tracked = ["conversations", "pending_messages", "messages"];
  Object.defineProperty(runtime, "asyncSyscall", {
    ...original,
    get() {
      const call: AsyncSyscall = original.get!.call(runtime);
      return async (operation: string, json: string) => {
        const result = await call(operation, json);
        if (operation !== "1.0/insert" && operation !== "1.0/shallowMerge")
          return result;
        const { table, id, value } = JSON.parse(json);
        if (tracked.some((name) => table === name || id?.endsWith(name))) {
          writes.push({
            id: id ?? JSON.parse(result)._id,
            fields: value,
            ...(operation === "1.0/insert" ? { operation: "insert" } : {}),
          });
        }
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

async function seed(
  options: {
    readiness?: "idle" | "working" | "gone" | "offline";
    sender?: "active" | "completed";
    conversation?: Partial<NewRow<"conversations">>;
    message?: Partial<NewRow<"pending_messages">>;
  } = {},
) {
  const t = serverTest();
  const ids = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "pending healer status replay");
    const user = await rows.user();
    const conversation = await rows.conversation(user, {
      has_pending_messages: true,
      ...options.conversation,
    });
    if (options.readiness === "idle" || options.readiness === "working")
      await rows.session(user, {
        conversation_id: conversation,
        agent_status: options.readiness,
        last_heartbeat: now,
      });
    if (options.readiness === "gone") await db.delete(conversation);
    const sender = options.sender ? await rows.user() : null;
    const source = sender
      ? await rows.conversation(sender, { status: options.sender })
      : undefined;
    const receipt =
      sender && source && options.sender === "active"
        ? await db.insert("pending_messages", {
            conversation_id: source,
            from_user_id: sender,
            status: "pending",
            content: "Previous receipt",
            created_at: now - age,
            retry_count: 0,
          })
        : undefined;
    const message = await db.insert("pending_messages", {
      from_user_id: sender ?? user,
      owner_user_id: user,
      conversation_id: conversation,
      from_conversation_id: source,
      sender_notice_id: receipt,
      status: "injected",
      content: "Queued input",
      created_at: now - age,
      retry_count: 3,
      ...options.message,
    });
    return { user, conversation, message, receipt };
  });
  const viewer = asUser(t, ids.user);
  return {
    t,
    viewer,
    ...ids,
    sweep: () =>
      recordWrites(() =>
        t.mutation(internal.pendingMessages.applyStuckMessages, {
          ids: [ids.message],
          now,
          deadRevivesRemaining: 3,
          allowHostedWake: true,
        }),
      ),
    readMessage: () => t.run(({ db }) => db.get(ids.message)),
  };
}

const repend = {
  status: "pending",
  retry_count: 0,
  delivered_at: unset,
  paste_verified_at: unset,
  delivery_disposition_reason: unset,
  delivery_hold_screen: unset,
};

for (const readiness of ["idle", "offline", "working"] as const) {
  test(`the ${readiness} healer keeps its replay write order`, async () => {
    const { message, conversation, sweep, readMessage } = await seed({
      readiness,
      message: { delivery_disposition_reason: "previous hold" },
    });
    const { result, writes } = await sweep();
    const waits = readiness === "working";
    expect(result).toMatchObject({
      acted: waits ? [] : [message],
      revived: waits ? 0 : 1,
      deadRevived: readiness === "offline" ? 1 : 0,
    });
    expect(writes).toEqual(
      waits
        ? []
        : [
            { id: message, fields: repend },
            ...(readiness === "offline"
              ? [{ id: message, fields: { dead_session_revived_at: now } }]
              : []),
            { id: conversation, fields: { has_pending_messages: true } },
          ],
    );
    const row = await readMessage();
    expect(row?.status).toBe(waits ? "injected" : "pending");
    expect(row?.retry_count).toBe(waits ? 3 : 0);
    expect(row?.delivery_disposition_reason).toBe(
      waits ? "previous hold" : undefined,
    );
  });
}

for (const readiness of ["idle", "offline"] as const) {
  test(`the ${readiness} healer records an unconfirmed paste before the sender receipt`, async () => {
    const { message, conversation, receipt, sweep, readMessage } = await seed({
      readiness,
      sender: "active",
      message: { paste_verified_at: now - age },
    });
    const { result, writes } = await sweep();
    expect(result).toMatchObject({ acted: [message], failedUnconfirmed: 1 });
    expect(writes).toEqual([
      {
        id: message,
        fields: {
          status: "failed",
          delivery_disposition_reason: UNCONFIRMED_DELIVERY_REASON,
        },
      },
      { id: conversation, fields: { has_pending_messages: false } },
      {
        id: receipt,
        fields: {
          content: expect.stringContaining("arrival was never confirmed"),
        },
      },
      { id: message, fields: { sender_notified_at: now } },
    ]);
    expect(await readMessage()).toMatchObject({
      status: "failed",
      paste_verified_at: now - age,
      delivery_disposition_reason: UNCONFIRMED_DELIVERY_REASON,
    });
  });
}

test("the healer expires an unconfirmed paste before clearing the queue flag", async () => {
  const { message, conversation, sweep, readMessage } = await seed({
    message: {
      status: "failed",
      paste_verified_at: now - 25 * 60 * minute,
      delivery_disposition_reason: UNCONFIRMED_DELIVERY_REASON,
    },
  });
  const { result, writes } = await sweep();
  expect(result).toMatchObject({ acted: [message], expiredUnconfirmed: 1 });
  expect(writes).toEqual([
    {
      id: message,
      fields: { status: "cancelled", delivery_disposition_reason: unset },
    },
    { id: conversation, fields: { has_pending_messages: false } },
  ]);
  const row = await readMessage();
  expect(row?.status).toBe("cancelled");
  expect(row?.delivery_disposition_reason).toBeUndefined();
});

test("the healer settles a stale control row before clearing pane refusal and the queue flag", async () => {
  const { message, conversation, sweep, readMessage } = await seed({
    readiness: "idle",
    conversation: {
      pane_refused_at: now - age,
      session_error: PANE_REFUSED_ERROR,
    },
    message: { content: '{"__cc_poll":true,"keys":["1"]}' },
  });
  const { result, writes } = await sweep();
  expect(result).toMatchObject({ acted: [message], controlsAcked: 1 });
  expect(writes).toEqual([
    { id: message, fields: { status: "delivered", delivered_at: now } },
    {
      id: conversation,
      fields: { pane_refused_at: unset, session_error: unset },
    },
    { id: conversation, fields: { has_pending_messages: false } },
  ]);
  expect(await readMessage()).toMatchObject({
    status: "delivered",
    delivered_at: now,
  });
});

for (const sender of ["active", "completed"] as const) {
  test(`the gone-target healer cancels after handling the ${sender} sender`, async () => {
    const { message, receipt, sweep, readMessage } = await seed({
      readiness: "gone",
      sender,
      message: { status: "pending" },
    });
    const { result, writes } = await sweep();
    expect(result).toMatchObject({ acted: [message], notified: 1 });
    expect(writes).toEqual([
      ...(receipt
        ? [
            {
              id: receipt,
              fields: {
                content: expect.stringContaining("session no longer exists"),
              },
            },
          ]
        : []),
      { id: message, fields: { sender_notified_at: now } },
      { id: message, fields: { status: "cancelled" } },
    ]);
    expect(await readMessage()).toMatchObject({
      status: "cancelled",
      sender_notified_at: now,
    });
  });
}

test("the healer leaves fenced pending rows to the delivery protocol", async () => {
  const { sweep, readMessage } = await seed({
    readiness: "idle",
    message: { delivery_protocol_version: 2 },
  });
  const { result, writes } = await sweep();
  expect(result.acted).toEqual([]);
  expect(writes).toEqual([]);
  expect((await readMessage())?.status).toBe("injected");
});

test("bulk cancellation keeps its dry run and preserves the unconfirmed reason", async () => {
  const { t, user, conversation, message, readMessage } = await seed({
    message: {
      status: "failed",
      delivery_disposition_reason: UNCONFIRMED_DELIVERY_REASON,
    },
  });
  const injected = await t.run(({ db }) =>
    db.insert("pending_messages", {
      conversation_id: conversation,
      from_user_id: user,
      status: "injected",
      content: "Submitted",
      created_at: now - age + 1,
      retry_count: 0,
      paste_verified_at: now - age + 2,
    }),
  );
  for (const dry_run of [true, false]) {
    const { result, writes } = await recordWrites(() =>
      t.mutation(internal.pendingMessages.cancelOldPendingMessages, {
        older_than_ms: minute,
        dry_run,
      }),
    );
    expect(result).toEqual({
      cancelled: 2,
      matched: 2,
      conversations: 1,
      has_more: false,
      dry_run,
    });
    expect(writes).toEqual(
      dry_run
        ? []
        : [
            { id: message, fields: { status: "cancelled" } },
            { id: injected, fields: { status: "cancelled" } },
            { id: conversation, fields: { has_pending_messages: false } },
          ],
    );
    expect(await readMessage()).toMatchObject({
      status: dry_run ? "failed" : "cancelled",
      delivery_disposition_reason: UNCONFIRMED_DELIVERY_REASON,
    });
  }
});

for (const path of [
  "daemon retry",
  "daemon hold",
  "daemon reset",
  "resume reset",
  "person retry",
] as const) {
  test(`${path} keeps its requeue fields and order`, async () => {
    const byPerson = path === "person retry";
    const { t, viewer, conversation, message, readMessage } = await seed({
      message: {
        status: byPerson ? "failed" : "injected",
        ...(path === "daemon retry" || byPerson
          ? { paste_verified_at: now - age }
          : {}),
        ...(byPerson
          ? { delivery_disposition_reason: UNCONFIRMED_DELIVERY_REASON }
          : {}),
      },
    });
    const { result, writes } = await recordWrites(async () => {
      switch (path) {
        case "daemon retry":
        case "daemon hold":
          return viewer.mutation(api.pendingMessages.retryMessage, {
            message_id: message,
            ...(path === "daemon hold"
              ? { hold_reason: "terminal dialog", hold_screen: "Continue?" }
              : {}),
          });
        case "daemon reset":
          return viewer.mutation(api.pendingMessages.resetInjectedMessages, {
            conversation_id: conversation,
          });
        case "resume reset":
          return t.run((ctx) =>
            resetConversationPendingMessages(ctx, conversation),
          );
        case "person retry":
          return viewer.mutation(api.dispatch.dispatch, {
            action: "retryPendingMessage",
            args: [conversation, { messageId: message, force: true }],
          });
      }
    });
    const retryCount =
      path === "daemon retry" || path === "daemon reset"
        ? 4
        : path === "daemon hold"
          ? 3
          : 0;
    expect(result).toEqual(
      byPerson
        ? "pending"
        : path === "daemon reset"
          ? { reset: 1 }
          : path === "resume reset"
            ? 1
            : { success: true, skipped: false },
    );
    expect(writes).toEqual([
      {
        id: message,
        fields: {
          ...repend,
          retry_count: retryCount,
          ...(byPerson ? { delivery_force: true } : {}),
          ...(path === "daemon hold"
            ? {
                delivery_disposition_reason: "terminal dialog",
                delivery_hold_screen: "Continue?",
              }
            : {}),
        },
      },
      ...(path === "daemon retry" || path === "daemon hold"
        ? []
        : [{ id: conversation, fields: { has_pending_messages: true } }]),
    ]);
    expect(await readMessage()).toMatchObject({
      status: "pending",
      retry_count: retryCount,
    });
  });
}

for (const correlated of [true, false]) {
  test(`${correlated ? "correlated" : "blanket"} daemon ack preserves transcript and status write order`, async () => {
    const { t, viewer, user, conversation, message, readMessage } = await seed({
      message: { client_id: "delivery-trace" },
    });
    const { transcript, other } = await t.run(async ({ db }) => {
      const rows = fixtureRows(db, "ack transcript");
      return {
        transcript: await rows.message(conversation),
        other: await db.insert("pending_messages", {
          conversation_id: conversation,
          from_user_id: user,
          status: "injected",
          content: "Another input",
          created_at: now - age + 1,
          retry_count: 0,
        }),
      };
    });
    const { result, writes } = await recordWrites(() =>
      viewer.mutation(api.pendingMessages.ackInjectedMessages, {
        conversation_id: conversation,
        ...(correlated
          ? {
              message_ids: [message],
              delivery_acks: [
                {
                  pending_message_id: message,
                  transcript_message_id: transcript,
                },
              ],
            }
          : {}),
      }),
    );
    expect(result).toEqual({ acked: correlated ? 1 : 2 });
    expect(writes).toEqual([
      ...(correlated
        ? [
            { id: transcript, fields: { client_id: "delivery-trace" } },
            { id: message, fields: { echo_message_id: transcript } },
          ]
        : []),
      { id: message, fields: { status: "delivered", delivered_at: now } },
      ...(correlated
        ? []
        : [
            { id: other, fields: { status: "delivered", delivered_at: now } },
            { id: conversation, fields: { has_pending_messages: false } },
          ]),
    ]);
    expect(await readMessage()).toMatchObject({
      status: "delivered",
      delivered_at: now,
    });
    expect((await t.run(({ db }) => db.get(other)))?.status).toBe(
      correlated ? "injected" : "delivered",
    );
  });
}

test("pane refusal writes cancellation before clearing the queue flag", async () => {
  const { viewer, conversation, message, readMessage } = await seed();
  const { result, writes } = await recordWrites(() =>
    viewer.mutation(api.paneRecovery.reportPaneRefused, {
      message_id: message,
    }),
  );
  expect(result).toEqual({ recovered: false });
  expect(writes).toEqual([
    { id: message, fields: { status: "cancelled" } },
    { id: conversation, fields: { has_pending_messages: false } },
  ]);
  expect((await readMessage())?.status).toBe("cancelled");
});

test("delivery facts preserve the known healer replay gaps", async () => {
  const scope = { session: "healer-trace", run: 1 };
  const fence = { ...scope, fencing_token: "first-token" };
  const request = {
    ...fence,
    v: 1,
    delivery_id: "message",
    attempt_id: "attempt",
    seq: 1,
    intent: "steer",
    sender: { kind: "person", id: "sender" },
  } as const;
  const facts: SessionFact[] = [
    { ...fence, kind: "run.claimed", claimNumber: 1, expires_at: now + minute },
    { ...fence, kind: "run.runtimeReady" },
    { ...request, kind: "inbox.submitted", expectedTurn: null },
    { ...request, kind: "delivery.permitted", attemptNumber: 1 },
  ];
  const permitted = facts.reduce(
    (state, fact) => sessionMachine.apply(state, fact).state,
    sessionMachine.initial(scope),
  );
  const started = sessionMachine.apply(permitted, {
    kind: "delivery.start",
    request,
    turn: null,
  }).state;
  const ambiguous = sessionMachine.apply(started, {
    kind: "delivery.settle",
    request: { ...request, outcome: "in_doubt" },
  }).state;
  const cases = [
    {
      name: "elapsed retry",
      fixture: { readiness: "idle" },
      model: sessionMachine.apply(started, {
        ...request,
        kind: "delivery.returned",
      }).state,
      expected: ["pending", "delivery-started"],
    },
    {
      name: "verified paste without echo",
      fixture: { readiness: "idle", message: { paste_verified_at: now - age } },
      model: ambiguous,
      expected: ["failed", "ambiguous"],
    },
    {
      name: "expired ambiguous paste",
      fixture: {
        message: {
          status: "failed",
          delivery_disposition_reason: UNCONFIRMED_DELIVERY_REASON,
          paste_verified_at: now - 25 * 60 * minute,
        },
      },
      model: sessionMachine.apply(ambiguous, {
        ...request,
        kind: "inbox.cancelled",
      }).state,
      expected: ["cancelled", "ambiguous"],
    },
    {
      name: "control acknowledgement without a receipt",
      fixture: {
        readiness: "idle",
        message: { content: '{"__cc_poll":true,"keys":["1"]}' },
      },
      model: started,
      expected: ["delivered", "delivery-started"],
    },
  ] as const;
  for (const { name, fixture, model, expected } of cases) {
    const { sweep, readMessage } = await seed(fixture);
    await sweep();
    expect(
      [(await readMessage())?.status, model.inbox[0]?.status],
      name,
    ).toEqual(expected);
  }
});
