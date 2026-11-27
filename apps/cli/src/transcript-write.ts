import type { TranscriptUplinkClient } from "@codecast/edge-client";
import {
  fitsTranscriptUplink,
  type TranscriptAppendWrite,
  type TranscriptAppendResult,
} from "@codecast/edge-contract";
import { argumentValidationProblem } from "@codecast/convex-errors/convexErrors";
import {
  checkTranscriptDeadline,
  outsideTranscriptDeadline,
} from "./workers/ingestDeadline.js";

export type SyncTranscriptUplink = Pick<
  TranscriptUplinkClient,
  "submit" | "waitForReplay"
>;

export function withoutDeliveryIds<T extends { delivery_ids?: unknown }>(
  message: T,
): Omit<T, "delivery_ids"> {
  const { delivery_ids: _ids, ...rest } = message;
  return rest;
}

export async function tryTranscriptUplink(
  uplink: SyncTranscriptUplink | undefined,
  conversationId: string,
  batch: Array<{ message_uuid?: string; delivery_ids?: unknown }>,
  echoes: boolean,
) {
  if (!uplink || !batch.every((message) => message.message_uuid)) return;
  const write = {
    conversation_id: conversationId,
    messages: JSON.parse(
      JSON.stringify(echoes ? batch : batch.map(withoutDeliveryIds)),
    ),
    ...(echoes ? { echo_ids: true } : {}),
  };
  if (!fitsTranscriptUplink(write)) return;

  checkTranscriptDeadline();
  const result = await uplink.submit(write);
  if (result.status === "refused")
    throw new Error("Transcript write refused for this conversation");
  if (result.status === "applied") return result;
}

export async function replayTranscriptWrite(
  write: TranscriptAppendWrite,
  mutate: (
    payload: TranscriptAppendWrite,
  ) => Promise<{ inserted: number; ids: string[] }>,
): Promise<TranscriptAppendResult> {
  const send = (payload: TranscriptAppendWrite) =>
    outsideTranscriptDeadline(() => mutate(payload));
  try {
    let result;
    try {
      result = await send(write);
    } catch (error) {
      if (
        !write.echo_ids ||
        !/echo_ids|delivery_ids/.test(argumentValidationProblem(error) ?? "")
      )
        throw error;
      result = await send({
        conversation_id: write.conversation_id,
        messages: write.messages.map(withoutDeliveryIds),
      });
    }
    return { status: "applied", ...result };
  } catch (error) {
    if (
      argumentValidationProblem(error) ||
      /Conversation not found|can only add messages to your own conversations|hosted conversation's transcript/.test(
        error instanceof Error ? error.message : "",
      )
    )
      return { status: "refused" };
    throw error;
  }
}
