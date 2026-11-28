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
  string,
  tagged,
  type EdgeJson,
  type Reader,
} from "./parse";
import { EDGE_PROTOCOL_VERSION, readV1 } from "./version";

export const TRANSCRIPT_APPEND_MAX_MESSAGES = 50;
export const TRANSCRIPT_APPEND_MAX_WRITE_MESSAGES = 25;
export const TRANSCRIPT_APPEND_MAX_BYTES = 512 * 1024;
export const TRANSCRIPT_APPEND_OPERATION = "transcripts.append";

const finite: Reader<number> = (value, path) => {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new EdgeParseError("invalid_type", path, "expected a finite number");
  return value;
};

const transcriptMessage = object({
  role: oneOf("user", "assistant", "system", "tool"),
  message_uuid: optional(string),
  source_device_id: optional(string),
  source_revision: optional(finite),
  content: optional(string),
  thinking: optional(string),
  thinking_signature: optional(string),
  thinking_redacted: optional(boolean),
  tool_calls: optional(
    array(
      object({
        id: string,
        name: string,
        input: string,
      }),
    ),
  ),
  tool_results: optional(
    array(
      object({
        tool_use_id: string,
        content: string,
        is_error: optional(boolean),
      }),
    ),
  ),
  images: optional(
    array(
      object({
        media_type: string,
        data: optional(string),
        storage_id: optional(string),
        tool_use_id: optional(string),
      }),
    ),
  ),
  files: optional(
    array(
      object({
        name: string,
        media_type: string,
        size: optional(finite),
        storage_id: optional(string),
        tool_use_id: optional(string),
        caption: optional(string),
        display: optional(string),
        error: optional(string),
      }),
    ),
  ),
  subtype: optional(string),
  model: optional(string),
  timestamp: optional(finite),
  usage: optional(
    object({
      input_tokens: finite,
      output_tokens: finite,
      cache_creation_input_tokens: optional(finite),
      cache_read_input_tokens: optional(finite),
    }),
  ),
  api_message_id: optional(string),
  delivery_ids: optional(array(string)),
});

const legacyMessage: Reader<Record<string, EdgeJson>> = (value, path) => {
  const row = json(value, path);
  if (row === null || typeof row !== "object" || Array.isArray(row))
    throw new EdgeParseError(
      "invalid_type",
      path,
      "expected a transcript message",
    );
  return row;
};

const request = (message: typeof legacyMessage) =>
  object({
    v: readV1,
    batch_id: nonEmptyString,
    writes: array(
      object({
        conversation_id: nonEmptyString,
        messages: array(message),
        echo_ids: optional(boolean),
      }),
    ),
  });
const legacyRequest = request(legacyMessage);
const strictRequest = request((value, path) => {
  transcriptMessage(value, path);
  return legacyMessage(value, path);
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

export type TranscriptAppendRequest = ReturnType<typeof legacyRequest>;
export type TranscriptAppendWrite = TranscriptAppendRequest["writes"][number];
export type TranscriptAppendReceipt = ReturnType<typeof receipt>;
export type TranscriptAppendResult = TranscriptAppendReceipt["results"][number];

function constrainedRequest(read: typeof strictRequest) {
  return parser((value, path) => {
    const body = read(value, path);
    if (body.batch_id.length > 128 || body.writes.length === 0)
      throw new EdgeParseError(
        "invalid_value",
        path,
        "invalid transcript batch",
      );
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
    if (
      encoder.encode(JSON.stringify(value)).length > TRANSCRIPT_APPEND_MAX_BYTES
    )
      throw new EdgeParseError(
        "invalid_value",
        path,
        "transcript batch exceeds byte limit",
      );
    return body;
  });
}
export const parseTranscriptAppendRequest = constrainedRequest(strictRequest);
export const parseTranscriptSpoolRequest = constrainedRequest(legacyRequest);
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
