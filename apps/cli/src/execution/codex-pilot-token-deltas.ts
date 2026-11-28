import type { MessageDelta } from "@codecast/edge-contract";
import type { TokenDelta } from "@codecast/edge-client/relay-liveness";

const MAX_CHUNK_UTF8_BYTES = 2048;
const MAX_TRACKED_MESSAGES = 64;

export type CodexPilotDeltaPublish = (delta: TokenDelta) => boolean;

export function splitTokenDeltaText(
  text: string,
  maxBytes = MAX_CHUNK_UTF8_BYTES,
): string[] {
  if (!text) return [];
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return [text];
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const ch of text) {
    const chBytes = Buffer.byteLength(ch, "utf8");
    if (current && currentBytes + chBytes > maxBytes) {
      chunks.push(current);
      current = ch;
      currentBytes = chBytes;
    } else {
      current += ch;
      currentBytes += chBytes;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function createCodexPilotDeltaPublisher(options: {
  enabled: boolean;
  run: number;
  session: string;
  publish: () => CodexPilotDeltaPublish | undefined;
}): (event: MessageDelta) => void {
  const sequences = new Map<string, number>();

  return (event) => {
    if (!options.enabled || !event.turn || !event.body.text) return;
    const chunks = splitTokenDeltaText(event.body.text);
    if (!chunks.length) return;
    const key = `${event.turn}\0${event.body.message_id}`;
    if (!sequences.has(key) && sequences.size >= MAX_TRACKED_MESSAGES) {
      const oldest = sequences.keys().next().value;
      if (oldest !== undefined) sequences.delete(oldest);
    }
    let nextSeq = (sequences.get(key) ?? 0) + 1;
    const publish = options.publish();
    for (const chunk of chunks) {
      const seq = nextSeq++;
      if (!publish) continue;
      try {
        publish({
          session: options.session,
          run: options.run,
          turn: event.turn,
          message_id: event.body.message_id,
          delta_seq: seq,
          text: chunk,
        });
      } catch {
        continue;
      }
    }
    sequences.set(key, nextSeq - 1);
  };
}
