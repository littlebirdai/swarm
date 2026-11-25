import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { writeSync } from "node:fs";
import { MessagesSdkResponse } from "./messagesSdkResponse.js";
import { MessagesSdkCursors } from "./messagesSdkCursors.js";
import {
  ByteReceiver,
  bytePage,
  describeBytes,
  PAYLOAD_PAGE_BYTES,
} from "./payloadBytes.js";
import { ingestTokenPages } from "./ingestTransport.js";
import { PayloadValueAssembler } from "./payloadValues.js";
import {
  validMessagesSdkPage,
  validMessagesSdkPayload,
} from "./messagesSdkTypes.js";

const emit = (row: unknown) => writeSync(1, JSON.stringify(row) + "\n");
const observe = async (run: () => Promise<unknown>) => {
  try {
    return { kind: "success", value: await run() };
  } catch (error) {
    return {
      kind: "error",
      constructor: error instanceof Error ? error.constructor.name : null,
      name: error instanceof Error ? error.name : null,
      message: error instanceof Error ? error.message : String(error),
    };
  }
};
const adapt = (bytes: Buffer, status: number) => {
  const response = new MessagesSdkResponse(
    status,
    ![204, 205, 304].includes(status),
  );
  for (let offset = 0; offset < bytes.length; offset++)
    response.push({
      offset,
      data: bytes.subarray(offset, offset + 1).toString("base64"),
    });
  return response.finish(describeBytes(bytes), () => {});
};

test("SDK response adapter matches genuine HTTP JSON and text, including empty statuses", async () => {
  const cases = [
    ...[200, 204, 205, 304, 401, 560].map((status) => ({
      name: `empty-${status}`,
      status,
      bytes: Buffer.alloc(0),
    })),
    {
      name: "valid",
      status: 200,
      bytes: Buffer.from('{"value":"😀","escaped":"\\ud800"}'),
    },
    { name: "malformed", status: 200, bytes: Buffer.from("{bad") },
    {
      name: "invalid-utf8",
      status: 200,
      bytes: Buffer.from([0x22, 0xff, 0x22]),
    },
    {
      name: "truncated-utf8",
      status: 200,
      bytes: Buffer.from([0x22, 0xf0, 0x9f, 0x22]),
    },
    { name: "unquoted-utf8", status: 200, bytes: Buffer.from([0xff]) },
    {
      name: "bom",
      status: 200,
      bytes: Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]),
    },
  ];
  const server = createServer((req, res) => {
    const row = cases[Number(req.url?.slice(1))];
    res.writeHead(row.status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": String(row.bytes.length),
    });
    res.end(row.bytes);
  });
  const comparisons: Array<{
    name: string;
    before: unknown;
    after: unknown;
    bytes: Buffer;
    expected: Buffer;
    status: number;
    expectedStatus: number;
  }> = [];
  let port = 0;
  try {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    port = (server.address() as { port: number }).port;
    emit({
      event: "start",
      pid: process.pid,
      executable: process.execPath,
      runtime: process.versions,
      port,
    });
    for (let index = 0; index < cases.length; index++) {
      const row = cases[index],
        url = `http://127.0.0.1:${port}/${index}`;
      const bytes = Buffer.from(await (await fetch(url)).arrayBuffer());
      for (const method of ["json", "text"] as const) {
        const http = await fetch(url),
          adapted = adapt(bytes, row.status);
        const before = await observe(() => http[method]()),
          after = await observe(() => adapted[method]());
        emit({
          event: "comparison",
          case: row.name,
          method,
          descriptor: describeBytes(bytes),
          bytes: [...bytes],
          before,
          after,
          status: adapted.status,
        });
        comparisons.push({
          name: `${row.name}-${method}`,
          before,
          after,
          bytes,
          expected: row.bytes,
          status: adapted.status,
          expectedStatus: http.status,
        });
      }
    }
    for (const row of comparisons) {
      expect(row.bytes, row.name).toEqual(row.expected);
      expect(row.after, row.name).toEqual(row.before);
      expect(row.status, row.name).toBe(row.expectedStatus);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    emit({
      event: "cleanup",
      pid: process.pid,
      port,
      listening: server.listening,
      comparisons: comparisons.length,
    });
  }
});

