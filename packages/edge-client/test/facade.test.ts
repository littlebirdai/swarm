import { expect, spyOn, test } from "bun:test";
import { mock } from "node:test";
import claimFixture from "../../edge-contract/test/fixtures/claim.json";
import heartbeatFixture from "../../edge-contract/test/fixtures/heartbeat.json";
import helloFixture from "../../edge-contract/test/fixtures/hello.json";
import releaseFixture from "../../edge-contract/test/fixtures/release.json";
import {
  createEdgeClient,
  createHttpEdgeTransport,
  EdgeTransportError,
  type ClaimLoss,
  type EdgeRequests,
} from "../src";
import { reply, scriptedTransport, type Step } from "./scripted-transport";

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

test("HTTP transport posts a JSON envelope and forwards the fetch signal", async () => {
  const response = Response.json(helloFixture.response, {
    headers: { "retry-after": "2" },
  });
  const fetchCall = spyOn(globalThis, "fetch").mockResolvedValue(response);
  try {
    const transport = createHttpEdgeTransport("https://example.test/edge/v1", {
      authorization: "Bearer fixture",
    });
    const { signal } = new AbortController();
    expect(await transport("hello", helloFixture.request, signal)).toEqual({
      status: 200,
      body: helloFixture.response,
      retryAfterHeader: "2",
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

for (const stop of ["abort", "loss", "close"] as const) {
  test(`${stop} waits for async work teardown before release and completion`, async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const working = Promise.withResolvers<void>();
    const stopping = Promise.withResolvers<void>();
    const teardown = Promise.withResolvers<void>();
    const renewing = Promise.withResolvers<void>();
    const released = Promise.withResolvers<{ status: number; body: unknown }>();
    const releaseStarted = Promise.withResolvers<void>();
    const release: Step = () => {
      releaseStarted.resolve();
      return released.promise;
    };
    const renew: Step = () => {
      renewing.resolve();
      return stop === "loss"
        ? Promise.resolve({ status: 409, body: { v: 1, status: "stale" } })
        : new Promise(() => {});
    };
    const { calls, transport } = scriptedTransport(
      reply({ ...claimFixture.response, lease_ms: 1_000 }),
      ...(stop === "abort" ? [release] : [renew, release]),
    );
    const client = createEdgeClient({ transport });
    const controller = new AbortController();
    try {
      let completed = false;
      const held = client
        .withClaim(
          claimRequest,
          async (_, signal) => {
            signal.addEventListener("abort", () => stopping.resolve(), {
              once: true,
            });
            working.resolve();
            await teardown.promise;
          },
          controller.signal,
        )
        .then((result) => {
          completed = true;
          return result;
        });
      await working.promise;
      if (stop !== "abort") {
        mock.timers.tick(600);
        await renewing.promise;
      }
      if (stop === "abort") controller.abort();
      let closed = false;
      const closing =
        stop === "close"
          ? client.close().then(() => {
              closed = true;
            })
          : undefined;
      await stopping.promise;
      const duplicate = await client.withClaim(
        claimRequest,
        async () => "duplicate",
      );
      expect(duplicate).toMatchObject({
        ok: false,
        error:
          stop === "close"
            ? { kind: "closed" }
            : { kind: "claim_lost", reason: "already_held" },
      });
      expect(completed).toBe(false);
      expect(closed).toBe(false);
      expect(calls.map(({ operation }) => operation)).toEqual(
        stop === "abort" ? ["claim"] : ["claim", "renew"],
      );
      if (stop === "close") expect(calls[1]?.signal.aborted).toBe(true);

      teardown.resolve();
      if (stop !== "loss") {
        await releaseStarted.promise;
        expect(calls.at(-1)?.request).toEqual({
          ...releaseFixture.request,
          v: 1,
        });
        expect(calls.at(-1)?.signal.aborted).toBe(false);
        expect(completed).toBe(false);
        released.resolve({ status: 200, body: releaseFixture.response });
      }
      const result = await held;
      expect(result).toMatchObject({
        ok: false,
        error:
          stop === "loss"
            ? { kind: "claim_lost", operation: "renew", reason: "stale" }
            : { kind: stop === "close" ? "closed" : "aborted" },
      });
      if (result.ok) throw new Error("expected an interrupted claim");
      expect(result.error.stack).toMatch(/facade\.test\.ts:\d+/);
      if (stop === "loss") {
        const reason: ClaimLoss = "stale";
        expect(result.error).toMatchObject({ reason });
        expect(calls).toHaveLength(2);
      }
      await closing;
    } finally {
      teardown.resolve();
      released.resolve({ status: 200, body: releaseFixture.response });
      await client.close();
      mock.timers.reset();
    }
  }, 500);
}

test("an abort before close keeps its outcome and its caller frame", async () => {
  const began = Promise.withResolvers<void>();
  const settling = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  const controller = new AbortController();
  const { transport } = scriptedTransport(
    reply(claimFixture.response),
    reply(releaseFixture.response),
  );
  const client = createEdgeClient({ transport });
  try {
    const held = client.withClaim(
      claimRequest,
      async (_, signal) => {
        signal.addEventListener("abort", () => stopped.resolve(), {
          once: true,
        });
        began.resolve();
        await settling.promise;
      },
      controller.signal,
    );
    await began.promise;
    controller.abort();
    await stopped.promise;
    const closing = client.close();
    settling.resolve();
    expect(await held).toMatchObject({
      ok: false,
      error: {
        kind: "aborted",
        stack: expect.stringMatching(/facade\.test\.ts:\d+/),
      },
    });
    await closing;
  } finally {
    settling.resolve();
    await client.close();
  }
});

test("a synchronous abort inside an already warm transport interrupts the call", async () => {
  const controller = new AbortController();
  const { transport, calls } = scriptedTransport(
    reply(helloFixture.response),
    () => {
      controller.abort();
      return new Promise(() => {});
    },
  );
  const client = createEdgeClient({ transport });
  try {
    expect((await client.hello(helloFixture.request)).ok).toBe(true);
    expect(
      await client.hello(helloFixture.request, controller.signal),
    ).toMatchObject({
      ok: false,
      error: { kind: "aborted" },
    });
    expect(calls[1]?.signal.aborted).toBe(true);
  } finally {
    await client.close();
  }
}, 250);

test("a rejecting work callback surfaces its error and releases the lease", async () => {
  const error = new Error("work failed");
  const { calls, transport } = scriptedTransport(
    reply(claimFixture.response),
    reply(releaseFixture.response),
  );
  const client = createEdgeClient({ transport });
  try {
    await expect(
      client.withClaim(claimRequest, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(calls.map(({ operation }) => operation)).toEqual([
      "claim",
      "release",
    ]);
  } finally {
    await client.close();
  }
});

test("every Promise method reports its caller file and line on failure", async () => {
  const { transport } = scriptedTransport(
    reply({ status: "ok", version: 1 }),
    reply({ v: 1 }),
    reply({ v: 1 }),
    reply({ v: 1, status: "stale" }, 409),
    reply({ v: 1 }),
    reply({ v: 1, status: "stale" }, 409),
  );
  const client = createEdgeClient({ transport });
  const fence = { ...releaseFixture.request, v: 1 as const };
  try {
    const results = [
      await client.hello(helloFixture.request),
      await client.heartbeat({ ...heartbeatFixture.request, v: 1 }),
      await client.claim(claimRequest),
      await client.renew(fence),
      await client.release(fence),
      await client.withClaim(claimRequest, async () => "unexpected work"),
    ];
    for (const result of results) {
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected a failure");
      expect(result.error.stack).toMatch(/facade\.test\.ts:\d+/);
    }
    const hello = results[0];
    expect(hello).toMatchObject({
      ok: false,
      error: {
        kind: "parse",
        operation: "hello",
        code: "missing_field",
        path: "$.policy",
      },
    });
    if (hello && !hello.ok) {
      expect(hello.error.stack).toContain("at edgeClient.hello");
      expect(hello.error.stack).toContain("at edgeClient.request");
    }
  } finally {
    await client.close();
  }
});

test("facade preserves a network cause and rejects a transport defect", async () => {
  const cause = new TypeError("socket closed");
  const defect = new TypeError("invalid transport implementation");
  const { transport, calls } = scriptedTransport(
    async () => {
      throw new EdgeTransportError(cause);
    },
    async () => {
      throw defect;
    },
  );
  const client = createEdgeClient({ transport });
  try {
    const result = await client.heartbeat({
      ...heartbeatFixture.request,
      v: 1,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "unavailable", code: "network" },
    });
    if (result.ok) throw new Error("expected network failure");
    expect(result.error.cause).toBe(cause);
    await expect(client.hello(helloFixture.request)).rejects.toBe(defect);
    expect(calls).toHaveLength(2);
  } finally {
    await client.close();
  }
});

test("a transport defect during the release of an aborted claim is rejected", async () => {
  const began = Promise.withResolvers<void>();
  const defect = new ReferenceError("release transport defect");
  const controller = new AbortController();
  const { transport, calls } = scriptedTransport(
    reply(claimFixture.response),
    async () => {
      throw defect;
    },
  );
  const client = createEdgeClient({ transport });
  try {
    const held = client.withClaim(
      claimRequest,
      (_, signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
          began.resolve();
        }),
      controller.signal,
    );
    await began.promise;
    controller.abort();
    await expect(held).rejects.toBe(defect);
    expect(calls.map(({ operation }) => operation)).toContain("release");
  } finally {
    await client.close();
  }
});

test("a rejecting work callback surfaces its error when the client closes", async () => {
  const error = new Error("work failed");
  const releasing = Promise.withResolvers<void>();
  const released = Promise.withResolvers<{ status: number; body: unknown }>();
  const { transport } = scriptedTransport(reply(claimFixture.response), () => {
    releasing.resolve();
    return released.promise;
  });
  const client = createEdgeClient({ transport });
  const held = client.withClaim(claimRequest, async () => {
    throw error;
  });
  const outcome = held.catch((reason: unknown) => reason);
  await releasing.promise;
  const closing = client.close();
  released.resolve({ status: 200, body: releaseFixture.response });
  expect(await outcome).toBe(error);
  await closing;
});
