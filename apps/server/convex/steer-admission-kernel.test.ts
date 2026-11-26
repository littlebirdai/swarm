import { afterEach, expect, setSystemTime, test } from "bun:test";
import { setupRunLease, start } from "../test-helpers/run-lease.testkit";
import { api } from "./_generated/api";

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
