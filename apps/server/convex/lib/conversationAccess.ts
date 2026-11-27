import type { Id } from "../_generated/dataModel";
import { interestScopesEnabled } from "./accessKeys";

export type ConversationAccessInput = {
  _id: Id<"conversations">;
  user_id?: Id<"users">;
  owner_user_id?: Id<"users">;
  team_id?: Id<"teams">;
  is_private?: boolean;
  auto_shared?: boolean;
  team_visibility?: string;
  started_at?: number;
};

function accessPayload(conv: ConversationAccessInput) {
  return {
    user_id: conv.user_id as Id<"users">,
    owner_user_id: conv.owner_user_id,
    team_id: conv.team_id,
    is_private: conv.is_private,
    auto_shared: conv.auto_shared,
    team_visibility: conv.team_visibility,
    started_at: conv.started_at,
  };
}

export async function syncConversationAccess(
  db: any,
  conv: ConversationAccessInput | null | undefined,
): Promise<void> {
  if (!conv?._id || !conv.user_id || !interestScopesEnabled()) return;
  const existing = await db
    .query("conversation_access")
    .withIndex("by_conversation", (q: any) => q.eq("conversation_id", conv._id))
    .first();
  const payload = accessPayload(conv);
  if (existing) {
    await db.patch(existing._id, payload);
    return;
  }
  await db.insert("conversation_access", {
    conversation_id: conv._id,
    ...payload,
  });
}

export async function ensureConversationAccess(
  db: any,
  conv: ConversationAccessInput | null | undefined,
): Promise<void> {
  if (!conv?._id || !conv.user_id || !interestScopesEnabled()) return;
  const existing = await db
    .query("conversation_access")
    .withIndex("by_conversation", (q: any) => q.eq("conversation_id", conv._id))
    .first();
  if (existing) return;
  await db.insert("conversation_access", {
    conversation_id: conv._id,
    ...accessPayload(conv),
  });
}

export async function ensureConversationAccessById(
  db: any,
  conversationId: Id<"conversations">,
): Promise<void> {
  if (!interestScopesEnabled()) return;
  const existing = await db
    .query("conversation_access")
    .withIndex("by_conversation", (q: any) =>
      q.eq("conversation_id", conversationId),
    )
    .first();
  if (existing) return;
  const conv = await db.get(conversationId);
  if (!conv?.user_id) return;
  await db.insert("conversation_access", {
    conversation_id: conv._id,
    ...accessPayload(conv),
  });
}

export async function deleteConversationAccess(
  db: any,
  conversationId: Id<"conversations">,
): Promise<void> {
  if (!interestScopesEnabled()) return;
  const existing = await db
    .query("conversation_access")
    .withIndex("by_conversation", (q: any) =>
      q.eq("conversation_id", conversationId),
    )
    .first();
  if (existing) {
    await db.delete(existing._id);
  }
}
