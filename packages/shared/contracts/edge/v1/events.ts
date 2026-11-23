import {
  array, count, EdgeParseError, nonEmptyString, object, oneOf, parser, positiveInteger,
  responseObject, string, tagged,
} from "./parse";
import { readV1 } from "./version";
import { response } from "./response";
import { fence } from "./claims";
import { readCanonicalEvent } from "./envelope";
import { daemon } from "./link";

const batch = object({ ...fence, events: array(readCanonicalEvent) });
const eventsAppendRequest = object({
  v: readV1,
  batches: array((value, path) => {
    const group = batch(value, path);
    if (group.events.length === 0) {
      throw new EdgeParseError("invalid_value", `${path}.events`, "expected at least one event");
    }
    for (const [index, event] of group.events.entries()) {
      const eventPath = `${path}.events[${index}]`;
      if (event.session !== group.session || event.run !== group.run) {
        throw new EdgeParseError("invalid_value", eventPath, "event must match the batch claim");
      }
      if (index > 0 && event.seq !== group.events[index - 1].seq + 1) {
        throw new EdgeParseError("invalid_value", `${eventPath}.seq`, "event seq must be contiguous");
      }
    }
    return group;
  }),
});
const result = { session: nonEmptyString };
const eventsAppendResponse = response(responseObject({
  v: readV1,
  results: array(tagged("status", {
    appended: responseObject({ ...result, status: oneOf("appended"), through_seq: positiveInteger }),
    stale: responseObject({ ...result, status: oneOf("stale") }),
    gap: responseObject({ ...result, status: oneOf("gap"), expected_seq: positiveInteger }),
    conflict: responseObject({ ...result, status: oneOf("conflict"), seq: positiveInteger }),
  })),
}));

const blobsPutRequest = object({
  v: readV1,
  ...daemon,
  content_type: nonEmptyString,
  sha256: (value, path) => {
    const digest = string(value, path);
    if (!/^[a-f0-9]{64}$/.test(digest)) {
      throw new EdgeParseError("invalid_value", path, "expected a lowercase SHA-256 hex digest");
    }
    return digest;
  },
  data_base64: (value, path) => {
    const data = string(value, path);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
      throw new EdgeParseError("invalid_value", path, "expected padded base64");
    }
    return data;
  },
});
const blobsPutResponse = response(responseObject({ v: readV1, blob_id: nonEmptyString, size_bytes: count }));

export type EventsAppendRequest = ReturnType<typeof eventsAppendRequest>;
export type EventsAppendResponse = ReturnType<typeof eventsAppendResponse>;
export type BlobsPutRequest = ReturnType<typeof blobsPutRequest>;
export type BlobsPutResponse = ReturnType<typeof blobsPutResponse>;

export const parseEventsAppendRequest = parser((value, path) => {
  const append = eventsAppendRequest(value, path);
  if (append.batches.length === 0) {
    throw new EdgeParseError("invalid_value", `${path}.batches`, "expected at least one group");
  }
  return append;
});
export const parseEventsAppendResponse = parser(eventsAppendResponse);
export const parseBlobsPutRequest = parser(blobsPutRequest);
export const parseBlobsPutResponse = parser(blobsPutResponse);
