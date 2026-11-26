import type { Doc, Id } from "../_generated/dataModel";
import {
  executionBinding,
  executionHead,
  type DbCtx,
} from "./execution-binding.state";

function sameOptionalIds(
  left: unknown[] | undefined,
  right: unknown[] | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.length === right.length &&
    left.every((value, index) => String(value) === String(right[index]))
  );
}

export async function pendingMessageMatchesProductIntent(
  ctx: DbCtx,
  message: Doc<"pending_messages">,
  conversation: Pick<Doc<"conversations">, "_id" | "user_id">,
  userId: Id<"users">,
  intent: {
    content: string;
    imageStorageIds?: Id<"_storage">[];
    clientId: string;
  },
): Promise<boolean> {
  const sameIntent =
    String(message.conversation_id) === String(conversation._id) &&
    String(message.from_user_id) === String(userId) &&
    message.content === intent.content &&
    message.client_id === intent.clientId &&
    message.image_storage_id === undefined &&
    sameOptionalIds(message.image_storage_ids, intent.imageStorageIds) &&
    message.from_conversation_id === undefined &&
    message.origin === undefined &&
    message.resend_of_delivery_id === undefined;
  if (!sameIntent) return false;
  if (String(message.owner_user_id) === String(conversation.user_id))
    return true;
  if (
    message.delivery_protocol_version === undefined ||
    message.owner_user_id === undefined
  )
    return false;

  const head = await executionHead(ctx, conversation._id);
  if (head?.device_move?.destination_runner_id === message.owner_user_id)
    return true;
  if (message.execution_epoch === undefined) return false;
  const binding = await executionBinding(
    ctx,
    conversation._id,
    message.execution_epoch,
  );
  return binding?.owner_user_id === message.owner_user_id;
}
