import { expect, test } from "bun:test";
import type { ReadyBinding } from "@codecast/agent-clients/executionBinding";
import type { ClaimGrant } from "@codecast/edge-client";
import type {
  DeliveryReceiptJournal,
  OwnedSession,
} from "@codecast/provider-contract";
import { until } from "../../../../tests/codex-driver-parity/peers.js";
import { strictStub } from "../test-helpers/strictStub.js";
import { bindingFor, fixture } from "./codex-owned-pilot-fixture.js";
import {
  CodexPilotDelivery,
  CodexPilotLeaseLost,
} from "./codex-pilot-delivery.js";
import { makeOwnedProviderBridge } from "./codex-pilot-provider-bridge.js";
import { InMemoryExecutionOperationJournal } from "./local-journal.js";

const claim: ClaimGrant = {
  v: 1,
  status: "granted",
  session: "pilot",
  run: 1,
  fencing_token: "edge-lease",
  lease_ms: 60_000,
  last_pane_instance: 0,
};

const receipt = {
  delivery_id: "delivery-1",
  provider_item_id: "provider-item-1",
  turn: "actual-turn-1",
};

function abortAwareJournal(): DeliveryReceiptJournal {
  const journal = new InMemoryExecutionOperationJournal().deliveryReceipts;
  return {
    ...journal,
    async find(session, checkpoint, deliveryId, signal) {
      signal.throwIfAborted();
      return journal.find(session, checkpoint, deliveryId, signal);
    },
  };
}

function setup() {
  const f = fixture("pilot", "receipt");
  const binding = bindingFor(f.pilotRequest, true);
  const journal = abortAwareJournal();
  const delivery = new CodexPilotDelivery(
    (op, body, abort) =>
      fetch(`https://pilot.invalid/edge/v1/${op}`, {
        method: "POST",
        body: JSON.stringify(body),
        signal: abort,
      }),
    (message) => f.logs.push(message),
  );
  delivery.receiptJournal = journal;
  const record = () =>
    journal.record(
      "pilot",
      f.deliveryThread,
      receipt,
      new AbortController().signal,
    );
  const holdAmbiguous = () =>
    f.runtime.coordinator.runDeliveryOperation({
      identity: {
        conversationId: "pilot",
        runtimeId: binding.runtimeId,
        attemptId: "attempt-1",
        deliveryId: "delivery-1",
      },
      signature: JSON.stringify({ attemptId: "attempt-1" }),
      effect: async () => ({
        state: "ambiguous",
        failure: { code: "EDGE_DELIVERY_IN_DOUBT", message: "in doubt" },
      }),
      settle: async () => {},
    });
  const drain = (session: OwnedSession, signal: AbortSignal) =>
    delivery.drain(
      binding,
      f.runtime.coordinator,
      session,
      claim,
      async (text) => text,
      signal,
      true,
    );
  return { f, delivery, record, holdAmbiguous, drain };
}

const idleSession = (checkpoint: string) =>
  strictStub<OwnedSession>("owned provider", {
    getCheckpoint: () => checkpoint,
  });

test("closing during a delivery step keeps the session until the step settles", async () => {
  const { f, delivery, record, drain } = setup();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const controller = new AbortController();
  const session = strictStub<OwnedSession>("owned provider", {
    getCheckpoint: () => f.deliveryThread,
    async steer() {
      entered.resolve();
      await release.promise;
      await record();
      return { status: "duplicate", receipt: { delivery_id: "delivery-1" } };
    },
  });
  try {
    f.enqueue(1);
    const draining = drain(session, controller.signal);
    await entered.promise;
    controller.abort();
    const closing = delivery.clearImages();
    release.resolve();
    await closing;
    await draining.catch(() => {});
    expect(
      f.settlements.map(({ delivery_id, outcome }) => [delivery_id, outcome]),
    ).toEqual([["delivery-1", "applied"]]);
  } finally {
    release.resolve();
    await delivery.clearImages();
    await f.dispose();
  }
});

test("a provider call cancelled while it runs still reads its receipt", async () => {
  const journal = abortAwareJournal();
  const controller = new AbortController();
  const checkpoint = "thread-1";
  const bridge = makeOwnedProviderBridge({
    context: () => ({
      binding: strictStub<ReadyBinding>("ready binding", { capabilities: [] }),
      session: strictStub<OwnedSession>("owned provider", {
        async steer() {
          controller.abort();
          await journal.record(
            "pilot",
            checkpoint,
            receipt,
            new AbortController().signal,
          );
          return {
            status: "duplicate",
            receipt: { delivery_id: "delivery-1" },
          };
        },
      }),
    }),
    receipts: {
      find: (session, deliveryId, signal) =>
        journal.find(session, checkpoint, deliveryId, signal),
      record: async () => {},
      forget: async () => {},
    },
    hasAppendedReceipt: () => false,
    setPendingStarter: () => {},
  });
  const outcome = await bridge.deliver(
    {
      kind: "provider.deliver",
      request_id: "request-1",
      session: "pilot",
      run: 1,
      fencing_token: "edge-lease",
      delivery_id: "delivery-1",
      attempt_id: "attempt-1",
      seq: 1,
      intent: "queue",
      sender: { kind: "person", id: "owner" },
      input: [{ type: "text", text: "hello" }],
    },
    controller.signal,
  );
  expect(outcome).toEqual({ status: "duplicate", receipt });
});

test("closing while the delivery service starts leaves no disposed service behind", async () => {
  const { f, delivery, drain } = setup();
  const session = idleSession(f.deliveryThread);
  try {
    const first = drain(session, new AbortController().signal);
    const closing = delivery.clearImages();
    await closing;
    await first.catch(() => {});
    const second = await Promise.race([
      drain(session, new AbortController().signal),
      Bun.sleep(2_000).then(() => "timed out" as const),
    ]);
    expect(second).toBe(true);
  } finally {
    await delivery.clearImages();
    await f.dispose();
  }
});

test("a restarted pilot settles a held delivery from its journal receipt", async () => {
  const { f, delivery, record, holdAmbiguous, drain } = setup();
  try {
    f.enqueue(1);
    f.queue[0]!.state = "started";
    await record();
    await holdAmbiguous();
    expect(f.runtime.coordinator.getActiveDelivery("pilot")?.state).toBe(
      "ambiguous",
    );
    expect(
      await drain(idleSession(f.deliveryThread), new AbortController().signal),
    ).toBe(true);
    expect(f.settlements).toMatchObject([
      { delivery_id: "delivery-1", outcome: "applied" },
    ]);
    expect(f.runtime.coordinator.getActiveDelivery("pilot")).toBeUndefined();
  } finally {
    await delivery.clearImages();
    await f.dispose();
  }
});

test("a settlement that stays stale for one attempt backs off, then closes the pilot", async () => {
  const { f, delivery, record, holdAmbiguous, drain } = setup();
  try {
    f.enqueue(1);
    f.queue[0]!.state = "started";
    await record();
    await holdAmbiguous();
    f.rejectSettlements(true);
    const session = idleSession(f.deliveryThread);
    const delays: (number | undefined)[] = [];
    for (let index = 0; index < 4; index++) {
      expect(await drain(session, new AbortController().signal)).toBe(false);
      delays.push(delivery.retryDelayMs());
    }
    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000]);
    let failure: unknown;
    try {
      await drain(session, new AbortController().signal);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(CodexPilotLeaseLost);
  } finally {
    await delivery.clearImages();
    await f.dispose();
  }
});