test("SDK response buffering refuses missing bytes, corrupt digest, close and expired budget", async () => {
  const bytes = Buffer.alloc(PAYLOAD_PAGE_BYTES + 3, 0x20),
    descriptor = describeBytes(bytes);
  const good = new MessagesSdkResponse(200, true);
  for (let offset = 0; offset < bytes.length; offset++)
    good.push({
      offset,
      data: bytes.subarray(offset, offset + 1).toString("base64"),
    });
  expect(
    Buffer.from(await good.finish(descriptor, () => {}).arrayBuffer()),
  ).toEqual(bytes);
  expect(() => good.finish(descriptor, () => {})).toThrow();
  const missing = new MessagesSdkResponse(200, true);
  missing.push(bytePage(bytes, 0));
  expect(() => missing.finish(descriptor, () => {})).toThrow("digest");
  expect(() =>
    missing.finish(
      describeBytes(bytes.subarray(0, PAYLOAD_PAGE_BYTES)),
      () => {},
    ),
  ).toThrow("not open");
  const corrupt = new MessagesSdkResponse(200, true);
  corrupt.push(bytePage(Buffer.from("x"), 0));
  expect(() =>
    corrupt.finish(describeBytes(Buffer.from("y")), () => {}),
  ).toThrow("digest");
  const closed = new MessagesSdkResponse(200, true);
  closed.close();
  expect(() => closed.finish(describeBytes(Buffer.alloc(0)), () => {})).toThrow(
    "not open",
  );
  const expired = new MessagesSdkResponse(200, true);
  expect(() =>
    expired.finish(describeBytes(Buffer.alloc(0)), () => {
      throw new Error("owned expired budget");
    }),
  ).toThrow("owned expired budget");
  const nullBody = new MessagesSdkResponse(204, false);
  expect(() => nullBody.push(bytePage(Buffer.from("x"), 0))).toThrow(
    "not open",
  );
  expect(() =>
    nullBody.finish(describeBytes(Buffer.alloc(0)), () => {}),
  ).toThrow("not open");
});

test("bodyless statuses allow stream presence but refuse nonzero bytes at verified EOF", () => {
  const empty = describeBytes(Buffer.alloc(0)),
    nonempty = Buffer.from("x");
  const address = {
    action: "responseStart",
    cursor: "status-test",
    generation: "status-test",
    sequence: 1,
  };
  for (const status of [204, 205, 304]) {
    for (const body of [false, true]) {
      expect(validMessagesSdkPayload({ ...address, status, body })).toBe(true);
      expect(
        new MessagesSdkResponse(status, body).finish(empty, () => {}).status,
      ).toBe(status);
    }
    const response = new MessagesSdkResponse(status, true);
    response.push(bytePage(nonempty, 0));
    expect(() => response.finish(describeBytes(nonempty), () => {})).toThrow(
      "status forbids bytes",
    );
    expect(() => response.finish(empty, () => {})).toThrow("not open");
    const invalidDigest = new MessagesSdkResponse(status, true);
    expect(() =>
      invalidDigest.finish(describeBytes(nonempty), () => {}),
    ).toThrow("digest");
  }
  for (const status of [null, "204", 199, 204.5, 600, Infinity])
    expect(validMessagesSdkPayload({ ...address, status, body: true })).toBe(
      false,
    );
  for (const body of [null, "true", 1, {}])
    expect(validMessagesSdkPayload({ ...address, status: 204, body })).toBe(
      false,
    );
  expect(
    validMessagesSdkPayload({ ...address, status: 204, body: true, extra: 1 }),
  ).toBe(false);
});

const conversationId = "synthetic";
const apiToken = "synthetic-only";
const receipt = {
  plan: "response-plan",
  attempt: "response-attempt",
  workerGeneration: 1,
  messageCount: 0,
};

async function openMessagesCursor() {
  const cursors = new MessagesSdkCursors();
  const cursor = randomUUID();
  const generation = randomUUID();
  let sequence = 0;
  const send = async (command: Record<string, unknown>) => {
    const payload =
      command.action === "open"
        ? { ...command, generation }
        : { ...command, cursor, generation, sequence };
    if (!validMessagesSdkPayload(payload))
      throw new Error("invalid messages SDK request");
    sequence++;
    const page = await cursors.request(payload, cursor);
    expect(validMessagesSdkPage(page)).toBe(true);
    return page;
  };
  await send({
    action: "open",
    conversationId,
    messageCount: 0,
    budgetMs: 5000,
  });
  for await (const tokens of ingestTokenPages({ messages: [], bytes: [] }))
    await send({ action: "push", tokens });
  const sealed = await send({ action: "seal" });
  return { cursors, send, sealed };
}

test("the SDK wire validator refuses a response body flag that is not a boolean", () => {
  const address = {
    cursor: randomUUID(),
    generation: randomUUID(),
    sequence: 1,
  };
  const command = { ...address, action: "responseStart", status: 200 };
  expect(validMessagesSdkPayload({ ...command, body: true })).toBe(true);
  expect(validMessagesSdkPayload({ ...command, body: "invalid" })).toBe(false);
});

