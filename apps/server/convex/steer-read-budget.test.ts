import { expect, setSystemTime, test } from "bun:test";
import { asUser } from "../test-helpers/database.testkit";
import { boot, machine, start } from "../test-helpers/run-lease.testkit";
import {
  observed,
  steerDeliveryFixture,
} from "../test-helpers/steer-delivery.testkit";
import { api, internal } from "./_generated/api";
import {
  claimNextDeliveryInDb,
  rejectHeadDeliveryInDb,
} from "./executionBindings";

test("idle admission and permit selection skip large sequenced and unsequenced delivered history", async () => {
  const flag = "SWARM_TURN_BATON";
  const previous = process.env[flag];
  process.env[flag] = "1";
  setSystemTime(new Date(start));
  try {
    const f = await steerDeliveryFixture();
    const history = 1_000;
    await f.t.run(async ({ db }) => {
      const row = (await db.get(f.message))!;
      const {
        _id,
        _creationTime,
        client_id,
        delivery_id,
        delivery_protocol_version,
        delivery_status,
        execution_epoch,
        conversation_sequence,
        ...base
      } = row;
      for (let index = 1; index <= history; index++) {
        await db.insert("pending_messages", { ...base, status: "delivered" });
        await db.insert("pending_messages", {
          ...base,
          status: "delivered",
          delivery_protocol_version,
          execution_epoch,
          delivery_status: "delivered",
          conversation_sequence: index,
          client_id: `history-${index}`,
          delivery_id: `history-${index}`,
        });
      }
      await db.patch(f.message, { conversation_sequence: history + 1 });
      await db.patch(f.head, {
        next_nonterminal_sequence: history + 1,
        next_conversation_sequence: history + 2,
      });
    });
    await f.send("expires", observed);
    await f.turn(null);
    const sendReads = await asUser(f.t, f.owner).mutation(async (ctx) => {
      await ctx.runMutation(api.pendingMessages.sendMessageV2, {
        conversation_id: f.conversation,
        content: "idle send",
        command_id: "idle-send",
        client_id: "idle-send",
      });
      return (await ctx.meta.getTransactionMetrics()).documentsRead.used;
    });
    expect(sendReads).toBeLessThan(40);
    const selected = await f.t.mutation(async (ctx) => {
      const result = await claimNextDeliveryInDb(ctx, f.owner, {
        conversationId: f.conversation,
        executionEpoch: 1,
        configurationRevision: 1,
        ownerDeviceId: machine,
        daemonBootId: boot,
        runtimeId: "runtime",
        now: start,
        fencingToken: f.fence.fencing_token,
      });
      const metrics = await ctx.meta.getTransactionMetrics();
      return {
        result,
        reads: metrics.documentsRead.used,
        queries: metrics.databaseQueries.used,
      };
    });
    expect(selected.result).toMatchObject({
      state: "claimed",
      permit: {
        deliveryId: "delivery",
        conversationSequence: String(history + 1),
      },
    });
    expect(selected.reads).toBeLessThan(30);
    expect(selected.queries).toBeLessThan(12);
    expect(
      (await f.rows()).messages.find((row) => row.client_id === "expires"),
    ).toMatchObject({ delivery_status: "rejected" });
  } finally {
    if (previous === undefined) delete process.env[flag];
    else process.env[flag] = previous;
    setSystemTime();
  }
});

test.each([
  "waiting during a turn",
  "waiting while idle",
  "delivered behind a waiting queue",
] as const)(
  "permit selection and settlement use bounded reads with 2,000 rows %s",
  async (mode) => {
    const flag = "SWARM_TURN_BATON";
    const previous = process.env[flag];
    process.env[flag] = "1";
    setSystemTime(new Date(start));
    try {
      const f = await steerDeliveryFixture();
      const idle = mode === "waiting while idle";
      const delivered = mode === "delivered behind a waiting queue";
      const count = 2_000;
      await f.t.run(async ({ db }) => {
        const { _id, _creationTime, ...base } = (await db.get(f.message))!;
        for (let index = 1; index <= count; index++) {
          const client_id = `seed-${index}`;
          await db.insert("pending_messages", {
            ...base,
            status: delivered ? "delivered" : "pending",
            delivery_status: delivered ? "delivered" : "pending",
            delivery_intent: delivered ? "steer" : "queue",
            conversation_sequence: 1 + index,
            client_id,
            delivery_id: client_id,
          });
        }
        await db.patch(f.head, { next_conversation_sequence: 2 + count });
      });

      if (idle) {
        await f.turn(null);
        const sendReads = await asUser(f.t, f.owner).mutation(async (ctx) => {
          await ctx.runMutation(api.pendingMessages.sendMessageV2, {
            conversation_id: f.conversation,
            content: "idle",
            command_id: "idle",
            client_id: "idle",
          });
          return (await ctx.meta.getTransactionMetrics()).documentsRead.used;
        });
        expect(sendReads).toBeLessThan(45);
      } else {
        await f.send("eligible-steer", observed);
      }

      const fence = { ...f.fence, v: 1 as const, bearer: f.bearer };
      const claimed = await f.t.mutation(async (ctx) => {
        const permit = await ctx.runMutation(internal.edgeDelivery.next, fence);
        return {
          permit,
          reads: (await ctx.meta.getTransactionMetrics()).documentsRead.used,
        };
      });
      expect(claimed.reads).toBeLessThan(40);
      const permit = claimed.permit;
      if (permit.status !== "permit")
        throw new Error("Expected delivery permit");
      const { delivery_id, attempt_id, seq, intent, sender } = permit;
      const request = { delivery_id, attempt_id, seq, intent, sender };
      expect(delivery_id).toBe(idle ? "delivery" : "eligible-steer");
      expect(
        await f.t.mutation(internal.edgeDelivery.start, {
          ...fence,
          ...request,
        }),
      ).toMatchObject({ status: "started" });
      const settled = await f.t.mutation(async (ctx) => {
        const receipt = await ctx.runMutation(internal.edgeDelivery.settle, {
          ...fence,
          ...request,
          outcome: "applied",
        });
        return {
          receipt,
          reads: (await ctx.meta.getTransactionMetrics()).documentsRead.used,
        };
      });
      expect(settled.receipt).toMatchObject({ status: "recorded" });
      expect(settled.reads).toBeLessThan(40);
      expect(await f.t.run(({ db }) => db.get(f.head))).toMatchObject({
        next_nonterminal_sequence: idle ? 2 : 1,
      });
      if (!idle) await f.send("reject-next", observed);
      const rejected = await f.t.mutation(async (ctx) => {
        const row = await ctx.db
          .query("pending_messages")
          .withIndex("by_conversation_client_id", (q) =>
            q
              .eq("conversation_id", f.conversation)
              .eq("client_id", idle ? "seed-1" : "reject-next"),
          )
          .unique();
        if (!row || !row.delivery_id || !row.conversation_sequence)
          throw new Error("Expected next eligible delivery");
        const result = await rejectHeadDeliveryInDb(ctx, f.owner, {
          conversationId: f.conversation,
          messageId: row._id,
          deliveryId: row.delivery_id,
          conversationSequence: row.conversation_sequence,
          executionEpoch: 1,
          reason: "rejected image",
          now: start,
          fencingToken: f.fence.fencing_token,
        });
        return {
          result,
          reads: (await ctx.meta.getTransactionMetrics()).documentsRead.used,
        };
      });
      expect(rejected.result).toEqual({ rejected: true });
      expect(rejected.reads).toBeLessThan(40);
    } finally {
      if (previous === undefined) delete process.env[flag];
      else process.env[flag] = previous;
      setSystemTime();
    }
  },
);
