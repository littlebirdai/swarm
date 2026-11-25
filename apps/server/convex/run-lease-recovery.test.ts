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
