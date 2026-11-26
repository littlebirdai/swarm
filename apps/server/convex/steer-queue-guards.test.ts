import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { asUser } from "../test-helpers/database.testkit";
import { boot, machine, start } from "../test-helpers/run-lease.testkit";
import {
  observed,
  steerDeliveryFixture as fixture,
} from "../test-helpers/steer-delivery.testkit";
import { api, internal } from "./_generated/api";

const flag = "SWARM_TURN_BATON";
const previous = process.env[flag];

beforeEach(() => {
  process.env[flag] = "1";
  setSystemTime(new Date(start));
});

afterEach(() => {
  if (previous === undefined) delete process.env[flag];
  else process.env[flag] = previous;
  setSystemTime();
});

test.each(["flag off", "capability dropped"] as const)(
  "drain-current sweeps stale steers in bounded batches when %s",
  async (mode) => {
    const f = await fixture();
    await f.send("old-steer", observed);
    await f.t.run(async ({ db }) => {
      const original = await db
        .query("pending_messages")
        .withIndex("by_conversation_client_id", (q) =>
          q.eq("conversation_id", f.conversation).eq("client_id", "old-steer"),
        )
        .unique();
      if (!original) throw new Error("Expected admitted steer");
      const { _id, _creationTime, ...base } = original;
      for (let index = 0; index < 64; index++) {
        const id = `old-steer-${index}`;
        await db.insert("pending_messages", {
          ...base,
          client_id: id,
          delivery_id: id,
          conversation_sequence: 3 + index,
        });
      }
      await db.patch(f.message, {
        delivery_status: "delivered",
        status: "delivered",
      });
      await db.patch(f.head, {
        pending_policy: "drain-current",
        next_nonterminal_sequence: 2,
        next_conversation_sequence: 67,
      });
      if (mode === "capability dropped") {
        const binding = (await db.get(f.binding))!;
        await db.patch(f.binding, {
          capabilities: binding.required_capabilities,
        });
      }
    });
    if (mode === "flag off") delete process.env[flag];

    const stop = (fencing_token: string) =>
      f.t.mutation(api.executionBindings.publishRuntimeDisposition, {
        api_token: f.bearer,
        conversation_id: f.conversation,
        epoch: 1,
        configuration_revision: 1,
        owner_device_id: machine,
        daemon_boot_id: boot,
        runtime_id: "runtime",
        reason: "drain",
        disposition: "stopped",
        fencing_token,
      });
    await expect(stop("wrong-token")).rejects.toThrow("STALE_RUN_LEASE");
    expect(
      (await f.rows()).messages.filter(
        (row) => row.delivery_status === "rejected",
      ),
    ).toHaveLength(0);
    expect(await stop(f.fence.fencing_token)).toEqual({ accepted: false });
    const partial = await f.rows();
    expect(
      partial.messages.filter((row) => row.delivery_status === "rejected"),
    ).toHaveLength(64);
    expect(partial.head?.next_nonterminal_sequence).toBe(66);
    expect(await stop(f.fence.fencing_token)).toEqual({ accepted: true });
    expect((await f.rows()).messages[65]).toMatchObject({
      delivery_status: "rejected",
      delivery_disposition_reason: "stale-turn",
    });
  },
);

test("fenced queue rows cannot be merged or reordered", async () => {
  const f = await fixture();
  const user = asUser(f.t, f.owner);
  for (const id of ["held-a", "held-b"])
    await user.mutation(api.dispatch.dispatch, {
      action: "queueMessage",
      args: [f.conversation, id, id],
    });
  const [, a, b] = (await f.rows()).messages.map((row) => row._id);
  if (!a || !b) throw new Error("Expected two fenced waiting rows");
  const legacy = await f.t.run(({ db }) =>
    db.insert("pending_messages", {
      conversation_id: f.conversation,
      from_user_id: f.owner,
      content: "legacy",
      retry_count: 0,
      created_at: start,
      status: "held",
      queued: true,
    }),
  );
  const before = await f.rows();
  expect(before.messages.slice(-2)).toMatchObject([
    { status: "held", queued: true, delivery_status: "pending" },
    { status: "held", queued: true, delivery_status: "pending" },
  ]);
  expect(
    await user.mutation(api.pendingMessages.mergeQueued, {
      conversation_id: f.conversation,
      message_id: a,
      into_id: b,
    }),
  ).toBe("not_waiting");
  expect(
    await user.mutation(api.pendingMessages.reorderQueued, {
      conversation_id: f.conversation,
      message_id: b,
      before_id: a,
    }),
  ).toBe("not_waiting");
  expect(
    await user.mutation(api.pendingMessages.reorderQueued, {
      conversation_id: f.conversation,
      message_id: b,
      before_id: null,
    }),
  ).toBe("not_waiting");
  expect(
    await user.mutation(api.pendingMessages.reorderQueued, {
      conversation_id: f.conversation,
      message_id: legacy,
      before_id: a,
    }),
  ).toBe("not_waiting");
  expect(await f.rows()).toEqual(before);
});

test("idle selection merges legacy and explicit queue heads after a full steer sweep", async () => {
  const f = await fixture();
  await f.send("stale-steer", observed);
  await f.send("explicit-queue", undefined);
  await f.turn(null);
  await f.t.run(async ({ db }) => {
    const conversations = await db
      .query("pending_messages")
      .withIndex("by_conversation_sequence", (q) =>
        q.eq("conversation_id", f.conversation),
      )
      .collect();
    const [, steer, queue] = conversations;
    if (!steer || !queue)
      throw new Error("Expected a steer and an explicit queue");
    const { _id, _creationTime, ...source } = steer;
    await db.patch(f.message, { conversation_sequence: 66 });
    await db.patch(queue._id, { conversation_sequence: 67 });
    await db.patch(steer._id, { conversation_sequence: 1 });
    for (let sequence = 2; sequence <= 65; sequence++) {
      const id = `stale-${sequence}`;
      await db.insert("pending_messages", {
        ...source,
        client_id: id,
        delivery_id: id,
        conversation_sequence: sequence,
      });
    }
    await db.patch(f.head, { next_conversation_sequence: 68 });
  });
  const wire = await f.t.mutation(internal.edgeDelivery.next, {
    ...f.fence,
    v: 1,
    bearer: f.bearer,
  });
  expect(wire).toMatchObject({
    status: "permit",
    intent: "queue",
    seq: 66,
    delivery_id: "delivery",
  });
  const rows = await f.rows();
  expect(
    rows.messages.filter((row) => row.delivery_status === "rejected"),
  ).toHaveLength(64);
  expect(rows.head?.next_nonterminal_sequence).toBe(65);
});
