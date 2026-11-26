import { afterEach, expect, setSystemTime, test } from "bun:test";
import {
  boot,
  machine,
  setupRunLease,
  start,
} from "../test-helpers/run-lease.testkit";
import {
  observed,
  steerDeliveryFixture,
} from "../test-helpers/steer-delivery.testkit";
import { api, internal } from "./_generated/api";

const flag = "SWARM_TURN_BATON";
const originalFlag = process.env[flag];

afterEach(() => {
  if (originalFlag === undefined) delete process.env[flag];
  else process.env[flag] = originalFlag;
  setSystemTime();
});

test.each([false, true])(
  "a risk resend keeps its queue position and records intent only with the baton flag (%p)",
  async (enabled) => {
    if (enabled) process.env[flag] = "1";
    else delete process.env[flag];
    setSystemTime(new Date(start));
    const fixture = await setupRunLease();
    const { t, bearer, conversation, message, head } = fixture;
    const original = await fixture.deliver();
    expect(original.state).toBe("claimed");
    const permit = {
      conversation_id: conversation,
      message_id: message,
      delivery_id: original.permit.deliveryId,
      attempt_id: original.permit.attemptId,
      conversation_sequence: original.permit.conversationSequence,
      execution_epoch: original.permit.executionEpoch,
      configuration_revision: original.permit.configurationRevision,
      owner_device_id: original.permit.ownerDeviceId,
      daemon_boot_id: original.permit.daemonBootId,
      runtime_id: original.permit.runtimeId,
    };
    await t.mutation(api.executionBindings.startDelivery, {
      permit,
      api_token: bearer,
    });
    await t.mutation(api.executionBindings.markDeliveryAmbiguous, {
      permit,
      api_token: bearer,
      failure_code: "IN_DOUBT",
      failure_message: "No receipt",
    });
    const request = {
      permit,
      api_token: bearer,
      new_client_id: "explicit-resend",
      resolution_evidence: "Owner accepted resend risk",
    };
    const resent = await t.mutation(
      api.executionBindings.abandonAmbiguousAndResend,
      request,
    );
    const rows = () =>
      t.run(async (ctx) => ({
        messages: await ctx.db
          .query("pending_messages")
          .withIndex("by_conversation_sequence", (q) =>
            q.eq("conversation_id", conversation),
          )
          .collect(),
        head: await ctx.db.get(head),
      }));
    const snapshot = await rows();
    expect(resent).toMatchObject({
      originalDeliveryId: "delivery",
      deliveryId: "explicit-resend",
      conversationSequence: "2",
      executionEpoch: 1,
    });
    expect(
      snapshot.messages.map((row) => [
        row.delivery_id,
        row.conversation_sequence,
        row.delivery_status,
        row.delivery_intent,
      ]),
    ).toEqual([
      ["delivery", 1, "abandoned-ambiguous", undefined],
      ["explicit-resend", 2, "pending", enabled ? "queue" : undefined],
    ]);
    expect(snapshot.head?.next_nonterminal_sequence).toBe(2);
    expect(snapshot.head?.active_delivery_attempt_id).toBeUndefined();

    if (enabled) delete process.env[flag];
    else process.env[flag] = "1";
    expect(
      await t.mutation(
        api.executionBindings.abandonAmbiguousAndResend,
        request,
      ),
    ).toEqual(resent);
    expect(await rows()).toEqual(snapshot);
  },
);

test("a leased ambiguous steer can be resent only with its run fence", async () => {
  process.env[flag] = "1";
  setSystemTime(new Date(start));
  const f = await steerDeliveryFixture();
  await f.send("ambiguous-steer", observed);
  const edge = { ...f.fence, v: 1 as const, bearer: f.bearer };
  const selected = await f.t.mutation(internal.edgeDelivery.next, edge);
  if (selected.status !== "permit") throw new Error("Expected steer permit");
  const { delivery_id, attempt_id, seq, intent, sender } = selected;
  expect(intent).toBe("steer");
  const attempt = { delivery_id, attempt_id, seq, intent, sender };
  expect(
    await f.t.mutation(internal.edgeDelivery.start, { ...edge, ...attempt }),
  ).toMatchObject({ status: "started" });
  expect(
    await f.t.mutation(internal.edgeDelivery.settle, {
      ...edge,
      ...attempt,
      outcome: "in_doubt",
    }),
  ).toMatchObject({ status: "recorded" });
  const before = await f.rows();
  const message = before.messages.find(
    (row) => row.delivery_id === delivery_id,
  );
  if (!message) throw new Error("Expected steer message");
  const request = {
    permit: {
      conversation_id: f.conversation,
      message_id: message._id,
      delivery_id,
      attempt_id,
      conversation_sequence: String(seq),
      execution_epoch: 1,
      configuration_revision: 1,
      owner_device_id: machine,
      daemon_boot_id: boot,
      runtime_id: "runtime",
    },
    api_token: f.bearer,
    new_client_id: "leased-resend",
    resolution_evidence: "Owner accepted resend risk",
  };
  const resend = api.executionBindings.abandonAmbiguousAndResend;
  await expect(f.t.mutation(resend, request)).rejects.toThrow(
    "STALE_RUN_LEASE",
  );
  await expect(
    f.t.mutation(resend, { ...request, fencing_token: "wrong-lease" }),
  ).rejects.toThrow("STALE_RUN_LEASE");
  expect(await f.rows()).toEqual(before);

  const authorized = { ...request, fencing_token: edge.fencing_token };
  const result = await f.t.mutation(resend, authorized);
  expect(result).toMatchObject({
    originalDeliveryId: delivery_id,
    deliveryId: "leased-resend",
    conversationSequence: "3",
  });
  const after = await f.rows();
  expect(
    after.messages.find((row) => row._id === message._id)?.delivery_status,
  ).toBe("abandoned-ambiguous");
  expect(
    after.messages.find((row) => row._id === result.messageId),
  ).toMatchObject({
    delivery_status: "pending",
    delivery_intent: "queue",
    resend_of_delivery_id: delivery_id,
  });
  expect(after.head?.active_delivery_attempt_id).toBeUndefined();
  expect(await f.t.mutation(resend, authorized)).toEqual(result);
  expect(await f.rows()).toEqual(after);
});
