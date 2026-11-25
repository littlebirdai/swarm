import { expect, spyOn, test } from "bun:test";
import { mock } from "node:test";
import claimFixture from "../../edge-contract/test/fixtures/claim.json";
import helloFixture from "../../edge-contract/test/fixtures/hello.json";
import releaseFixture from "../../edge-contract/test/fixtures/release.json";
import {
  createEdgeClient,
  createHttpEdgeTransport,
  type EdgeRequests,
} from "../src";
import { reply, scriptedTransport } from "./scripted-transport";

const claimRequest = {
  ...claimFixture.request,
  v: 1,
} satisfies EdgeRequests["claim"];

test("a pre-aborted call skips transport and an in-flight abort reaches transport", async () => {
  const started = Promise.withResolvers<void>();
  const { transport, calls } = scriptedTransport(() => {
    started.resolve();
    return new Promise(() => {});
  });
  const client = createEdgeClient({ transport });
  try {
    const controller = new AbortController();
    const before = await client.hello(
      helloFixture.request,
      AbortSignal.abort(),
    );
    expect(before).toMatchObject({ ok: false, error: { kind: "aborted" } });
    expect(calls).toHaveLength(0);
    const pending = client.hello(helloFixture.request, controller.signal);
    await started.promise;
    controller.abort();
    expect(await pending).toMatchObject({
      ok: false,
      error: { kind: "aborted" },
    });
    expect(calls[0]?.signal.aborted).toBe(true);
  } finally {
    await client.close();
  }
});

test("close interrupts a scoped renew and work, then waits for fenced release", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const working = Promise.withResolvers<AbortSignal>();
  const renewing = Promise.withResolvers<void>();
  const releasing = Promise.withResolvers<void>();
  const released = Promise.withResolvers<{ status: number; body: unknown }>();
  const { transport, calls } = scriptedTransport(
    async () => ({
      status: 200,
      body: { ...claimFixture.response, expires_at: Date.now() + 1_000 },
    }),
    () => {
      renewing.resolve();
      return new Promise(() => {});
    },
    () => {
      releasing.resolve();
      return released.promise;
    },
  );
  const client = createEdgeClient({ transport });
  try {
    const held = client.withClaim(
      claimRequest,
      { maxServerClockLeadMs: 0 },
      (_, signal) => {
        working.resolve(signal);
        return new Promise(() => {});
      },
    );
    const workSignal = await working.promise;
    mock.timers.tick(600);
    await renewing.promise;
    const closing = client.close();
    expect(client.close()).toBe(closing);
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await releasing.promise;
    expect(calls[1]?.signal.aborted).toBe(true);
    expect(workSignal.aborted).toBe(true);
    expect(calls[2]?.signal.aborted).toBe(false);
    expect(calls[2]?.request).toEqual({ ...releaseFixture.request, v: 1 });
    expect(closed).toBe(false);
    released.resolve({ status: 200, body: releaseFixture.response });
    await closing;
    expect(await held).toMatchObject({ ok: false, error: { kind: "closed" } });
    expect(await client.hello(helloFixture.request)).toMatchObject({
      ok: false,
      error: { kind: "closed" },
    });
  } finally {
    released.resolve({ status: 200, body: releaseFixture.response });
    await client.close();
    mock.timers.reset();
  }
}, 500);

test("an async failure gives the plain caller the named service and request frames", async () => {
  const { transport } = scriptedTransport(reply({ status: "ok", version: 1 }));
  const client = createEdgeClient({ transport });
  try {
    const result = await client.hello(helloFixture.request);
    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "parse",
        operation: "hello",
        code: "missing_field",
        path: "$.policy",
      },
    });
    if (result.ok) throw new Error("expected a parse failure");
    expect(result.error.stack).toContain("at edgeClient.hello");
    expect(result.error.stack).toContain("at edgeClient.request");
  } finally {
    await client.close();
  }
});

test("HTTP transport posts a JSON envelope and forwards the fetch signal", async () => {
  const response = Response.json(helloFixture.response);
  const fetchCall = spyOn(globalThis, "fetch").mockResolvedValue(response);
  try {
    const transport = createHttpEdgeTransport("https://example.test/edge/v1", {
      authorization: "Bearer fixture",
    });
    const { signal } = new AbortController();
    expect(await transport("hello", helloFixture.request, signal)).toEqual({
      status: 200,
      body: helloFixture.response,
    });
    const [url, init] = fetchCall.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://example.test/edge/v1/hello");
    expect(init).toMatchObject({
      method: "POST",
      body: JSON.stringify(helloFixture.request),
      redirect: "error",
    });
    expect(init?.signal).toBe(signal);
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer fixture",
    );
    expect(new Headers(init?.headers).get("content-type")).toBe(
      "application/json",
    );
  } finally {
    fetchCall.mockRestore();
  }
});
