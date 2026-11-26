import type { Doc } from "../../_generated/dataModel";
import { deliveryRejectionCodes } from "../delivery-slot.state";

export type FinalDeliveryReceipt = {
  retryable: false;
  deliveryId: string;
  outcome: "rejected" | "failed";
};

export function finalDeliveryReceipt(
  attempt: Doc<"delivery_attempts"> | null,
): FinalDeliveryReceipt | undefined {
  if (attempt?.state !== "failed-before-effect") return;
  const outcome =
    attempt.failure_code === deliveryRejectionCodes.rejected
      ? "rejected"
      : attempt.failure_code === deliveryRejectionCodes.finalFailure
        ? "failed"
        : undefined;
  if (outcome)
    return { retryable: false, deliveryId: attempt.delivery_id, outcome };
}
