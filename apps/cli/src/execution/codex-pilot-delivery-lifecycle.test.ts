import { expect, test } from "bun:test";
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
  type CodexPilotDeliveryOptions,
} from "./codex-pilot-delivery.js";
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

function setup(options?: CodexPilotDeliveryOptions) {
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
    options,
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

test("a provider call that outlives its time limit reads its receipt and settles late", async () => {
  const { f, delivery, record, drain } = setup({ providerTimeoutMs: 50 });
  const session = strictStub<OwnedSession>("owned provider", {
    getCheckpoint: () => f.deliveryThread,
    async steer() {
      await Bun.sleep(150);
      await record();
      return { status: "duplicate", receipt: { delivery_id: "delivery-1" } };
    },
  });
  try {
    f.enqueue(1);
    expect(await drain(session, new AbortController().signal)).toBe(false);
    expect(f.settlements.map(({ outcome }) => outcome)).toEqual(["in_doubt"]);
    await until(
      () => f.settlements.some(({ outcome }) => outcome === "applied"),
      "the late provider result settles the delivery",
    );
    await until(
      () => f.runtime.coordinator.getActiveDelivery("pilot") === undefined,
      "the coordinator releases the settled delivery",
    );
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
    await expect(
      drain(session, new AbortController().signal),
    ).rejects.toBeInstanceOf(CodexPilotLeaseLost);
  } finally {
    await delivery.clearImages();
    await f.dispose();
  }
});
