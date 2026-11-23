import { sameValue } from "../sameValue";

type MessageIdentity = { _id?: string; _clientId?: string; client_id?: string };
type PositionedMessage<T> = { position: number; message: T };

export function diffMessageTail<T extends MessageIdentity>(
  previous: ReadonlyMap<string, PositionedMessage<T>>,
  messages: readonly T[],
) {
  const occurrences = new Map<string, number>();
  const keys = messages.map((message) => {
    // Replayed IDs can occur in the source array. Keep each occurrence addressable.
    const base = message._id ? `id:${message._id}` : `local:${message._clientId ?? message.client_id ?? ""}`;
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    return `${occurrence}:${base}`;
  });

  // Keep the positions of rows still in order, including when the tail drops
  // its oldest row. Fill inserts between their neighbors so bodies stay put.
  let positions: number[] = [];
  let leftIndex = -1;
  let leftPosition: number | undefined;
  for (let i = 0; i <= keys.length; i++) {
    const rightPosition = previous.get(keys[i])?.position;
    if (i < keys.length && (rightPosition === undefined || (leftPosition !== undefined && rightPosition <= leftPosition))) continue;

    const span = i - leftIndex;
    const start = leftPosition ?? (rightPosition === undefined ? -1 : rightPosition - span);
    const step = rightPosition === undefined ? 1 : (rightPosition - start) / span;
    for (let j = leftIndex + 1; j < i; j++) {
      positions[j] = start + step * (j - leftIndex);
    }
    if (rightPosition !== undefined) positions[i] = rightPosition;
    leftIndex = i;
    leftPosition = rightPosition;
  }
  // Repeated inserts into the same gap can exhaust floating-point precision.
  if (positions.some((position, index) => index > 0 && position <= positions[index - 1])) {
    positions = keys.map((_, index) => index);
  }

  const next = new Map<string, PositionedMessage<T>>();
  const puts: Array<{ messageKey: string } & PositionedMessage<T>> = [];
  for (const [index, messageKey] of keys.entries()) {
    const row = { message: messages[index], position: positions[index] };
    next.set(messageKey, row);
    const old = previous.get(messageKey);
    if (old?.position !== row.position || !sameValue(old.message, row.message)) {
      puts.push({ messageKey, ...row });
    }
  }
  const deletes = [...previous.keys()].filter((key) => !next.has(key));
  return { next, puts, deletes };
}
