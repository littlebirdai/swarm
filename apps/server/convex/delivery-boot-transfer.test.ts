import { afterEach, expect, setSystemTime, test } from "bun:test";
import {
  boot,
  machine,
  setupRunLease,
  start,
} from "../test-helpers/run-lease.testkit";
import { api } from "./_generated/api";
import {
  claimNextDeliveryInDb,
  completeDeliveryInDb,
  EXECUTION_PROTOCOL_CAPABILITIES,
  markDeliveryAmbiguousInDb,
  resolveAmbiguousDeliveryInDb,
  startDeliveryInDb,
} from "./executionBindings";

afterEach(() => setSystemTime());

for (const state of ["claimed", "delivery-started", "ambiguous"] as const) {
  for (const leased of [false, true]) {
    for (const alreadyTransferred of [false, true]) {
      test(`${state} recovers on boot transfer (${leased ? "leased" : "legacy"}${alreadyTransferred ? ", previously stranded" : ""})`, async () => {
        setSystemTime(new Date(start));
        const {
          t,
          bearer,
          owner,
          conversation,
          binding,
          head,
          message,
          claim,
          deliver,
        } = await setupRunLease();
        const first = leased ? await claim("old-lease") : undefined;
        if (first && first.status !== "granted")
          throw Error("Expected old lease");
        const { permit } = await deliver(first?.fencing_token);
        const original = {
          ...permit,
          conversationId: conversation,
          conversationSequence: Number(permit.conversationSequence),
          fencingToken: first?.fencing_token,
          now: start,
        };
        if (state !== "claimed") {
          await t.run((ctx) => startDeliveryInDb(ctx, owner, original));
        }
        if (state === "ambiguous") {
          await t.run((ctx) =>
            markDeliveryAmbiguousInDb(ctx, owner, {
              ...original,
              failureCode: "uncertain",
              failureMessage: "unknown outcome",
            }),
          );
        }

        if (alreadyTransferred) {
          await t.run(({ db }) =>
            db.patch(binding, { daemon_boot_id: "intermediate-boot" }),
          );
        }
        const now = start + 1;
        setSystemTime(new Date(now));
        const replacementBoot = "replacement";
        const device = {
          owner_device_id: machine,
          daemon_boot_id: replacementBoot,
          api_token: bearer,
        };
        await t.mutation(
          api.executionBindings.registerExecutionDaemonBoot,
          device,
        );
        const adopt = (daemon_boot_id: string) =>
          t.mutation(api.executionBindings.claimExecutionStart, {
            ...device,
            daemon_boot_id,
            conversation_id: conversation,
            epoch: 1,
            configuration_revision: 1,
            protocol_version: 1,
            required_capabilities: [...EXECUTION_PROTOCOL_CAPABILITIES],
            proposed_operation_id: "operation",
          });
        expect(await adopt(replacementBoot)).toMatchObject({
          state: "ready",
          binding: { daemonBootId: replacementBoot },
        });
        const claimDelivery = (fencingToken?: string) =>
          t.run((ctx) =>
            claimNextDeliveryInDb(ctx, owner, {
              ...original,
              daemonBootId: replacementBoot,
              fencingToken,
              now,
            }),
          );
        if (first) {
          await expect(claimDelivery()).rejects.toThrow("STALE_RUN_LEASE");
          await expect(claimDelivery(first.fencing_token)).rejects.toThrow(
            "STALE_RUN_LEASE",
          );
        }
        const second = leased
          ? await claim("new-lease", { boot: replacementBoot })
          : undefined;
        if (second && second.status !== "granted")
          throw Error("Expected new lease");

        expect(await adopt(boot)).toMatchObject({ state: "rejected" });
        const replacement = {
          ...original,
          daemonBootId: replacementBoot,
          fencingToken: second?.fencing_token,
          now,
        };
        const late = { ...replacement, daemonBootId: boot };
        const readSlot = () =>
          t.run(async ({ db }) => ({
            attempt: await db.get("delivery_attempts", original.attemptId),
            message: await db.get(message),
            head: await db.get(head),
          }));
        const next = () => claimDelivery(second?.fencing_token);
        const resolve = (
          fence: typeof replacement,
          resolutionEvidence = "matching receipt",
        ) =>
          t.run((ctx) =>
            resolveAmbiguousDeliveryInDb(ctx, owner, {
              ...fence,
              resolution: "correlated-delivered",
              resolutionEvidence,
            }),
          );

        const slot = await readSlot();
        if (state === "claimed") {
          expect(slot).toMatchObject({
            attempt: { state: "failed-before-effect", completed_at: now },
            message: {
              delivery_status: "pending",
              retry_count: 1,
              conversation_sequence: 1,
            },
            head: { next_nonterminal_sequence: 1 },
          });
          expect(slot.message?.active_delivery_attempt_id).toBeUndefined();
          expect(slot.head?.active_delivery_attempt_id).toBeUndefined();
          expect(slot.head?.active_delivery_state).toBeUndefined();
          await expect(
            t.run((ctx) => startDeliveryInDb(ctx, owner, late)),
          ).rejects.toThrow("DELIVERY_BINDING_FENCE_MISMATCH");
          expect(await readSlot()).toEqual(slot);
          const retry = await next();
          expect(retry).toMatchObject({
            state: "claimed",
            permit: {
              daemonBootId: replacementBoot,
              messageId: original.messageId,
              deliveryId: original.deliveryId,
              conversationSequence: permit.conversationSequence,
            },
          });
          expect(retry.permit.attemptId).not.toBe(original.attemptId);
          expect(await next()).toMatchObject({
            recovered: true,
            permit: { attemptId: retry.permit.attemptId },
          });
        } else {
          expect(slot).toMatchObject({
            attempt: {
              state: "ambiguous",
              daemon_boot_id: replacementBoot,
              delivery_started_at: start,
              ...(state === "ambiguous"
                ? {
                    failure_code: "uncertain",
                    failure_message: "unknown outcome",
                  }
                : {}),
            },
            message: {
              delivery_status: "ambiguous",
              active_delivery_attempt_id: original.attemptId,
              retry_count: 0,
            },
            head: {
              active_delivery_state: "ambiguous",
              active_delivery_attempt_id: original.attemptId,
              next_nonterminal_sequence: 1,
            },
          });
          expect(slot.attempt?.completed_at).toBeUndefined();
          await expect(resolve(late)).rejects.toThrow(
            "DELIVERY_BINDING_FENCE_MISMATCH",
          );
          await expect(
            t.run((ctx) => completeDeliveryInDb(ctx, owner, late)),
          ).rejects.toThrow("DELIVERY_BINDING_FENCE_MISMATCH");
          await expect(
            t.run((ctx) => startDeliveryInDb(ctx, owner, replacement)),
          ).rejects.toThrow("DELIVERY_ATTEMPT_STATE_MISMATCH");
          await expect(resolve(replacement, "")).rejects.toThrow(
            "resolutionEvidence",
          );
          if (first) {
            await expect(
              resolve({ ...replacement, fencingToken: first.fencing_token }),
            ).rejects.toThrow("STALE_RUN_LEASE");
          }
          expect(await next()).toMatchObject({
            state: "busy",
            attemptId: original.attemptId,
            activeState: "ambiguous",
          });
          expect(await readSlot()).toEqual(slot);
          expect(await resolve(replacement)).toEqual({
            state: "correlated-delivered",
          });
          expect(await readSlot()).toMatchObject({
            attempt: { state: "correlated-delivered" },
            message: { delivery_status: "correlated-delivered" },
            head: { next_nonterminal_sequence: 2 },
          });
          expect(await next()).toEqual({ state: "empty" });
        }
      });
    }
  }
}

