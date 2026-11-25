import { afterEach, expect, setSystemTime, test } from "bun:test";
import {
  boot,
  leaseMs,
  machine,
  setupRunLease,
  start,
} from "../test-helpers/run-lease.testkit";
import { internal } from "./_generated/api";
import {
  activateExecutionSuccessorInDb,
  claimExecutionStartInDb,
  completeDeliveryInDb,
  EXECUTION_PROTOCOL_CAPABILITIES,
  publishReadyBindingInDb,
  publishRuntimeDispositionInDb,
  recordExecutionSuccessorIntentInDb,
  rejectHeadDeliveryInDb,
  requestExecutionSuccessorInDb,
  startDeliveryInDb,
} from "./executionBindings";

afterEach(() => setSystemTime());

for (const disposition of ["stopped", "quarantined"] as const) {
  for (const operation of ["reject", "successor"] as const) {
    test(`${disposition} runtime permits ${operation} after the lease ends`, async () => {
      setSystemTime(new Date(start));
      const {
        t,
        owner,
        conversation,
        head,
        message,
        claim,
        requestFence,
        deliver,
      } = await setupRunLease();
      const first = await claim("predecessor");
      if (first.status !== "granted") throw Error("Expected a grant");
      if (operation === "successor")
        expect(await deliver(first.fencing_token)).toMatchObject({
          state: "claimed",
        });
      const device = { ownerDeviceId: machine, daemonBootId: boot };
      const target = {
        ...device,
        requestedAgent: "codex" as const,
        transport: "app-server" as const,
        projectPath: "/fixture",
        protocolVersion: 1,
        requiredCapabilities: [...EXECUTION_PROTOCOL_CAPABILITIES],
      };
      expect(
        await t.run((ctx) =>
          publishRuntimeDispositionInDb(ctx, owner, {
            ...device,
            conversationId: conversation,
            epoch: 1,
            configurationRevision: 1,
            runtimeId: "runtime",
            disposition,
            reason: "runtime disposed",
            fencingToken: first.fencing_token,
            now: Date.now(),
          }),
        ),
      ).toEqual({ accepted: true });

      setSystemTime(new Date(start + leaseMs));
      expect(await claim("while-disposed")).toMatchObject({ status: "stale" });
      expect(
        await t.mutation(
          internal.edgeRunLease.renew,
          requestFence(first.fencing_token),
        ),
      ).toMatchObject({ status: "stale" });

      if (operation === "reject") {
        expect(
          await t.run((ctx) =>
            rejectHeadDeliveryInDb(ctx, owner, {
              conversationId: conversation,
              messageId: message,
              deliveryId: "delivery",
              executionEpoch: 1,
              conversationSequence: 1,
              reason: "dispose old message",
              now: Date.now(),
            }),
          ),
        ).toEqual({ rejected: true });
        expect(await t.run(({ db }) => db.get(message))).toMatchObject({
          delivery_status: "rejected",
        });
        return;
      }

      const intent = {
        conversationId: conversation,
        intentId: "first-restart",
        expectedCurrentEpoch: 1,
        kind: "restart" as const,
        policy: "cancel-unstarted" as const,
        now: Date.now(),
      };
      expect(
        await t.run((ctx) =>
          recordExecutionSuccessorIntentInDb(ctx, owner, intent),
        ),
      ).toMatchObject({ state: "pending" });
      expect(
        await t.run((ctx) =>
          requestExecutionSuccessorInDb(ctx, owner, {
            ...intent,
            target: { ...target, configurationRevision: 2 },
          }),
        ),
      ).toMatchObject({ created: true, epoch: 2 });
      expect(await t.run(({ db }) => db.get(message))).toMatchObject({
        delivery_status: "cancelled-by-supersession",
      });
      const ready = {
        ...device,
        conversationId: conversation,
        epoch: 2,
        protocolVersion: 1,
        now: Date.now(),
      };
      expect(
        await t.run((ctx) =>
          claimExecutionStartInDb(ctx, owner, {
            ...ready,
            configurationRevision: 2,
            requiredCapabilities: target.requiredCapabilities,
            proposedOperationId: "successor-operation",
          }),
        ),
      ).toMatchObject({ state: "claimed" });
      expect(
        await t.run((ctx) =>
          publishReadyBindingInDb(ctx, owner, {
            ...ready,
            requestedAgent: "codex",
            actualAgent: "codex",
            transport: "app-server",
            handle: "successor-handle",
            operationId: "successor-operation",
            runtimeId: "successor-runtime",
            appliedConfigurationRevision: 2,
            capabilities: target.requiredCapabilities,
          }),
        ),
      ).toMatchObject({ accepted: true });
      expect(
        await t.run((ctx) =>
          activateExecutionSuccessorInDb(ctx, owner, {
            conversationId: conversation,
            expectedCurrentEpoch: 1,
            successorEpoch: 2,
            currentConfigurationRevision: 1,
            currentOwnerDeviceId: machine,
            currentDaemonBootId: boot,
            currentOperationId: "operation",
            currentRuntimeId: "runtime",
            successorConfigurationRevision: 2,
            successorOwnerDeviceId: machine,
            successorDaemonBootId: boot,
            successorRuntimeId: "successor-runtime",
            now: Date.now(),
          }),
        ),
      ).toMatchObject({ activated: true, epoch: 2 });
      const second = await claim("successor");
      expect(second).toMatchObject({ status: "granted", run: 2 });

      const nextMessage = await t.run(async ({ db }) => {
        const oldMessage = await db.get(message);
        if (!oldMessage) throw Error("Expected original message");
        const { _id, _creationTime, ...pending } = oldMessage;
        await db.patch(head, {
          next_conversation_sequence: 3,
          next_nonterminal_sequence: 2,
        });
        return db.insert("pending_messages", {
          ...pending,
          execution_epoch: 2,
          conversation_sequence: 2,
          status: "pending",
          delivery_status: "pending",
          delivery_id: "fresh",
          client_id: "fresh",
        });
      });
      const nextIntent = {
        ...intent,
        expectedCurrentEpoch: 2,
        intentId: "second-restart",
      };
      await t.run((ctx) =>
        recordExecutionSuccessorIntentInDb(ctx, owner, nextIntent),
      );
      await expect(
        t.run((ctx) =>
          requestExecutionSuccessorInDb(ctx, owner, {
            ...nextIntent,
            target: { ...target, configurationRevision: 3 },
            fencingToken: first.fencing_token,
          }),
        ),
      ).rejects.toThrow("STALE_RUN_LEASE");
      await expect(
        t.run((ctx) =>
          rejectHeadDeliveryInDb(ctx, owner, {
            conversationId: conversation,
            messageId: nextMessage,
            deliveryId: "fresh",
            executionEpoch: 2,
            conversationSequence: 2,
            reason: "stale rejection",
            fencingToken: first.fencing_token,
            now: Date.now(),
          }),
        ),
      ).rejects.toThrow("STALE_RUN_LEASE");
      expect(await t.run(({ db }) => db.get(head))).not.toHaveProperty(
        "pending_epoch",
      );
      expect(await t.run(({ db }) => db.get(nextMessage))).toMatchObject({
        delivery_status: "pending",
      });
    });
  }
}

