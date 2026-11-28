import type { ReadyBinding } from "@codecast/agent-clients/executionBinding";
import type { DeliveryBridge, ReceiptJournal } from "@codecast/delivery";
import {
  STEER_BATON_CAPABILITY,
  type PermitsNextResponse,
} from "@codecast/edge-contract";
import type {
  DeliveryOutcome,
  OwnedSession,
} from "@codecast/provider-contract";

const RECEIPT_READ_MS = 5_000;

type Sender = Extract<PermitsNextResponse, { status: "permit" }>["sender"];

export function makeOwnedProviderBridge(deps: {
  readonly context: () => {
    readonly binding: ReadyBinding;
    readonly session: OwnedSession;
  };
  readonly receipts: ReceiptJournal;
  readonly hasAppendedReceipt: (deliveryId: string) => boolean;
  readonly setPendingStarter: (sender: Sender | undefined) => void;
}): Required<Pick<DeliveryBridge, "deliver" | "recover">> {
  return {
    deliver: async (request, signal) => {
      const ctx = deps.context();
      signal.throwIfAborted();
      const turn =
        request.intent === "queue" ? null : (request.expected?.turn ?? null);
      const recordsStarter =
        ctx.binding.capabilities.includes(STEER_BATON_CAPABILITY) &&
        turn === null;
      if (recordsStarter) deps.setPendingStarter(request.sender);
      let result: DeliveryOutcome | undefined;
      try {
        result = await ctx.session.steer({
          expected: {
            run: request.run,
            fencing_token: request.fencing_token,
            turn,
          },
          delivery_id: request.delivery_id,
          authors: [request.sender],
          input: [...request.input],
        });
      } finally {
        if (recordsStarter && result?.status !== "accepted")
          deps.setPendingStarter(undefined);
      }
      if (
        result.status === "duplicate" &&
        result.receipt.delivery_id === request.delivery_id
      ) {
        const recorded = await deps.receipts.find(
          request.session,
          request.delivery_id,
          AbortSignal.timeout(RECEIPT_READ_MS),
        );
        if (recorded) return { status: "duplicate", receipt: recorded };
        return {
          status: "in_doubt",
          reason: "unknown",
          code: "OWNED_CODEX_RECEIPT_MISSING",
          message: "Owned Codex receipt is absent from the journal",
        };
      }
      if (deps.hasAppendedReceipt(request.delivery_id)) {
        const recorded = await deps.receipts.find(
          request.session,
          request.delivery_id,
          AbortSignal.timeout(RECEIPT_READ_MS),
        );
        if (recorded) return { status: "delivered", receipt: recorded };
      }
      if (
        result.status === "stale" ||
        result.status === "refused" ||
        result.status === "unsupported"
      ) {
        return {
          status: "failed",
          retryable: result.status === "stale",
          code:
            result.status === "refused"
              ? result.code
              : `OWNED_CODEX_DELIVERY_${result.status.toUpperCase()}`,
          message:
            result.status === "refused"
              ? result.message
              : `Codex delivery was ${result.status}`,
        };
      }
      return {
        status: "in_doubt",
        reason: result.status === "in-doubt" ? "unknown" : "best-effort",
        code:
          result.status === "in-doubt"
            ? result.code
            : "OWNED_CODEX_RECEIPT_PENDING",
        message:
          result.status === "in-doubt"
            ? result.message
            : "Delivery awaits a Codex receipt",
      };
    },
    recover: async (request, signal) => {
      const recorded = await deps.receipts.find(
        request.session,
        request.delivery_id,
        signal,
      );
      if (recorded) return { status: "delivered", receipt: recorded };
      return {
        status: "in_doubt",
        code: "OWNED_CODEX_RECEIPT_PENDING",
        message: "Delivery awaits a Codex receipt",
      };
    },
  };
}