test("adopting a pending binding leaves the current delivery slot intact", async () => {
  setSystemTime(new Date(start));
  const { t, bearer, conversation, binding, head, deliver } =
    await setupRunLease();
  const { permit } = await deliver();
  await t.run(async ({ db }) => {
    const ready = await db.get(binding);
    if (!ready) throw Error("Expected current binding");
    const { _id, _creationTime, ...fields } = ready;
    await db.insert("execution_bindings", {
      ...fields,
      epoch: 2,
      configuration_revision: 2,
      applied_configuration_revision: 2,
      runtime_id: "successor-runtime",
    });
    await db.patch(head, { pending_epoch: 2, admission_epoch: 2 });
  });
  const device = {
    owner_device_id: machine,
    daemon_boot_id: "replacement",
    api_token: bearer,
  };
  await t.mutation(api.executionBindings.registerExecutionDaemonBoot, device);
  expect(
    await t.mutation(api.executionBindings.claimExecutionStart, {
      ...device,
      conversation_id: conversation,
      epoch: 2,
      configuration_revision: 2,
      protocol_version: 1,
      required_capabilities: [...EXECUTION_PROTOCOL_CAPABILITIES],
      proposed_operation_id: "operation",
    }),
  ).toMatchObject({ state: "ready", binding: { daemonBootId: "replacement" } });
  expect(await deliver()).toMatchObject({
    recovered: true,
    permit: { attemptId: permit.attemptId, daemonBootId: boot },
  });
});
