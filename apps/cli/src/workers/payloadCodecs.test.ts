import { PayloadBudget } from "./payloadBudget.js";
import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  ByteReceiver,
  bytePage,
  describeBytes,
  validBytePage,
  PAYLOAD_PAGE_BYTES,
} from "./payloadBytes.js";
import { PayloadValueAssembler, payloadValuePages } from "./payloadValues.js";
import { transformImageCache } from "../imageCacheCodec.js";
import { decodeImageBase64, detectImageMediaType } from "../imagePayload.js";
import { PayloadCodecCursors } from "./payloadCodecCursors.js";
import {
  validPayloadCodecPage,
  validPayloadCodecPayload,
  type PayloadCodecJob,
} from "./payloadCodecTypes.js";

test("payload budget never renews across pages or backwards clocks", () => {
  let mono = 10;
  const budget = new PayloadBudget(100, undefined, () => mono);
  mono = 50;
  expect(budget.remainingMs()).toBe(60);
  mono = 20;
  expect(budget.remainingMs()).toBe(60);
  const wall = Date.now;
  try {
    Date.now = () => -1_000_000;
    expect(budget.remainingMs()).toBe(60);
    Date.now = () => 1_000_000;
    expect(budget.remainingMs()).toBe(60);
  } finally {
    Date.now = wall;
  }
  mono = 110;
  expect(() => budget.checkpoint()).toThrow("expired");
  mono = 0;
  expect(budget.remainingMs()).toBe(0);
});

test("bounded byte pages reject corruption, missing bytes and replay", () => {
  const bytes = Buffer.alloc(PAYLOAD_PAGE_BYTES + 3, 0xf9),
    descriptor = describeBytes(bytes);
  const receiver = new ByteReceiver(descriptor);
  receiver.push(bytePage(bytes, 0));
  receiver.push(bytePage(bytes, PAYLOAD_PAGE_BYTES));
  expect(receiver.finish()).toEqual(descriptor);
  expect(() => receiver.finish()).toThrow();
  expect(() => new ByteReceiver(descriptor).finish()).toThrow("digest");
  expect(() => new ByteReceiver().push({ offset: 1, data: "AA==" })).toThrow(
    "sequence",
  );
  expect(() => new ByteReceiver().push({ offset: 0, data: "AB==" })).toThrow(
    "integrity",
  );
  expect(validBytePage({ offset: 0, data: "a".repeat(87388) })).toBe(false);
  expect(() => new ByteReceiver().push({ offset: 0, data: "" })).toThrow(
    "integrity",
  );
});

test("typed IPC preserves Unicode, own hostile keys and SDK values without whole-object serialization", async () => {
  const value = {
    text: "x".repeat(8191) + "\ud83d\ude00\ud800\udc00",
    values: [
      1n,
      -(2n ** 63n),
      NaN,
      Infinity,
      -Infinity,
      -0,
      undefined,
      new Uint8Array([0, 255]).buffer,
    ],
    nested: JSON.parse(
      '{"__proto__":{"value":1},"constructor":2,"toJSON":"data"}',
    ),
  };
  const assembler = new PayloadValueAssembler();
  for await (const page of payloadValuePages(value)) assembler.push(page);
  expect(assembler.finish()).toEqual(value);
  const invalid = new PayloadValueAssembler();
  expect(() => invalid.push([["bytes", 3], ["b", "AQI="], ["e"]])).toThrow(
    "incomplete",
  );
  const replay = new PayloadValueAssembler();
  expect(() =>
    replay.push([
      ["v", null],
      ["v", null],
    ]),
  ).toThrow("multiple");
});

test("image codec preserves sniff and base64 validation including original whitespace", () => {
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  expect(detectImageMediaType(png)).toBe("image/png");
  expect(
    decodeImageBase64(" \n" + png.toString("base64") + "\t")?.data,
  ).toEqual(png);
  for (const input of ["", "a", "AB==", "not base64", "AAAA"])
    expect(decodeImageBase64(input)).toBeNull();
});

