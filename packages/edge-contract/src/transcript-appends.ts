import {
  array,
  boolean,
  count,
  EdgeParseError,
  json,
  nonEmptyString,
  object,
  oneOf,
  optional,
  parser,
  responseObject,
  tagged,
  type EdgeJson,
  type Reader,
} from "./parse";
import { EDGE_PROTOCOL_VERSION, readV1 } from "./version";

export const TRANSCRIPT_APPEND_MAX_MESSAGES = 50;
export const TRANSCRIPT_APPEND_MAX_WRITE_MESSAGES = 25;
export const TRANSCRIPT_APPEND_MAX_BYTES = 512 * 1024;
export const TRANSCRIPT_APPEND_OPERATION = "transcripts.append";

const role = oneOf("user", "assistant", "system", "tool");
const message: Reader<Record<string, EdgeJson>> = (value, path) => {
  const row = json(value, path);
  if (row === null || typeof row !== "object" || Array.isArray(row))
    throw new EdgeParseError(
      "invalid_type",
      path,
      "expected a transcript message",
    );
  role(row.role, `${path}.role`);
  return row;
};
const write = object({
  conversation_id: nonEmptyString,
  messages: array(message),
  echo_ids: optional(boolean),
});
const request = object({
  v: readV1,
  batch_id: nonEmptyString,
  writes: array(write),
});
const result = tagged("status", {
  applied: responseObject({
    status: oneOf("applied"),
    inserted: count,
    ids: array(nonEmptyString),
  }),
  refused: responseObject({ status: oneOf("refused") }),
});
const receipt = responseObject({
  v: readV1,
  batch_id: nonEmptyString,
  results: array(result),
});

export type TranscriptAppendRequest = ReturnType<typeof request>;
export type TranscriptAppendWrite = TranscriptAppendRequest["writes"][number];
export type TranscriptAppendReceipt = ReturnType<typeof receipt>;
export type TranscriptAppendResult = TranscriptAppendReceipt["results"][number];

export const parseTranscriptAppendRequest = parser((value, path) => {
  const body = request(value, path);
  if (body.batch_id.length > 128 || body.writes.length === 0)
    throw new EdgeParseError("invalid_value", path, "invalid transcript batch");
  let count = 0;
  for (const entry of body.writes) {
    count += entry.messages.length;
    if (
      entry.messages.length === 0 ||
      entry.messages.length > TRANSCRIPT_APPEND_MAX_WRITE_MESSAGES ||
      count > TRANSCRIPT_APPEND_MAX_MESSAGES
    )
      throw new EdgeParseError(
        "invalid_value",
        path,
        "invalid transcript message count",
      );
  }
  return body;
});
export const parseTranscriptAppendResponse = parser(receipt);

const encoder = new TextEncoder();

export function transcriptBatchFits(
  writes: TranscriptAppendWrite[],
  batchId: string,
): boolean {
  let count = 0;
  for (const write of writes) count += write.messages.length;
  return (
    count <= TRANSCRIPT_APPEND_MAX_MESSAGES &&
    encoder.encode(
      JSON.stringify({ v: EDGE_PROTOCOL_VERSION, batch_id: batchId, writes }),
    ).length <= TRANSCRIPT_APPEND_MAX_BYTES
  );
}

export function fitsTranscriptUplink(write: TranscriptAppendWrite): boolean {
  return (
    write.messages.length > 0 &&
    write.messages.length <= TRANSCRIPT_APPEND_MAX_WRITE_MESSAGES &&
    transcriptBatchFits([write], "00000000-0000-0000-0000-000000000000")
  );
}