test("delivery admission and settlement use the caller's time at the expiry boundary", async () => {
  setSystemTime(new Date(start));
  const { t, owner, conversation, claim, deliver } = await setupRunLease();
  const grant = await claim("clock");
  if (grant.status !== "granted") throw Error("Expected a grant");
  const cutoff = start + leaseMs;
  await expect(deliver(grant.fencing_token, cutoff)).rejects.toThrow(
    "STALE_RUN_LEASE",
  );
  setSystemTime(new Date(cutoff));
  const { permit } = await deliver(grant.fencing_token, cutoff - 1);
  const fence = {
    ...permit,
    conversationId: conversation,
    conversationSequence: Number(permit.conversationSequence),
    fencingToken: grant.fencing_token,
    now: cutoff - 1,
  };
  expect(
    await t.run((ctx) => startDeliveryInDb(ctx, owner, fence)),
  ).toMatchObject({
    state: "delivery-started",
  });
  expect(await t.run((ctx) => completeDeliveryInDb(ctx, owner, fence))).toEqual(
    { accepted: true },
  );
});

for (const window of [
  "disposed",
  "intent recorded",
  "pending ready",
  "activated without a claim",
] as const) {
  for (const tokenState of ["live", "expired", "released"] as const) {
    test(`${window} refuses a presented ${tokenState} predecessor token`, async () => {
      setSystemTime(new Date(start));
      const {
        t,
        owner,
        conversation,
        head,
        binding,
        message,
        claim,
        requestFence,
      } = await setupRunLease();
      const released = await claim("released");
      if (released.status !== "granted") throw Error("Expected a lease");
      await t.mutation(
        internal.edgeRunLease.release,
        requestFence(released.fencing_token),
      );
      const expired = await claim("expired");
      if (expired.status !== "granted") throw Error("Expected a lease");
      setSystemTime(new Date(start + leaseMs));
      const live = await claim("live");
      if (live.status !== "granted") throw Error("Expected a lease");

      const now = Date.now();
      const dispose = {
        conversationId: conversation,
        epoch: 1,
        configurationRevision: 1,
        ownerDeviceId: machine,
        daemonBootId: boot,
        runtimeId: "runtime",
        disposition: "stopped" as const,
        reason: "runtime disposed",
        fencingToken: live.fencing_token,
        now,
      };
      expect(
        await t.run((ctx) =>
          publishRuntimeDispositionInDb(ctx, owner, dispose),
        ),
      ).toEqual({ accepted: true });
      const disposed = await t.run(({ db }) => db.get(binding));
      expect(
        await t.run((ctx) =>
          publishRuntimeDispositionInDb(ctx, owner, {
            ...dispose,
            now: now + 1,
          }),
        ),
      ).toEqual({ accepted: true });
      expect(await t.run(({ db }) => db.get(binding))).toEqual(disposed);

      if (window !== "disposed") {
        await t.run((ctx) =>
          recordExecutionSuccessorIntentInDb(ctx, owner, {
            conversationId: conversation,
            intentId: "next",
            expectedCurrentEpoch: 1,
            kind: "restart",
            policy: "drain-current",
            now,
          }),
        );
      }
      if (
        window === "pending ready" ||
        window === "activated without a claim"
      ) {
        await t.run(async ({ db }) => {
          const prior = await db.get(binding);
          if (!prior) throw Error("Expected the original binding");
          const { _id, _creationTime, claim_id, ...successor } = prior;
          await db.insert("execution_bindings", {
            ...successor,
            epoch: 2,
            state: "ready",
            runtime_id: "next-runtime",
          });
          if (window === "pending ready") {
            await db.patch(head, { pending_epoch: 2, admission_epoch: 2 });
          } else {
            await db.patch(head, { current_epoch: 2, admission_epoch: 2 });
            await db.patch(message, { execution_epoch: 2 });
          }
        });
      }

      const reject = (fencingToken?: string) =>
        t.run((ctx) =>
          rejectHeadDeliveryInDb(ctx, owner, {
            conversationId: conversation,
            messageId: message,
            deliveryId: "delivery",
            executionEpoch: window === "activated without a claim" ? 2 : 1,
            conversationSequence: 1,
            reason: "explicit rejection",
            fencingToken,
            now,
          }),
        );
      await expect(
        reject({ live, expired, released }[tokenState].fencing_token),
      ).rejects.toThrow("STALE_RUN_LEASE");
      expect(await t.run(({ db }) => db.get(message))).toMatchObject({
        delivery_status: "pending",
      });
      expect(await reject()).toEqual({ rejected: true });
    });
  }
}

