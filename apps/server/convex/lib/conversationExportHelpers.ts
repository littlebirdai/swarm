import { query, type QueryCtx } from "../functions";
import { otherShortIdMatches } from "../conversationSessionLookup";
import { Doc, Id } from "../_generated/dataModel";
import { listConversationFileChanges } from "./messageReads";
import { approxMessageBytes } from "../userMessagesFilter";
import { canOwnerOrTeamAccess } from "../privacy";
import { READ_STEP_BYTES, type ScanCursor } from "./conversationRead";
import { formatSlugAsTitle } from "./conversationBasics";
import {
  getAuthenticatedUserIdReadOnly,
  resolveConversationRef,
} from "./conversationHelpers";

/** `cast diff`'s tree input: the changes a fold reads, with text, under a
 *  byte budget. `file_changes_truncated` names a tree missing files. */
export async function foldChangesPayload(
  ctx: QueryCtx,
  conversationId: Id<"conversations">,
) {
  const { changes, truncated } = await listConversationFileChanges(
    ctx,
    conversationId,
  );
  return {
    file_changes: changes,
    file_changes_truncated: truncated || undefined,
  };
}

/** The conversation an API token names and may read, or the reason it may not. */
export async function readableConversation(
  ctx: QueryCtx,
  apiToken: string,
  ref: string,
) {
  const authUserId = await getAuthenticatedUserIdReadOnly(ctx, apiToken);
  if (!authUserId) return { error: "Unauthorized" as const };
  return readableConversationAs(ctx, authUserId, ref);
}

/** readableConversation for a caller already identified (a scheduled action
 *  acting for the person who asked): the same access rule, no token. */
export async function readableConversationAs(
  ctx: QueryCtx,
  authUserId: Id<"users">,
  ref: string,
) {
  const user = await ctx.db.get(authUserId);
  if (!user) return { error: "User not found" as const };
  const conv = await resolveConversationRef(ctx, ref, authUserId);
  if (!conv) return { error: "Conversation not found" as const };
  // Owners read their own conversations; team members read non-private ones.
  if (!(await canOwnerOrTeamAccess(ctx, authUserId, conv)))
    return { error: "Access denied" as const };
  return { conv, user };
}

/**
 * Stream a conversation's message rows from a resume point, so only one row
 * body is in the heap at a time, until READ_STEP_BYTES have been read or
 * `visit` returns true. Returns where the next step resumes, or undefined once
 * the last row is read.
 */
export async function streamMessageRows(
  ctx: QueryCtx,
  conversationId: Id<"conversations">,
  after: ScanCursor | undefined,
  order: "asc" | "desc",
  visit: (m: Doc<"messages">) => boolean | void,
): Promise<ScanCursor | undefined> {
  const rows = ctx.db
    .query("messages")
    .withIndex("by_conversation_id", (q) => {
      const conv = q.eq("conversation_id", conversationId);
      if (!after) return conv;
      return order === "asc"
        ? conv.gte("_creationTime", after.creation_time)
        : conv.lte("_creationTime", after.creation_time);
    })
    .order(order);
  let bytes = 0;
  let lastTime = after?.creation_time;
  let sameTime = after?.skip ?? 0;
  let toSkip = after?.skip ?? 0;
  for await (const m of rows) {
    if (toSkip > 0 && m._creationTime === after?.creation_time) {
      toSkip--;
      continue;
    }
    toSkip = 0;
    sameTime = m._creationTime === lastTime ? sameTime + 1 : 1;
    lastTime = m._creationTime;
    bytes += approxMessageBytes(m as any);
    if (visit(m) === true || bytes >= READ_STEP_BYTES)
      return { creation_time: m._creationTime, skip: sameTime };
  }
  return undefined;
}

/** The conversation among those sharing `ref`'s short id that holds
 *  `messageId`, when the caller can read it; otherwise `resolved` unchanged. */
export async function conversationHoldingMessage(
  ctx: QueryCtx,
  userId: Id<"users">,
  ref: string,
  messageId: string,
  resolved: Doc<"conversations">,
): Promise<Doc<"conversations">> {
  const id = ctx.db.normalizeId("messages", messageId);
  const message = id ? await ctx.db.get(id) : null;
  if (!message || message.conversation_id === resolved._id) return resolved;
  const holder = (await otherShortIdMatches(ctx, ref, resolved)).find(
    (c) => String(c._id) === String(message.conversation_id),
  );
  if (!holder || !(await canOwnerOrTeamAccess(ctx, userId, holder)))
    return resolved;
  return holder as Doc<"conversations">;
}

/** The other conversations the caller can read that answer to the same short
 *  id, so `cast read` can say the one it opened may not be the one they meant
 *  and print the longer prefix that picks each. Absent when there are none. */
export async function sameShortIdPayload(
  ctx: QueryCtx,
  userId: Id<"users">,
  ref: string,
  conv: Doc<"conversations">,
): Promise<{
  same_short_id?: Array<{ id: string; title: string; updated_at: string }>;
}> {
  const others = [];
  for (const other of await otherShortIdMatches(ctx, ref, conv)) {
    if (!(await canOwnerOrTeamAccess(ctx, userId, other))) continue;
    others.push({
      id: String(other._id),
      title:
        other.title ||
        (other.slug ? formatSlugAsTitle(other.slug) : null) ||
        "New Session",
      updated_at: new Date(other.updated_at).toISOString(),
    });
    if (others.length >= 5) break;
  }
  return others.length ? { same_short_id: others } : {};
}
