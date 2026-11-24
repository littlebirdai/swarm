import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  makeVerifier,
  registerAuthRequest,
  startRelayPoller,
} from "./authRelay.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("registered requests", () => {
  test("every claim carries the verifier, which hashes to what was registered", async () => {
    const { verifier, verifierHash } = makeVerifier();
    expect(createHash("sha256").update(verifier).digest("hex")).toBe(
      verifierHash,
    );

    const bodies: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      bodies.push({ url, body: JSON.parse(String(init.body)) });
      return url.endsWith("/cli/auth-request")
        ? Response.json({ ok: true })
        : Response.json({ user_id: "users:1", auth_token: "tok" });
    }) as unknown as typeof fetch;
    expect(
      await registerAuthRequest("https://c.example", {
        nonce: "n0nce",
        verifierHash,
        deviceName: "mini",
      }),
    ).toBe(true);
    const poller = startRelayPoller("https://c.example", "n0nce", { verifier });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("no relay claim")), 10_000);
    });
    try {
      await Promise.race([poller.promise, deadline]);
    } finally {
      clearTimeout(timer);
      poller.stop();
    }

    expect(bodies).toEqual([
      {
        url: "https://c.example/cli/auth-request",
        body: {
          nonce: "n0nce",
          verifier_hash: verifierHash,
          device_name: "mini",
        },
      },
      {
        url: "https://c.example/cli/claim-auth",
        body: { nonce: "n0nce", verifier },
      },
    ]);
  }, 15_000);

  test("a backend without registration leaves sign-in on the legacy path", async () => {
    const req = { nonce: "n", verifierHash: "h", deviceName: "d" };
    globalThis.fetch = (async () =>
      new Response(null, { status: 404 })) as unknown as typeof fetch;
    expect(await registerAuthRequest("https://c.example", req)).toBe(false);
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await registerAuthRequest("https://c.example", req)).toBe(false);
  });
});