test("cache codec retains map shape, pruning, deleted-path lookup and malformed JSON preimage default", () => {
  const initial = Buffer.from("{bad");
  const stored = transformImageCache(initial, {
    action: "store",
    hash: "h",
    absPath: "/deleted",
    storageId: "s",
    url: "u",
    at: 1,
  }) as Buffer;
  expect(transformImageCache(stored, { action: "hash", key: "h" })).toEqual({
    storageId: "s",
    url: "u",
    at: 1,
  });
  expect(
    transformImageCache(stored, { action: "path", key: "/deleted" }),
  ).toEqual({ storageId: "s", url: "u", at: 1 });
  const entries = Object.fromEntries(
    Array.from({ length: 500 }, (_, i) => [
      "h" + i,
      { storageId: "s", url: "u", at: i },
    ]),
  );
  const pruned = JSON.parse(
    (
      transformImageCache(
        Buffer.from(JSON.stringify({ byHash: entries, byPath: {} })),
        { action: "store", hash: "new", storageId: "new", url: "new", at: 501 },
      ) as Buffer
    ).toString(),
  );
  expect(Object.keys(pruned.byHash)).toHaveLength(500);
  expect(pruned.byHash.h0).toBeUndefined();
  expect(pruned.byHash.new.at).toBe(501);
});

test("codec cursor drains bounded pages and releases failed jobs", async () => {
  const cursors = new PayloadCodecCursors();
  const generation = randomUUID();
  const cursor = randomUUID();
  let sequence = 0;
  const send = async (command: Record<string, unknown>) => {
    const payload =
      command.action === "open"
        ? { ...command, generation }
        : { ...command, cursor, generation, sequence };
    assert(validPayloadCodecPayload(payload), "invalid codec test payload");
    const expectedSequence = sequence++;
    const page = await cursors.request(payload, cursor);
    expect(validPayloadCodecPage(page)).toBe(true);
    expect(page).toMatchObject({
      cursor,
      generation,
      sequence: expectedSequence,
    });
    return page;
  };
  const open = async (job: PayloadCodecJob, input: Buffer) => {
    sequence = 0;
    await send({ action: "open", job, budgetMs: 5000 });
    for (let offset = 0; offset < input.length; offset += PAYLOAD_PAGE_BYTES)
      await send({ action: "push", page: bytePage(input, offset) });
  };
  const readValue = async (input: Buffer) => {
    await send({ action: "seal", descriptor: describeBytes(input) });
    const assembler = new PayloadValueAssembler();
    for (;;) {
      const page = await send({ action: "next" });
      expect(page.stage).toBe("values");
      if (page.stage !== "values") throw new Error("missing codec value");
      assembler.push(page.tokens);
      if (page.done) break;
    }
    await send({ action: "close" });
    expect(cursors.size).toBe(0);
    return assembler.finish();
  };
  const data = Buffer.from("89504e470d0a1a0a", "hex");
  const encodedImage = Buffer.from(data.toString("base64"));
  await open(
    { kind: "image", encoding: "base64", output: "facts" },
    encodedImage,
  );
  try {
    expect(await readValue(encodedImage)).toEqual({
      mediaType: "image/png",
      length: 8,
      hash: createHash("sha256").update(data).digest("hex"),
    });

    const emptyCache = Buffer.from("{}");
    const store: PayloadCodecJob = {
      kind: "cache",
      operation: {
        action: "store",
        hash: "h",
        storageId: "s",
        url: "u",
        at: 1,
      },
    };
    await open(store, emptyCache);
    const output = await send({
      action: "seal",
      descriptor: describeBytes(emptyCache),
    });
    assert(output.stage === "descriptor", "missing cache descriptor");
    const bytes = await send({ action: "next" });
    assert(bytes.stage === "bytes", "missing cache bytes");
    const receiver = new ByteReceiver(output.descriptor);
    const storedCache = receiver.push(bytes.page);
    expect(bytes.done).toBe(true);
    expect(receiver.finish()).toEqual(output.descriptor);
    expect(
      transformImageCache(storedCache, { action: "hash", key: "h" }),
    ).toEqual({
      storageId: "s",
      url: "u",
      at: 1,
    });
    await send({ action: "close" });
    expect(cursors.size).toBe(0);

    await open(store, emptyCache);
    await expect(
      send({ action: "seal", descriptor: describeBytes(Buffer.from("[]")) }),
    ).rejects.toThrow("digest");
    expect(cursors.size).toBe(0);

    await open(
      { kind: "cache", operation: { action: "hash", key: "none" } },
      emptyCache,
    );
    expect(await readValue(emptyCache)).toBeNull();
  } finally {
    if (cursors.size) await send({ action: "close" });
  }
});