test("the SDK cursor returns the receipt before the paged result and logs", async () => {
  const value = { inserted: 0, ids: [] };
  const logLines = Array.from(
    { length: 40 },
    (_, index) => `[INFO] ${index} ${"x".repeat(8192)}`,
  );
  const response = JSON.stringify({ status: "success", value, logLines });
  const logs: unknown[] = [];
  let expectedRequest = "";
  const sdk = new ConvexHttpClient("http://127.0.0.1:0", {
    skipConvexDeploymentUrlCheck: true,
    fetch: (async (_url, init) => {
      if (typeof init?.body !== "string")
        throw new Error("missing SDK request body");
      expectedRequest = init.body;
      return new Response(response);
    }) as typeof fetch,
    logger: {
      log: (...args: unknown[]) => logs.push({ method: "log", args }),
      warn: () => {},
      error: () => {},
      logVerbose: () => {},
    },
  });
  const directResult = await sdk.mutation(
    makeFunctionReference<"mutation">("messages:addMessages"),
    { conversation_id: conversationId, messages: [], api_token: apiToken },
    { skipQueue: true },
  );
  const { cursors, send } = await openMessagesCursor();
  try {
    const capture = await send({ action: "begin", apiToken, receipt });
    if (capture.stage !== "capture") throw new Error("missing SDK capture");
    const requestBytes = new ByteReceiver(capture.capture);
    const request: Buffer[] = [];
    for (;;) {
      const page = await send({ action: "requestNext" });
      if (page.stage !== "bytes") throw new Error("missing SDK request bytes");
      request.push(requestBytes.push(page.page));
      if (page.done) break;
    }
    requestBytes.finish();
    expect(Buffer.concat(request).toString()).toBe(expectedRequest);

    const outcome = send({ action: "waitOutcome" });
    const responseBytes = Buffer.from(response);
    await send({ action: "responseStart", status: 200, body: true });
    for (let offset = 0; offset < responseBytes.length; offset += 40_000)
      await send({
        action: "responsePush",
        page: bytePage(responseBytes.subarray(0, offset + 40_000), offset),
      });
    await send({
      action: "responseEnd",
      descriptor: describeBytes(responseBytes),
    });
    const accepted = await outcome;
    expect(accepted).toMatchObject({ stage: "outcome", receipt });

    const assembler = new PayloadValueAssembler();
    let valuePages = 0;
    for (;;) {
      const page = await send({ action: "outcomeNext" });
      if (page.stage !== "values") throw new Error("missing SDK outcome value");
      assembler.push(page.tokens);
      if (page.done) break;
      valuePages++;
    }
    expect(valuePages).toBeGreaterThan(1);
    expect(assembler.finish()).toEqual({
      kind: "success",
      value: directResult,
      logs,
    });
  } finally {
    if (cursors.size) await send({ action: "close" });
    expect(cursors.size).toBe(0);
  }
});

for (const failure of ["missing-eof", "bad-digest", "network-abort"] as const)
  test(`actual SDK remains unsettled before verified EOF: ${failure}`, async () => {
    const { cursors, send } = await openMessagesCursor();
    try {
      await send({ action: "begin", apiToken, receipt });
      let settled = false;
      const waiter = send({ action: "waitOutcome" }).then(
        (value) => {
          settled = true;
          return { value };
        },
        (error) => {
          settled = true;
          return { error };
        },
      );
      await send({ action: "responseStart", status: 200, body: true });
      const bytes = Buffer.from(
        '{"status":"success","value":null,"logLines":[]}',
      );
      await send({ action: "responsePush", page: bytePage(bytes, 0) });
      await new Promise<void>((resolve) => setImmediate(resolve));
      emit({
        event: "before-eof",
        failure,
        settled,
        retainedCursors: cursors.size,
        descriptor: describeBytes(bytes),
      });
      expect(settled).toBe(false);
      if (failure === "bad-digest")
        await expect(
          send({
            action: "responseEnd",
            descriptor: describeBytes(Buffer.from("different")),
          }),
        ).rejects.toThrow("digest");
      else
        await send(
          failure === "network-abort"
            ? { action: "networkError", reference: "owned-network-error" }
            : { action: "close" },
        );
      const result = await waiter;
      emit({
        event: "after-refusal",
        failure,
        result: "error" in result ? { error: String(result.error) } : result,
        retainedCursors: cursors.size,
      });
      if (failure === "network-abort") {
        expect("value" in result).toBe(true);
        const assembler = new PayloadValueAssembler();
        for (;;) {
          const page = await send({ action: "outcomeNext" });
          expect(page.stage).toBe("values");
          if (page.stage !== "values") throw new Error("missing SDK outcome");
          assembler.push(page.tokens);
          if (page.done) break;
        }
        expect(assembler.finish()).toEqual({
          kind: "network",
          reference: "owned-network-error",
          logs: [],
        });
      } else expect("error" in result).toBe(true);
    } finally {
      if (cursors.size) await send({ action: "close" });
      expect(cursors.size).toBe(0);
    }
  });