test("only the current epoch may reject the queue head", async () => {
  setSystemTime(new Date(start));
  const { t, owner, conversation, head, message, claim } =
    await setupRunLease();
  const current = await claim("current");
  if (current.status !== "granted") throw Error("Expected a lease");
  await t.run(async ({ db }) => {
    await db.patch(head, { pending_epoch: 2, admission_epoch: 2 });
    await db.patch(message, { execution_epoch: 2 });
  });
  await expect(
    t.run((ctx) =>
      rejectHeadDeliveryInDb(ctx, owner, {
        conversationId: conversation,
        messageId: message,
        deliveryId: "delivery",
        executionEpoch: 2,
        conversationSequence: 1,
        reason: "future queue rejection",
        fencingToken: current.fencing_token,
        now: start,
      }),
    ),
  ).rejects.toThrow("EXECUTION_EPOCH_FENCE_MISMATCH");
  expect(await t.run(({ db }) => db.get(message))).toMatchObject({
    delivery_status: "pending",
  });
});

for (const operation of ["successor proposal", "head rejection"] as const) {
  test(`${operation} uses the caller's time at the expiry boundary`, async () => {
    setSystemTime(new Date(start));
    const { t, owner, conversation, message, claim } = await setupRunLease();
    const grant = await claim("clock");
    if (grant.status !== "granted") throw Error("Expected a lease");
    const intent = {
      conversationId: conversation,
      intentId: "restart",
      expectedCurrentEpoch: 1,
      kind: "restart" as const,
      policy: "cancel-unstarted" as const,
    };
    if (operation === "successor proposal") {
      await t.run((ctx) =>
        recordExecutionSuccessorIntentInDb(ctx, owner, {
          ...intent,
          now: start,
        }),
      );
    }
    const apply = (now: number) =>
      t.run(async (ctx): Promise<unknown> => {
        const fencingToken = grant.fencing_token;
        return operation === "successor proposal"
          ? requestExecutionSuccessorInDb(ctx, owner, {
              ...intent,
              fencingToken,
              now,
              target: {
                requestedAgent: "codex",
                transport: "app-server",
                projectPath: "/fixture",
                configurationRevision: 2,
                ownerDeviceId: machine,
                daemonBootId: boot,
                protocolVersion: 1,
                requiredCapabilities: [...EXECUTION_PROTOCOL_CAPABILITIES],
              },
            })
          : rejectHeadDeliveryInDb(ctx, owner, {
              conversationId: conversation,
              messageId: message,
              deliveryId: "delivery",
              executionEpoch: 1,
              conversationSequence: 1,
              reason: "explicit rejection",
              fencingToken,
              now,
            });
      });
    const cutoff = start + leaseMs;
    await expect(apply(cutoff)).rejects.toThrow("STALE_RUN_LEASE");
    setSystemTime(new Date(cutoff));
    expect(await apply(cutoff - 1)).toMatchObject(
      operation === "successor proposal"
        ? { created: true }
        : { rejected: true },
    );
  });
}

test("head rejection refuses a presented token when the binding is missing", async () => {
  setSystemTime(new Date(start));
  const { t, owner, conversation, binding, message, claim } =
    await setupRunLease();
  const grant = await claim("missing");
  if (grant.status !== "granted") throw Error("Expected a lease");
  await t.run(({ db }) => db.delete(binding));
  await expect(
    t.run((ctx) =>
      rejectHeadDeliveryInDb(ctx, owner, {
        conversationId: conversation,
        messageId: message,
        deliveryId: "delivery",
        executionEpoch: 1,
        conversationSequence: 1,
        reason: "explicit rejection",
        fencingToken: grant.fencing_token,
        now: start,
      }),
    ),
  ).rejects.toThrow("STALE_RUN_LEASE");
});
