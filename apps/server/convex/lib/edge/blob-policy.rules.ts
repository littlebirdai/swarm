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

export async function inspectPermitImage(
  ctx: Pick<QueryCtx, "db">,
  storageId: Id<"_storage">,
) {
  const file = await ctx.db.system.get(storageId);
  if (!file) return { status: "missing" } as const;
  if (file.size > MAX_EDGE_BLOB_BYTES) return { status: "too_large" } as const;
  const contentType = file.contentType?.toLowerCase();
  if (!contentType || !imageTypes.has(contentType))
    return { status: "invalid" } as const;
  return { status: "ready", contentType } as const;
}
