import { expect, test } from "bun:test";
import {
  STEER_BATON_CAPABILITY,
  type CanonicalEvent,
} from "@codecast/edge-contract";
import type { OwnedSession } from "@codecast/provider-contract";
import { until } from "../../../../tests/codex-driver-parity/peers.js";
import { strictStub } from "../test-helpers/strictStub.js";
import { bindingFor, fixture } from "./codex-owned-pilot-fixture.js";
import { CodexPilotDelivery } from "./codex-pilot-delivery.js";
import { InMemoryExecutionOperationJournal } from "./local-journal.js";

test.each([
  "matched",
  "adapter mismatch",
  "journal mismatch",
  "throws",
] as const)(
  "a steer without a new start uses only matching durable evidence and clears the starter (%s)",
  async (mode) => {
    const f = fixture("pilot", "receipt");
    const binding = bindingFor(f.pilotRequest, true);
    binding.capabilities = [...binding.capabilities, STEER_BATON_CAPABILITY];
    const journal = new InMemoryExecutionOperationJournal().deliveryReceipts;
    const signal = new AbortController().signal;
    const delivery = new CodexPilotDelivery(
      (op, body, abort) =>
        fetch(`https://pilot.invalid/edge/v1/${op}`, {
          method: "POST",
          body: JSON.stringify(body),
          signal: abort,
        }),
      (message) => f.logs.push(message),
    );
    delivery.receiptJournal = {
      ...journal,
      async find(...args) {
        const record = await journal.find(...args);
        return record && mode === "journal mismatch"
          ? { ...record, delivery_id: "different-delivery" }
          : record;
      },
    };
    const session = strictStub<OwnedSession>("owned provider", {
      getCheckpoint: () => f.deliveryThread,
      async steer(request) {
        expect(request.delivery_id).toBe("delivery-1");
        if (mode === "throws") throw new Error("Provider call failed");
        await journal.record(
          "pilot",
          f.deliveryThread,
          {
            delivery_id: "delivery-1",
            turn: "prior-turn",
            provider_item_id: "prior-item",
          },
          signal,
        );
        return {
          status: "duplicate",
          receipt: {
            delivery_id:
              mode === "adapter mismatch" ? "different-delivery" : "delivery-1",
          },
        };
      },
    });
    try {
      f.enqueue(1);
      await delivery.drain(
        binding,
        f.runtime.coordinator,
        session,
        {
          v: 1,
          status: "granted",
          session: "pilot",
          run: 1,
          fencing_token: "edge-lease",
          lease_ms: 60_000,
          last_pane_instance: 0,
        },
        async (text) => text,
        signal,
        true,
      );
      await until(
        () => f.settlements.length === 1,
        "server records the outcome",
      );
      expect(f.settlements[0]?.outcome).toBe(
        mode === "matched" ? "applied" : "in_doubt",
      );
      expect(f.runtime.coordinator.getActiveDelivery("pilot")?.state).toBe(
        mode === "matched" ? undefined : "ambiguous",
      );
      const nextTurn = {
        v: 1,
        session: "pilot",
        run: 1,
        turn: "unrelated-turn",
        seq: 1,
        at: 1,
        source: "provider",
        kind: "turn.started",
        body: {},
      } satisfies CanonicalEvent;
      expect(delivery.attributeTurnStart(nextTurn)).toEqual(nextTurn);
    } finally {
      await delivery.clearImages();
      await f.dispose();
    }
  },
);
