import { EDGE_ERROR_CODES } from "@codecast/edge-contract";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";

export const MAX_EDGE_BLOB_BYTES = 8 * 1024 * 1024;
const imageTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
]);

export function permitImageIds(message: Doc<"pending_messages">) {
  return new Set([
    ...(message.image_storage_id ? [message.image_storage_id] : []),
    ...(message.image_storage_ids ?? []),
  ]);
}

export async function permitImageContentType(
  ctx: Pick<QueryCtx, "db">,
  storageId: Id<"_storage">,
) {
  const file = await ctx.db.system.get(storageId);
  if (!file) throw new ConvexError(EDGE_ERROR_CODES.NOT_FOUND);
  if (file.size > MAX_EDGE_BLOB_BYTES)
    throw new ConvexError(EDGE_ERROR_CODES.TOO_LARGE);
  const contentType = file.contentType?.toLowerCase();
  if (!contentType || !imageTypes.has(contentType))
    throw new ConvexError(EDGE_ERROR_CODES.INVALID);
  return contentType;
}
