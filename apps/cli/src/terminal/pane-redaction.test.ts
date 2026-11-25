import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vaultRedactionSource } from "../secrets/redaction-source.js";
import { KnownValueStore } from "../known-value-redaction.js";

test("known-value readiness requires a successful refresh and allows one transient failure for up to 90 seconds", async () => {
  const folder = mkdtempSync(join(tmpdir(), "terminal-redaction-"));
  let status = 503;
  const clock = spyOn(Date, "now").mockReturnValue(100);
  const store = new KnownValueStore({
    home: folder,
    configDir: folder,
    env: () => ({}),
    vault: vaultRedactionSource({
      endpoint: () => ({
        siteUrl: "http://test.invalid",
        apiToken: "test-only",
      }),
      fetch: (async (url) =>
        status === 200
          ? Response.json(
              String(url).endsWith("-values")
                ? { version: "v1", values: [] }
                : { version: "v1" },
            )
          : new Response(null, { status })) as typeof fetch,
    }),
  });
  try {
    expect(store.readyForTerminal()).toBe(false);
    expect(await store.refreshVault()).toBe(false);
    status = 200;
    expect(await store.refreshVault()).toBe(true);
    clock.mockReturnValue(70_100);
    status = 503;
    expect(await store.refreshVault()).toBe(true);
    clock.mockReturnValue(90_100);
    expect(store.readyForTerminal()).toBe(false);
    status = 200;
    expect(await store.refreshVault()).toBe(true);
    status = 503;
    expect(await store.refreshVault()).toBe(true);
    expect(await store.refreshVault()).toBe(false);
    status = 200;
    expect(await store.refreshVault()).toBe(true);
    status = 403;
    expect(await store.refreshVault()).toBe(false);
  } finally {
    store.stop();
    clock.mockRestore();
    rmSync(folder, { recursive: true, force: true });
  }
});

const opaque = ["synthetic", "value", "for", "tests"].join("-");
test("without a Vault source the local matcher decides readiness", async () => {
  const folder = mkdtempSync(join(tmpdir(), "terminal-local-redaction-"));
  const store = new KnownValueStore({
    home: folder,
    configDir: folder,
    env: () => ({}),
  });
  try {
    expect(store.readyForTerminal()).toBe(false);
    expect(await store.refreshVault()).toBe(true);
  } finally {
    store.stop();
    rmSync(folder, { recursive: true, force: true });
  }
});

test.each(["sign-out", "account switch", "site switch"] as const)(
  "a %s during a Vault poll discards the late values",
  async (change) => {
    const arrived = Promise.withResolvers<void>();
    const release = Promise.withResolvers<Response>();
    let endpoint: { siteUrl: string; apiToken: string } | null = {
      siteUrl: "https://vault.test",
      apiToken: "sample-a",
    };
    const source = vaultRedactionSource({
      endpoint: () => endpoint,
      fetch: (async (url) => {
        if (String(url).endsWith("-version"))
          return Response.json({ version: "revision" });
        arrived.resolve();
        return release.promise;
      }) as typeof fetch,
    });
    const original = endpoint;
    const pending = source.refresh();
    await arrived.promise;
    endpoint =
      change === "sign-out"
        ? null
        : {
            siteUrl:
              change === "site switch"
                ? "https://other.test"
                : endpoint!.siteUrl,
            apiToken:
              change === "account switch" ? "sample-b" : endpoint!.apiToken,
          };
    release.resolve(
      Response.json({ values: [{ name: "example", value: opaque }] }),
    );
    await pending;
    expect(source.ready()).toBe(false);
    expect(source.values()).toEqual([]);
    endpoint = original;
    expect(source.ready()).toBe(false);
    expect(source.values()).toEqual([]);
  },
);
