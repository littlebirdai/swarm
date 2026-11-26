import type {
  DeliveryReceipt,
  DeliveryReceiptJournal,
  DeliveryReceiptRecord,
  ResumeSpec,
  StartSpec,
} from "@codecast/provider-contract";
import * as Effect from "effect/Effect";
import { inDoubt, refused } from "./options";
import { processError } from "./provider-process";

const clientPrefix = "codecast-delivery:";
const maxPending = 128;
const maxCommitted = 128;

export function deliveryClientId(deliveryId: string) {
  return clientPrefix + deliveryId;
}

export const appServerReceipts = Effect.fn("app-server.receipts")(function* (
  spec: StartSpec | ResumeSpec,
  journal: DeliveryReceiptJournal | undefined,
) {
  const entries =
    journal && "checkpoint" in spec
      ? yield* Effect.tryPromise({
          try: (signal) => journal.read(spec.session, spec.checkpoint, signal),
          catch: (cause) =>
            processError(
              "receipt-read-failed",
              "Could not read delivery receipts",
              cause,
            ),
        })
      : [];
  const committed = new Map<string, DeliveryReceipt>();
  const pending = new Map<
    string,
    { deliveryId: string; committing: boolean }
  >();

  function remember(receipt: DeliveryReceipt): void {
    committed.delete(receipt.delivery_id);
    committed.set(receipt.delivery_id, receipt);
    if (committed.size > maxCommitted) {
      const oldest = committed.keys().next().value;
      if (oldest !== undefined) committed.delete(oldest);
    }
  }

  for (const { delivery_id } of entries) remember({ delivery_id });

  const find = Effect.fn("app-server.receipts.find")(function* (
    checkpoint: string,
    deliveryId: string,
  ) {
    const cached = committed.get(deliveryId);
    if (cached || !journal || !deliveryId) return cached;
    const stored = yield* Effect.tryPromise({
      try: (signal) =>
        journal.find(spec.session, checkpoint, deliveryId, signal),
      catch: (cause) =>
        processError(
          "receipt-read-failed",
          "Could not read delivery receipt",
          cause,
        ),
    });
    if (stored) {
      const receipt = { delivery_id: stored.delivery_id };
      remember(receipt);
      return receipt;
    }
  });

  function retry(deliveryId: string) {
    const receipt = committed.get(deliveryId);
    if (receipt) return { status: "duplicate", receipt } as const;
    if (pending.has(deliveryClientId(deliveryId)))
      return inDoubt(
        "unknown",
        "receipt-pending",
        "Delivery has no committed receipt yet",
      );
  }

  function reserve(deliveryId: string) {
    if (!journal) return;
    if (!deliveryId)
      return refused(
        "missing-delivery-id",
        "A delivery receipt requires a delivery ID",
      );
    const outcome = retry(deliveryId);
    if (outcome) return outcome;
    if (pending.size >= maxPending)
      return refused(
        "receipt-limit",
        "Too many deliveries lack a committed receipt",
      );
    pending.set(deliveryClientId(deliveryId), {
      deliveryId,
      committing: false,
    });
  }

  function reject(deliveryId: string) {
    const key = deliveryClientId(deliveryId);
    if (pending.get(key)?.committing === false) pending.delete(key);
  }

  function observe(
    checkpoint: string,
    turn: string,
    providerItemId: string,
    clientId: string | null | undefined,
  ): Effect.Effect<DeliveryReceipt | undefined> | undefined {
    if (!journal || !clientId) return;
    const match = pending.get(clientId);
    if (!match || match.committing) return;
    match.committing = true;
    const receipt = { delivery_id: match.deliveryId };
    const record: DeliveryReceiptRecord = {
      ...receipt,
      provider_item_id: providerItemId,
      turn,
    };
    return Effect.tryPromise({
      try: (signal) => journal.record(spec.session, checkpoint, record, signal),
      catch: (cause) =>
        processError(
          "receipt-write-failed",
          "Could not record the delivery receipt",
          cause,
        ),
    }).pipe(
      Effect.map(() => {
        remember(receipt);
        pending.delete(clientId);
        return receipt;
      }),
      Effect.catch(() => Effect.succeed(undefined)),
    );
  }

  const inDoubtIds = new Set(
    "checkpoint" in spec ? spec.inDoubtDeliveryIds : [],
  );
  const replay = entries
    .filter(({ delivery_id }) => inDoubtIds.has(delivery_id))
    .map(({ delivery_id }) => ({ delivery_id }));
  const recovered = new Map(committed);
  for (const receipt of replay) recovered.set(receipt.delivery_id, receipt);
  return {
    enabled: journal !== undefined,
    recovered: [...recovered.values()],
    replay,
    find,
    retry,
    reserve,
    reject,
    observe,
  };
});
