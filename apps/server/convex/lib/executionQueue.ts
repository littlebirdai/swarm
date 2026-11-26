const TERMINAL_DELIVERY_STATES = new Set([
  "delivered",
  "rejected",
  "cancelled-by-supersession",
  "correlated-delivered",
  "abandoned-ambiguous",
]);

export function isTerminalDeliveryState(state: unknown): boolean {
  return typeof state === "string" && TERMINAL_DELIVERY_STATES.has(state);
}

function isEffectivelyTerminalDelivery(message: any, head?: any): boolean {
  if (isTerminalDeliveryState(message.delivery_status)) return true;
  if (
    head?.pending_policy === "cancel-unstarted" &&
    Number.isSafeInteger(head.cancelled_through_sequence) &&
    message.execution_epoch === head.current_epoch &&
    message.conversation_sequence <= head.cancelled_through_sequence &&
    message.delivery_status !== "delivery-started" &&
    message.delivery_status !== "ambiguous"
  ) {
    return true;
  }
  return false;
}

export function orderedNonterminalMessages(
  messages: readonly any[],
  head?: any,
): any[] {
  return messages
    .filter(
      (message) =>
        Number.isSafeInteger(message.conversation_sequence) &&
        !isEffectivelyTerminalDelivery(message, head),
    )
    .sort(
      (left, right) =>
        left.conversation_sequence - right.conversation_sequence ||
        String(left._id).localeCompare(String(right._id)),
    );
}
