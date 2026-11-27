import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import { sessionMachine } from "@codecast/session-contract";
import { parseJointMessage } from "@codecast/messages/jointMessage";
import { api } from "./_generated/api";
import { asUser, serverTest } from "../test-helpers/database.testkit";
import { fixtureRows, type NewRow } from "../test-helpers/rows.testkit";

const now = 1_750_000_000_000;
const cleared = { $undefined: null };
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

type AsyncSyscall = (op: string, args: string) => Promise<string>;
type Write = {
  id: string;
  fields: Record<string, unknown>;
  inserted?: true;
};

async function recordWrites<T>(run: () => Promise<T>) {
  const runtime = (globalThis as unknown as { Convex: object }).Convex;
  const original = Object.getOwnPropertyDescriptor(runtime, "asyncSyscall")!;
  const writes: Write[] = [];
  Object.defineProperty(runtime, "asyncSyscall", {
    ...original,
    get() {
      const call: AsyncSyscall = original.get!.call(runtime);
      return async (op: string, args: string) => {
        const result = await call(op, args);
        if (op === "1.0/shallowMerge" || op === "1.0/insert") {
          const { table, id, value } = JSON.parse(args);
          if (
            ["pending_messages", "conversations"].some(
              (name) => table === name || id?.endsWith(name),
            )
          ) {
            writes.push({
              id: id ?? JSON.parse(result)._id,
              fields: value,
              ...(op === "1.0/insert" ? { inserted: true } : {}),
            });
          }
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

async function seed() {
  const t = serverTest();
  const { user, conversation } = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "pending release status replay");
    const user = await rows.user({ name: "Owner" });
    const conversation = await rows.conversation(user, {
      has_pending_messages: true,
    });
    return { user, conversation };
  });
  return {
    t,
    viewer: asUser(t, user),
    conversation,
    message: (fields: Partial<NewRow<"pending_messages">> = {}) =>
      t.run(({ db }) =>
        db.insert("pending_messages", {
          conversation_id: conversation,
          from_user_id: user,
          owner_user_id: user,
          content: "Held input",
          status: "held",
          created_at: now - 10,
          retry_count: 0,
          ...fields,
        }),
      ),
  };
}

test("new input releases deferred rows after enqueue and leaves the turn queue held", async () => {
  const { t, viewer, conversation, message } = await seed();
  const first = await message();
  const queued = await message({ queued: true });
  const second = await message();
  const { result: newId, writes } = await recordWrites(() =>
    viewer.mutation(api.pendingMessages.sendMessageToSession, {
      conversation_id: conversation,
      content: "New turn",
    }),
  );
  expect(writes).toEqual([
    {
      inserted: true,
      id: newId,
      fields: expect.objectContaining({
        status: "pending",
        content: "New turn",
      }),
    },
    { id: first, fields: { status: "pending" } },
    { id: second, fields: { status: "pending" } },
    {
      id: conversation,
      fields: { updated_at: now, has_pending_messages: true },
    },
  ]);
  expect((await t.run(({ db }) => db.get(queued)))?.status).toBe("held");
});

for (const delivery_status of [
  "pending",
  "claimed",
  "delivery-started",
  "ambiguous",
] as const) {
  test(`fenced cancellation preserves the ${delivery_status} trace`, async () => {
    const { t, viewer, conversation, message } = await seed();
    const id = await message({
      status: "pending",
      delivery_protocol_version: 2,
      delivery_id: "fenced-trace",
      conversation_sequence: 1,
      execution_epoch: 1,
      delivery_status,
    });
    const cancel = () =>
      viewer.mutation(api.dispatch.dispatch, {
        action: "cancelPendingMessage",
        args: [conversation, { messageId: id }],
      });
    if (delivery_status === "pending") {
      const { result, writes } = await recordWrites(cancel);
      expect(result).toBe("cancelled");
      expect(writes).toEqual([
        {
          id,
          fields: {
            delivery_status: "cancelled-by-supersession",
            active_delivery_attempt_id: cleared,
            status: "cancelled",
          },
        },
        { id: conversation, fields: { has_pending_messages: false } },
      ]);
      expect(await recordWrites(cancel)).toEqual({
        result: "cancelled",
        writes: [],
      });
    } else {
      const { result, writes } = await recordWrites(() =>
        cancel().catch(String),
      );
      expect(result).toContain("already being delivered");
      expect(writes).toEqual([]);
      expect((await t.run(({ db }) => db.get(id)))?.delivery_status).toBe(
        delivery_status,
      );
    }
  });
}

test("queue merge edits the earlier row before cancelling the absorbed row", async () => {
  const { t, viewer, conversation, message } = await seed();
  const absorbed = await message({
    content: "Later text",
    status: "pending",
    queue_at: 20,
  });
  const kept = await message({
    content: "Earlier text",
    queued: true,
    queue_at: 10,
    channel: "composer",
    typed_text: "Earlier text",
  });
  const { result, writes } = await recordWrites(() =>
    viewer.mutation(api.pendingMessages.mergeQueued, {
      conversation_id: conversation,
      message_id: kept,
      into_id: absorbed,
    }),
  );
  const row = await t.run(({ db }) => db.get(kept));
  expect(result).toBe("merged");
  expect(writes).toEqual([
    {
      id: kept,
      fields: { content: row?.content, channel: cleared, typed_text: cleared },
    },
    { id: absorbed, fields: { status: "cancelled", merged_into: kept } },
  ]);
  expect(parseJointMessage(row!.content)).toEqual([
    { from: "Owner", body: "Earlier text" },
    { from: "Owner", body: "Later text" },
  ]);
  expect(row?.status).toBe("held");
});

test("release and cancellation replay against the delivery contract", () => {
  const scope = { session: "pending-release", run: 1 };
  const fence = { ...scope, fencing_token: "release-trace" };
  const pending = {
    ...scope,
    intent: "steer",
    expectedTurn: null,
    delivery_id: "delivery",
    seq: 1,
  } as const;
  const initial = sessionMachine.initial(scope);
  const held = sessionMachine.apply(initial, {
    ...pending,
    kind: "inbox.submitted",
    held: true,
  }).state;
  const released = sessionMachine.apply(held, {
    ...pending,
    kind: "inbox.released",
  }).state;
  const claimed = sessionMachine.apply(initial, {
    ...fence,
    kind: "run.claimed",
    claimNumber: 1,
    expires_at: now + 1000,
  }).state;
  const ready = sessionMachine.apply(claimed, {
    ...fence,
    kind: "run.runtimeReady",
  }).state;
  const admitted = sessionMachine.apply(ready, {
    ...pending,
    kind: "inbox.submitted",
  }).state;
  const permitted = sessionMachine.apply(admitted, {
    ...fence,
    delivery_id: pending.delivery_id,
    attempt_id: "trace-attempt",
    attemptNumber: 1,
    kind: "delivery.permitted",
  }).state;
  expect(permitted.inbox[0]?.status).toBe("claimed");
  const cancel = { ...pending, kind: "inbox.cancelled" } as const;
  expect([
    released.inbox[0]?.status,
    sessionMachine.apply(admitted, cancel).state.inbox[0]?.status,
    sessionMachine.apply(permitted, cancel).state.inbox[0]?.status,
  ]).toEqual([
    "pending",
    "cancelled-by-supersession",
    "cancelled-by-supersession",
  ]);
});
