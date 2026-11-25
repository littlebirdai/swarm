import { expect, test } from "bun:test";
import { createSocketMeter } from "./ws-frame-meter.mjs";

const event = (kind, requestId, fields = {}) => ({
  method: `Network.webSocket${kind}`,
  params: { requestId, ...fields },
});
const frame = (requestId, opcode, payloadData, direction = "Received") =>
  event(`Frame${direction}`, requestId, { response: { opcode, payloadData } });
const text = (requestId, value, direction) =>
  frame(requestId, 1, JSON.stringify(value), direction);
const update = { type: "QueryUpdated", queryId: 7, value: "✓" };
const transition = { type: "Transition", modifications: [update] };
const add = {
  type: "ModifyQuerySet",
  modifications: [{ type: "Add", queryId: 7, udfPath: "syncLog:getHeads" }],
};

test("counts tracked binary, continuation, text and unparseable frame bytes", () => {
  const meter = createSocketMeter();
  meter.record(
    event("Created", "a", { url: "wss://convex.invalid/api/1/sync" }),
    false,
  );
  meter.record(frame("a", 2, "AAEC"), true);
  meter.record(frame("a", 0, "AwQ="), true);
  meter.record(frame("a", 1, '{"part":"✓'), true);
  meter.record(frame("a", 1, "garbage"), true);
  meter.record(frame("untracked", 1, "garbage"), true);
  expect(meter.snapshot()).toEqual({
    totalBytes: 24,
    frames: 4,
    byQuery: new Map(),
  });
});

test("attributes a transition completed inside the window using earlier chunks", () => {
  const meter = createSocketMeter();
  const serialized = JSON.stringify(transition);
  const part = (partNumber, chunk) =>
    text("a", {
      type: "TransitionChunk",
      transitionId: "one",
      totalParts: 2,
      partNumber,
      chunk,
    });
  meter.record(text("a", add, "Sent"), false);
  meter.record(part(0, serialized.slice(0, 40)), false);
  const last = part(1, serialized.slice(40));
  meter.record(last, true);
  expect(meter.snapshot()).toEqual({
    totalBytes: Buffer.byteLength(last.params.response.payloadData),
    frames: 1,
    byQuery: new Map([
      [
        "syncLog:getHeads",
        { bytes: Buffer.byteLength(JSON.stringify(update)), frames: 1 },
      ],
    ]),
  });
});

test("keeps unknown query IDs separate and discards closed socket state", () => {
  const meter = createSocketMeter();
  meter.record(text("a", transition), true);
  meter.record(text("b", transition), true);
  meter.record(text("a", add, "Sent"), true);
  expect(meter.openSocket()).toBeUndefined();
  meter.record(event("Closed", "a"), true);
  expect(meter.openSocket()).toBe("b");
  meter.record(frame("a", 2, "AAEC"), true);
  meter.record(text("a", transition), true);
  expect(meter.snapshot().frames).toBe(3);
  expect(
    [...meter.snapshot().byQuery].map(([key, stat]) => [key, stat.frames]),
  ).toEqual([
    ["query#a:7", 2],
    ["query#b:7", 1],
  ]);
});
