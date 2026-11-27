import { STEER_BATON_CAPABILITY } from "@codecast/edge-contract";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { checkConversationAccess } from "../privacy";
import { takeoverForTurn } from "./claims";
import { executionBinding, executionHead } from "./execution-binding.state";

type Db = Pick<MutationCtx, "db">;
type Turn = NonNullable<Doc<"run_turn_projections">["open_turn"]>;

export async function setAgentSteerGrantInDb(
  ctx: Db,
  userId: Id<"users">,
  conversationId: Id<"conversations">,
  senderId: Id<"conversations"> | null,
) {
  const conversation = await ctx.db.get(conversationId);
  if (
    !conversation ||
    (conversation.owner_user_id ?? conversation.user_id) !== userId
  )
    throw new ConvexError("Only the session owner can grant agent steer");

  const head = await executionHead(ctx, conversationId);
  const binding =
    head?.current_epoch === undefined
      ? null
      : await executionBinding(ctx, conversationId, head.current_epoch);
  if (
    head?.protocol_state !== "fenced" ||
    !binding?.required_capabilities.includes(STEER_BATON_CAPABILITY)
  )
    throw new ConvexError("Agent steer is unavailable for this session");

  if (senderId !== null) {
    const sender = await ctx.db.get(senderId);
    if (
      !sender ||
      sender._id === conversationId ||
      (await checkConversationAccess(ctx, userId, sender)) === "denied"
    )
      throw new ConvexError("Choose a readable sending session");
  }

  const grant = head.agent_steer_grant;
  if (grant?.sender_id === senderId && grant.by_user_id === userId) return;
  await ctx.db.patch(head._id, {
    agent_steer_grant: {
      sender_id: senderId,
      by_user_id: userId,
      revision: (grant?.revision ?? 0) + 1,
    },
  });
}

export async function allowedAgentSteer(
  ctx: Db,
  conversation: Doc<"conversations">,
  senderId: Id<"conversations">,
  senderUserId: Id<"users">,
  turn: Turn,
  activeClaim: Doc<"claims"> | null,
  now: number,
  head: Doc<"conversation_execution_heads">,
): Promise<number | undefined> {
  const owner = conversation.owner_user_id ?? conversation.user_id;
  const grant = head.agent_steer_grant;
  if (
    !turn.starter ||
    head.current_epoch === undefined ||
    takeoverForTurn(activeClaim, head.current_epoch, turn)?.state ===
      "pending" ||
    grant?.sender_id !== senderId ||
    grant.by_user_id !== owner
  )
    return;
  const holder =
    activeClaim?.holder !== undefined && activeClaim.lease_until > now
      ? activeClaim.holder
      : !turn.baton_converted && turn.starter.kind === "person"
        ? turn.starter.id
        : undefined;
  if (holder !== undefined && holder !== owner) return;
  const sender = await ctx.db.get(senderId);
  if (sender?.user_id === senderUserId) return grant.revision;
}
