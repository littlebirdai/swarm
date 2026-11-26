import { expect, test } from "bun:test";
import { setupRunLease } from "../test-helpers/run-lease.testkit";
import { api, internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { ExecutionAuthorityError } from "./executionBindings";
import { deliveryRejectionCodes } from "./lib/delivery-slot.state";

const cases = [
  { code: deliveryRejectionCodes.rejected, outcome: "rejected" },
  {
    code: deliveryRejectionCodes.finalFailure,
    outcome: "failed",
    retryable: false,
  },
] as const;

function legacyIdentity(attempt: Doc<"delivery_attempts">) {
  return {
    conversation_id: attempt.conversation_id,
    message_id: attempt.message_id,
    delivery_id: attempt.delivery_id,
    attempt_id: attempt._id,
    conversation_sequence: String(attempt.conversation_sequence),
    execution_epoch: attempt.execution_epoch,
    configuration_revision: attempt.configuration_revision,
    owner_device_id: attempt.owner_device_id,
    daemon_boot_id: attempt.daemon_boot_id,
    runtime_id: attempt.runtime_id,
  };
}

test.each(cases)(
  "legacy failure cannot write a final receipt using $code",
  async ({ code }) => {
    const f = await setupRunLease();
    expect(await f.deliver()).toMatchObject({ state: "claimed" });
    const attempt = await f.t.run(({ db }) =>
      db.query("delivery_attempts").unique(),
    );
    if (!attempt) throw new Error("Expected a claimed attempt");
    const request = { permit: legacyIdentity(attempt), api_token: f.bearer };
    await f.t.mutation(api.executionBindings.startDelivery, request);
    const report = (failure_code: string) =>
      f.t.mutation(api.executionBindings.failDeliveryBeforeEffect, {
        ...request,
        failure_code,
        failure_message:
          "Socket closed before the provider received the message",
      });
    const snapshot = () =>
      f.t.run(async ({ db }) => ({
        attempt: await db.get(attempt._id),
        row: await db.get(f.message),
        head: await db.get(f.head),
      }));
    const started = await snapshot();
    const error = await report(code).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(ExecutionAuthorityError);
    expect(error).toHaveProperty("code", "RESERVED_DELIVERY_FAILURE_CODE");
    expect(await snapshot()).toEqual(started);

    const retryable = { retryable: true, deliveryId: attempt.delivery_id };
    expect(await report("DRIVER_NO_EFFECT")).toEqual(retryable);
    const requeued = await snapshot();
    expect(requeued.row).toMatchObject({
      delivery_status: "pending",
      delivery_id: attempt.delivery_id,
      conversation_sequence: attempt.conversation_sequence,
      retry_count: 1,
    });
    expect(requeued.attempt?.failure_code).toBe("DRIVER_NO_EFFECT");
    expect(requeued.head?.active_delivery_attempt_id).toBeUndefined();
    await expect(report(code)).rejects.toThrow(
      "RESERVED_DELIVERY_FAILURE_CODE",
    );
    expect(await report("DRIVER_NO_EFFECT")).toEqual(retryable);
    expect(await snapshot()).toEqual(requeued);
  },
);

test.each(cases)(
  "Edge can write and replay a genuine final receipt using $code",
  async ({ code, outcome, ...options }) => {
    const f = await setupRunLease();
    const grant = await f.claim("reserved-code-edge");
    if (grant.status !== "granted") throw new Error("Expected a lease grant");
    const run = {
      v: 1 as const,
      session: f.conversation,
      run: grant.run,
      fencing_token: grant.fencing_token,
      bearer: f.bearer,
    };
    const permit = await f.t.mutation(internal.edgeDelivery.next, run);
    if (permit.status !== "permit") throw new Error("Expected an edge permit");
    const { attempt_id, delivery_id, seq, intent, sender } = permit;
    const request = { ...run, attempt_id, delivery_id, seq, intent, sender };
    if (outcome === "failed")
      expect(
        await f.t.mutation(internal.edgeDelivery.start, request),
      ).toMatchObject({ status: "started" });
    const report = { ...request, outcome, ...options };
    expect(
      await f.t.mutation(internal.edgeDelivery.settle, report),
    ).toMatchObject({ status: "recorded" });
    expect(
      await f.t.mutation(internal.edgeDelivery.settle, report),
    ).toMatchObject({ status: "duplicate" });
    const snapshot = await f.t.run(async ({ db }) => ({
      attempt: await db.query("delivery_attempts").unique(),
      row: await db.get(f.message),
    }));
    expect(snapshot.attempt).toMatchObject({
      state: "failed-before-effect",
      failure_code: code,
    });
    expect(snapshot.row).toMatchObject({
      status: "cancelled",
      delivery_status: "rejected",
      retry_count: 0,
    });
    if (!snapshot.attempt) throw new Error("Expected the terminal attempt");
    expect(
      await f.t.mutation(api.executionBindings.failDeliveryBeforeEffect, {
        permit: legacyIdentity(snapshot.attempt),
        api_token: f.bearer,
        failure_code: "DRIVER_NO_EFFECT",
        failure_message: "Late retry",
      }),
    ).toEqual({ retryable: false, deliveryId: delivery_id, outcome });
  },
);
