import { afterEach, expect, setSystemTime, test } from "bun:test";
import { sessionMachine, type SessionFact } from "@codecast/session-contract";
import { setupRunLease, start } from "../test-helpers/run-lease.testkit";
import type { Id } from "./_generated/dataModel";
import {
  abandonAmbiguousAndResendInDb,
  markDeliveryAmbiguousInDb,
  startDeliveryInDb,
} from "./executionBindings";

afterEach(() => setSystemTime());

type AsyncSyscall = (operation: string, args: string) => Promise<string>;
type Write = {
  operation: "insert" | "patch";
  table: string;
  fields: Record<string, unknown>;
};

async function recordWrites<T>(run: () => Promise<T>) {
  const runtime = (globalThis as unknown as { Convex: object }).Convex;
  const original = Object.getOwnPropertyDescriptor(runtime, "asyncSyscall")!;
  const writes: Write[] = [];
  Object.defineProperty(runtime, "asyncSyscall", {
    ...original,
    get() {
      const call: AsyncSyscall = original.get!.call(runtime);
      return async (operation: string, json: string) => {
        const result = await call(operation, json);
        if (operation !== "1.0/insert" && operation !== "1.0/shallowMerge")
          return result;
        const { table, id, value } = JSON.parse(json);
        const target = ["conversations", "pending_messages"].find(
          (name) => table === name || id?.endsWith(name),
        );
        if (target)
          writes.push({
            operation: operation === "1.0/insert" ? "insert" : "patch",
            table: target,
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

test("risk resend revives after inserting the replacement and does not write on replay", async () => {
  setSystemTime(new Date(start));
  const { t, owner, conversation, message, claim, deliver } =
    await setupRunLease();
  const lease = await claim("resend-revival");
  if (lease.status !== "granted") throw new Error("Expected a lease");
  const claimed = await deliver(lease.fencing_token, start + 1);
  const fence = {
    ...claimed.permit,
    attemptId: claimed.permit.attemptId as Id<"delivery_attempts">,
    messageId: message,
    conversationId: conversation,
    conversationSequence: Number(claimed.permit.conversationSequence),
    fencingToken: lease.fencing_token,
  };
  await t.run(async (ctx) => {
    await startDeliveryInDb(ctx, owner, { ...fence, now: start + 2 });
    await markDeliveryAmbiguousInDb(ctx, owner, {
      ...fence,
      failureCode: "ACK_LOST",
      failureMessage: "delivery effect unknown",
      now: start + 3,
    });
    await ctx.db.patch(conversation, {
      status: "completed",
      inbox_dismissed_at: start - 1,
      inbox_stashed_at: start - 1,
      inbox_killed_at: start - 1,
    });
  });

  const resend = (now: number) =>
    t.run((ctx) =>
      abandonAmbiguousAndResendInDb(ctx, owner, {
        ...fence,
        newClientId: "replacement",
        resolutionEvidence: "user accepted duplicate-effect risk",
        now,
      }),
    );
  const now = start + 4;
  const { result, writes } = await recordWrites(() => resend(now));
  expect(writes.map(({ operation, table }) => `${operation} ${table}`)).toEqual(
    [
      "patch pending_messages",
      "patch conversations",
      "insert pending_messages",
      "patch conversations",
    ],
  );
  expect(writes[0].fields.delivery_status).toBe("abandoned-ambiguous");
  expect(writes[1].fields).toEqual({ has_pending_messages: false });
  expect(writes[2].fields).toMatchObject({
    delivery_id: "replacement",
    resend_of_delivery_id: "delivery",
  });
  const unset = { $undefined: null };
  expect(writes[3].fields).toEqual({
    updated_at: now,
    has_pending_messages: true,
    status: "active",
    inbox_dismissed_at: unset,
    inbox_stashed_at: unset,
    inbox_killed_at: unset,
  });
  expect(await t.run(({ db }) => db.get(conversation))).toMatchObject({
    status: "active",
    has_pending_messages: true,
    updated_at: now,
  });
  expect(await recordWrites(() => resend(now + 1))).toEqual({
    result,
    writes: [],
  });

  const scope = { session: lease.session, run: lease.run };
  const request = {
    ...scope,
    v: 1,
    fencing_token: lease.fencing_token,
    attempt_id: String(fence.attemptId),
    delivery_id: "delivery",
    seq: 1,
    intent: "steer",
    sender: { kind: "person", id: String(owner) },
  } as const;
  const facts: SessionFact[] = [
    {
      ...request,
      kind: "run.claimed",
      claimNumber: 1,
      expires_at: now + 1_000,
    },
    { ...request, kind: "run.runtimeReady" },
    { ...request, kind: "inbox.submitted", expectedTurn: null },
    { ...request, kind: "delivery.permitted", attemptNumber: 1 },
    { kind: "delivery.start", request, turn: null },
    { kind: "delivery.settle", request: { ...request, outcome: "in_doubt" } },
    {
      kind: "provider.event",
      event: {
        ...scope,
        v: 1,
        seq: 1,
        at: start + 3,
        source: "provider",
        turn: null,
        kind: "session.ended",
        body: { reason: "completed" },
      },
    },
  ];
  const ended = facts.reduce(
    (state, fact) => sessionMachine.apply(state, fact).state,
    sessionMachine.initial(scope),
  );
  expect(ended.inbox[0]?.status).toBe("ambiguous");
  const replayed = sessionMachine.apply(ended, {
    ...scope,
    kind: "inbox.abandoned",
    delivery_id: request.delivery_id,
    resend: {
      delivery_id: result.deliveryId,
      seq: 2,
      intent: "steer",
      expectedTurn: null,
    },
  }).state;
  expect(replayed.status).toBe("completed");
  expect(replayed.inbox.map(({ delivery_id }) => delivery_id)).toEqual([
    "delivery",
  ]);
});
