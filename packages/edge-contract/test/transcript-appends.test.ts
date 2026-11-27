import { expect, test } from "bun:test";
import {
  parseTranscriptAppendRequest,
  parseTranscriptAppendResponse,
  TRANSCRIPT_APPEND_MAX_MESSAGES,
  TRANSCRIPT_APPEND_MAX_BYTES,
} from "../src";

const write = (conversation_id: string) => ({
  conversation_id,
  messages: [{ role: "user", content: "hello", message_uuid: "message" }],
});
const request = {
  v: 1 as const,
  batch_id: "batch-1",
  writes: [write("first"), write("second")],
};

test("parses one machine batch containing several transcripts", () => {
  expect(parseTranscriptAppendRequest(request)).toEqual({
    ok: true,
    value: request,
  });
});

test("rejects empty, malformed and oversized transcript batches", () => {
  for (const writes of [
    [],
    [{ ...write("first"), messages: [] }],
    [{ ...write("first"), messages: [{ role: "other" }] }],
    Array.from({ length: TRANSCRIPT_APPEND_MAX_MESSAGES + 1 }, () =>
      write("first"),
    ),
  ]) {
    expect(parseTranscriptAppendRequest({ ...request, writes }).ok).toBe(false);
  }
});

test("parses ordered receipts including a refused transcript", () => {
  const receipt = {
    v: 1 as const,
    batch_id: "batch-1",
    results: [
      { status: "applied" as const, inserted: 1, ids: ["message-id"] },
      { status: "refused" as const },
    ],
  };
  expect(parseTranscriptAppendResponse(receipt)).toEqual({
    ok: true,
    value: receipt,
  });
  expect(
    parseTranscriptAppendResponse({
      ...receipt,
      results: [{ status: "applied", inserted: -1, ids: [] }],
    }).ok,
  ).toBe(false);
});

test("checks message fields, nested records and encoded UTF-8 size", () => {
  const invalid = [
    { content: 7 },
    { timestamp: Infinity },
    { tool_calls: [{ id: "tool", name: "shell", input: {} }] },
    { tool_results: [{ tool_use_id: "tool", content: "", is_error: "false" }] },
    { images: [{ data: "image" }] },
    { files: [{ name: "file", media_type: "text/plain", storage_id: 4 }] },
    { usage: { input_tokens: 4 } },
    { delivery_ids: [1] },
    { extra: true },
    { content: "é".repeat(TRANSCRIPT_APPEND_MAX_BYTES / 2) },
  ];
  for (const row of invalid) {
    expect(
      parseTranscriptAppendRequest({
        ...request,
        writes: [
          {
            conversation_id: "first",
            messages: [{ role: "assistant", ...row }],
          },
        ],
      }).ok,
    ).toBe(false);
  }
});
