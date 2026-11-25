import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vaultRedactionSource } from "../secrets/redaction-source.js";
import {
  KnownValueStore,
  setKnownValuesForTest,
} from "../known-value-redaction.js";
import { redactFrame, runPaneStream } from "./pane-stream.js";

const begin = "-----BEGIN PRIVATE KEY-----";
const end = "-----END PRIVATE KEY-----";
const keyRows = ["synthetic key row one", "synthetic key row two"];

test.each([
  ["entire", ["above", begin, ...keyRows, end, "below"], ["above", "below"]],
  ["top clipped", [...keyRows, end, "below"], ["below"]],
  ["bottom clipped", ["above", begin, ...keyRows], ["above"]],
] as const)(
  "redacts a PEM key with %s screen content and preserves its rows",
  (_name, rows, neighbors) => {
    const screen = redactFrame(rows.join("\n"), 80);
    expect(screen.split("\n")).toHaveLength(rows.length);
    for (const key of keyRows) expect(screen).not.toContain(key);
    for (const neighbor of neighbors) expect(screen).toContain(neighbor);
  },
);

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

test("owner frames stop before capture when the matcher is unavailable", async () => {
  let captured = 0;
  await runPaneStream("fixture", {
    redactionReady: () => false,
    capture: () => {
      captured++;
      return null;
    },
    push: async () => ({ stop: true }),
    write: () => {},
    now: () => 1,
    sleep: async () => {},
  });
  expect(captured).toBe(0);
});

const opaque = ["synthetic", "value", "for", "tests"].join("-");
const encoded = btoa([begin, opaque, end].join("\n"));
test.each([
  [
    "PGP private block",
    [
      "-----BEGIN PGP PRIVATE KEY BLOCK-----",
      opaque,
      "-----END PGP PRIVATE KEY BLOCK-----",
    ],
    opaque,
  ],
  ...["d", "p", "q", "dp", "dq", "qi", "k", "oth"].map(
    (field) =>
      [
        `JWK private field ${field}`,
        [
          "{",
          '"kty": "RSA",',
          JSON.stringify(field) +
            ": " +
            (field === "oth"
              ? JSON.stringify([{ r: opaque }])
              : JSON.stringify(opaque)),
          "}",
        ],
        opaque,
      ] as const,
  ),
  ["client-key-data", [`  client-key-data: "${opaque}"`], opaque],
  [
    "client-key-data block",
    [
      "client-key-data: |",
      "  " + encoded.slice(0, 12),
      "  " + encoded.slice(12),
    ],
    encoded.slice(12),
  ],
  ["encoded PEM", [encoded], encoded],
  [
    "bare multiline assignment",
    ['PASSWORD="example', opaque, 'last line"'],
    opaque,
  ],
  [
    "quoted multiline assignment",
    ['APP_SECRET="example', opaque, 'last line"'],
    opaque,
  ],
  [
    "markerless key rows",
    Array.from({ length: 4 }, (_, index) =>
      String.fromCharCode(65 + index).repeat(64),
    ),
    "B".repeat(64),
  ],
] as const)(
  "terminal hints redact %s, retain row count and preserve public neighbors",
  (_kind, rows, secret) => {
    const input = ["public before", ...rows, "public after"].join("\n");
    const screen = redactFrame(input, 120);
    expect(screen).not.toContain(secret);
    expect(screen).toContain("public before");
    expect(screen).toContain("public after");
    expect(screen.split("\n")).toHaveLength(input.split("\n").length);
  },
);

test("cell width counts tab stops when a known value wraps", () => {
  const head = "abc\t";
  const tail = "synthetic-tab-tail";
  setKnownValuesForTest([{ value: head + tail, name: "fixture", vault: true }]);
  try {
    expect(redactFrame(head + "\n" + tail, 8)).not.toContain("syntheti");
  } finally {
    setKnownValuesForTest(null);
  }
});

test("8-bit CSI inside a known value does not hide it from redaction", () => {
  setKnownValuesForTest([{ value: opaque, name: "fixture", vault: true }]);
  try {
    const screen = redactFrame(
      opaque.slice(0, 10) + "\x9b31m" + opaque.slice(10),
      80,
    );
    expect(screen).toContain("[redacted:");
    expect(screen).not.toContain(opaque.slice(10));
  } finally {
    setKnownValuesForTest(null);
  }
});

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
