import { array, count, EdgeParseError, nonEmptyString, object, oneOf, parser, positiveInteger, string, tagged } from "./parse";
import { readV1 } from "./version";
import { fence } from "./claims";
import { readCanonicalEvent } from "./envelope";
import { daemon } from "./link";

const appendBatch = object({ v: readV1, ...fence, events: array(readCanonicalEvent) });
const eventsAppendResponse = tagged("status", {
  appended: object({ v: readV1, status: oneOf("appended"), through_seq: positiveInteger }),
  stale: object({ v: readV1, status: oneOf("stale") }),
});

const blobsPutRequest = object({
  v: readV1,
  ...daemon,
  content_type: nonEmptyString,
  data_base64: (value: unknown, path: string) => {
    const data = string(value, path);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
      throw new EdgeParseError("invalid_value", path, "expected padded base64");
    }
    return data;
  },
});
const blobsPutResponse = object({ v: readV1, blob_id: nonEmptyString, size_bytes: count });

export type EventsAppendRequest = ReturnType<typeof appendBatch>;
export type EventsAppendResponse = ReturnType<typeof eventsAppendResponse>;
export type BlobsPutRequest = ReturnType<typeof blobsPutRequest>;
export type BlobsPutResponse = ReturnType<typeof blobsPutResponse>;

export const parseEventsAppendRequest = parser((value, path) => {
  const batch = appendBatch(value, path);
  if (batch.events.length === 0) {
    throw new EdgeParseError("invalid_value", `${path}.events`, "expected at least one event");
  }
  let previousSeq = 0;
  for (const [index, event] of batch.events.entries()) {
    const eventPath = `${path}.events[${index}]`;
    if (event.session !== batch.session || event.run !== batch.run) {
      throw new EdgeParseError("invalid_value", eventPath, "event must match the batch claim");
    }
    if (event.seq <= previousSeq) {
      throw new EdgeParseError("invalid_value", `${eventPath}.seq`, "event seq must increase within a batch");
    }
    previousSeq = event.seq;
  }
  return batch;
});
export const parseEventsAppendResponse = parser(eventsAppendResponse);
export const parseBlobsPutRequest = parser(blobsPutRequest);
export const parseBlobsPutResponse = parser(blobsPutResponse);
