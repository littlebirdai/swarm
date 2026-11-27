import { expect, test } from "bun:test";
import {
  parseTranscriptAppendRequest,
  parseTranscriptAppendResponse,
  TRANSCRIPT_APPEND_MAX_MESSAGES,
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
