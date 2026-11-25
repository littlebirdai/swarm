import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vaultRedactionSource } from "../secrets/redaction-source.js";
import { KnownValueStore } from "../known-value-redaction.js";
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

test("known-value readiness requires a successful refresh and expires after 75 seconds", async () => {
  const folder = mkdtempSync(join(tmpdir(), "terminal-redaction-"));
  let online = false;
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
        online
          ? Response.json(
              String(url).endsWith("-values")
                ? { version: "v1", values: [] }
                : { version: "v1" },
            )
          : new Response(null, { status: 503 })) as typeof fetch,
    }),
  });
  try {
    expect(store.readyForTerminal()).toBe(false);
    expect(await store.refreshVault()).toBe(false);
    online = true;
    expect(await store.refreshVault()).toBe(true);
    clock.mockReturnValue(75_100);
    expect(store.readyForTerminal()).toBe(false);
    expect(await store.refreshVault()).toBe(true);
    online = false;
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
