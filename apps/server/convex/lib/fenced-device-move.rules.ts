import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

const DEVICE_ROWS = 500;
const DEVICE_ROWS_WITH_FENCED = 1500;

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

export async function scanDeviceRows(
  ctx: Pick<MutationCtx, "db">,
  userId: Id<"users">,
  deviceId: string,
) {
  const head = await ctx.db
    .query("conversation_execution_heads")
    .withIndex("by_owner_state", (q) => q.eq("owner_user_id", userId))
    .first();
  const scanned = await ctx.db
    .query("conversations")
    .withIndex("by_owner_device", (q) =>
      q.eq("user_id", userId).eq("owner_device_id", deviceId),
    )
    .take(head ? DEVICE_ROWS_WITH_FENCED : DEVICE_ROWS);
  return {
    rows: scanned
      .filter((row) => !fencedMoveRefusal(row))
      .slice(0, DEVICE_ROWS),
    fenced: scanned.find((row) => fencedMoveRefusal(row)),
  };
}
