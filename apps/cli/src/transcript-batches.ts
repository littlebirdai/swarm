export const ADD_MESSAGES_BATCH_SIZE = 25;
// Max serialized bytes of one addMessages batch (~0.9MB, well under the 5MB
// that triggered isolate OOM/timeouts in the 2026-05-13 stuck-sync incident).
const MAX_BATCH_BYTES = 900_000;

/**
 * Split prepared messages into mutation-sized batches, bounded by BOTH message
 * count and serialized byte size. The byte bound is what stops a handful of
 * image-heavy messages (large inline base64) from forming a multi-MB mutation
 * that can't commit within the timeout/isolate budget. A single message that
 * alone exceeds the byte cap is emitted in its own batch — one message can't be
 * split, and one ~MAX_INLINE_IMAGE_SIZE message commits fine on its own.
 */
export function chunkMessagesBySize<T>(
  messages: T[],
  maxCount: number = ADD_MESSAGES_BATCH_SIZE,
  maxBytes: number = MAX_BATCH_BYTES,
): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let currentBytes = 0;
  for (const msg of messages) {
    const bytes = Buffer.byteLength(JSON.stringify(msg));
    if (
      current.length > 0 &&
      (current.length >= maxCount || currentBytes + bytes > maxBytes)
    ) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(msg);
    currentBytes += bytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
