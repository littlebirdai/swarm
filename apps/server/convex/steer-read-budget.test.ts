import { expect, setSystemTime, test } from "bun:test";
import { asUser } from "../test-helpers/database.testkit";
import { boot, machine, start } from "../test-helpers/run-lease.testkit";
import {
  observed,
  steerDeliveryFixture,
} from "../test-helpers/steer-delivery.testkit";
import { api } from "./_generated/api";
import { claimNextDeliveryInDb } from "./executionBindings";

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
