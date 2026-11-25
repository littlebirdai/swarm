import { ConvexError } from "convex/values";

export function fencedMoveRefusal(
  conversation: { execution_protocol_state?: string },
  mode: "return" | "throw" = "return",
): string | undefined {
  if (conversation.execution_protocol_state === undefined) return;
  const reason =
    "This session uses fenced execution and cannot move to another device or account.";
  if (mode === "throw") throw new ConvexError(reason);
  return reason;
}
