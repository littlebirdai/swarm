import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  isTerminalDeliveryState,
  orderedNonterminalMessages,
} from "./executionQueue";

type Db = Pick<MutationCtx, "db">;
type Head = Doc<"conversation_execution_heads">;
type Message = Doc<"pending_messages">;

const unsettled = [
  "pending",
  "claimed",
  "delivery-started",
  "ambiguous",
  undefined,
] as const;

export function legacyPendingRows(
  ctx: Db,
  conversation: Id<"conversations">,
  status: Message["status"],
) {
  return ctx.db
    .query("pending_messages")
    .withIndex("by_conversation_status_protocol_queued", (q) =>
      q
        .eq("conversation_id", conversation)
        .eq("status", status)
        .eq("delivery_protocol_version", undefined),
    );
}

export function queuedLegacyRows(
  ctx: Db,
  conversation: Id<"conversations">,
  status: "held" | "pending",
) {
  return ctx.db
    .query("pending_messages")
    .withIndex("by_conversation_status_protocol_queued", (q) =>
      q
        .eq("conversation_id", conversation)
        .eq("status", status)
        .eq("delivery_protocol_version", undefined)
        .eq("queued", true),
    )
    .collect();
}

export function pendingByIntent(
  ctx: Db,
  head: Head,
  epoch: number,
  intent: Message["delivery_intent"],
  limit: number,
) {
  return ctx.db
    .query("pending_messages")
    .withIndex("by_conversation_epoch_delivery_status_intent_sequence", (q) =>
      q
        .eq("conversation_id", head.conversation_id)
        .eq("execution_epoch", epoch)
        .eq("delivery_status", "pending")
        .eq("delivery_intent", intent)
        .gte("conversation_sequence", head.next_nonterminal_sequence),
    )
    .take(limit);
}

export async function hasNonterminalAtEpoch(
  ctx: Db,
  conversation: Id<"conversations">,
  epoch: number,
): Promise<boolean> {
  for (const status of unsettled) {
    const row = await ctx.db
      .query("pending_messages")
      .withIndex("by_conversation_epoch_delivery_status_intent_sequence", (q) =>
        q
          .eq("conversation_id", conversation)
          .eq("execution_epoch", epoch)
          .eq("delivery_status", status),
      )
      .first();
    if (row) return true;
  }
  return false;
}

function byDeliveryState(
  ctx: Db,
  conversation: Id<"conversations">,
  status: (typeof unsettled)[number],
  from: number,
) {
  return ctx.db
    .query("pending_messages")
    .withIndex("by_conversation_delivery_status_sequence", (q) =>
      q
        .eq("conversation_id", conversation)
        .eq("delivery_status", status)
        .gte("conversation_sequence", from),
    )
    .first();
}

export async function hasNonterminalDelivery(
  ctx: Db,
  conversation: Id<"conversations">,
): Promise<boolean> {
  for (const status of unsettled) {
    if (await byDeliveryState(ctx, conversation, status, 1)) return true;
  }
  return false;
}

export async function oldestNonterminal(
  ctx: Db,
  head: Head,
): Promise<Message | undefined> {
  const from = head.next_nonterminal_sequence;
  if (from >= head.next_conversation_sequence) return;
  const atHead = await ctx.db
    .query("pending_messages")
    .withIndex("by_conversation_sequence", (q) =>
      q
        .eq("conversation_id", head.conversation_id)
        .eq("conversation_sequence", from),
    )
    .first();
  if (
    atHead?.delivery_protocol_version !== undefined &&
    orderedNonterminalMessages([atHead], head).length
  )
    return atHead;
  const firstByStatus = await Promise.all(
    unsettled.map(async (status) => {
      const first = await byDeliveryState(
        ctx,
        head.conversation_id,
        status,
        from,
      );
      if (!first || orderedNonterminalMessages([first], head).length)
        return first;
      const cutoff = head.cancelled_through_sequence;
      return cutoff === undefined
        ? null
        : await byDeliveryState(ctx, head.conversation_id, status, cutoff + 1);
    }),
  );
  return orderedNonterminalMessages(
    firstByStatus.filter(
      (row) =>
        row?.delivery_protocol_version !== undefined &&
        !isTerminalDeliveryState(row.delivery_status),
    ),
    head,
  )[0];
}
