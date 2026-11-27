/**
 * The role-less control scan against a real renderer.
 *
 * The unit tests in snapshot.test.ts fake CDP, so they prove the wiring but
 * not the DOM query — and the DOM query is the whole feature. This drives a
 * headless Chrome over the same CDP path `cast browser` uses, so what it
 * asserts is what an agent sees: a styled <div> gets a ref, that ref clicks,
 * and the contenteditable takes typed text.
 *
 * Skipped where Chrome is absent (CI runners), which is why the fake-CDP
 * tests carry the regression weight.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connectTestChrome } from "./chrome-pipe.testkit.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as actions from "./actions.js";
import { CdpConnection, type CdpEvent } from "./cdp.js";
import { FakeExtension, testBridgeHost } from "./bridge/host.testutil.js";
import { targetIdOfTab } from "./bridge/protocol.js";
import { attachToTarget, type PageSession } from "./instance.js";
import { matchRefs, snapshotPage } from "./snapshot.js";
import { findChromeBinary } from "../workspace/chrome.js";

const chrome = findChromeBinary();
const FIXTURE = path.join(
  import.meta.dir,
  "fixtures",
  "roleless-controls.html",
);

describe.skipIf(!chrome)("role-less controls in a real page", () => {
  let server: Bun.Server<undefined>;
  let stopChrome: (() => Promise<void>) | undefined;
  let conn: CdpConnection;
  let page: PageSession;
  let userDataDir: string;
  let pageUrl: string;

  const evalPage = async (expression: string): Promise<unknown> =>
    (
      await page.conn.send<any>(
        "Runtime.evaluate",
        { expression, returnByValue: true },
        page.sessionId,
      )
    ).result?.value;

  beforeAll(async () => {
    const html = fs.readFileSync(FIXTURE, "utf-8");
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(html, {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    });
    pageUrl = server.url.href;

    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-clickable-"));
    const chromeProcess = await connectTestChrome(chrome!, userDataDir);
    stopChrome = chromeProcess.stop;
    conn = chromeProcess.conn;

    const { targetId } = await conn.send<{ targetId: string }>(
      "Target.createTarget",
      { url: "about:blank" },
    );
    page = await attachToTarget(conn, targetId);
    await conn.send(
      "Page.setLifecycleEventsEnabled",
      { enabled: true },
      page.sessionId,
    );
    const loaded = new Set<unknown>();
    const isLoad = (event: CdpEvent) =>
      event.sessionId === page.sessionId &&
      event.method === "Page.lifecycleEvent" &&
      event.params.name === "load";
    const unsubscribe = conn.on((event) => {
      if (isLoad(event)) loaded.add(event.params.loaderId);
    });
    try {
      const { loaderId, errorText } = await conn.send<{
        loaderId?: string;
        errorText?: string;
      }>("Page.navigate", { url: pageUrl }, page.sessionId);
      if (!loaderId || errorText)
        throw new Error(errorText ?? "Navigation did not name a loader");
      if (!loaded.has(loaderId))
        await conn.waitFor(
          (event) => isLoad(event) && event.params.loaderId === loaderId,
          5_000,
        );
    } finally {
      unsubscribe();
    }
  }, 60_000);

  afterAll(async () => {
    try {
      await stopChrome?.();
    } finally {
      await server?.stop(true);
      if (userDataDir)
        fs.rmSync(userDataDir, {
          recursive: true,
          force: true,
          maxRetries: 5,
        });
    }
  });

  test("a styled div, a listener span, a tabindex div and an editor all get refs", async () => {
    const snap = await snapshotPage(page, { interactiveOnly: true });
    const names = snap.refs
      .filter((r) => r.role === "clickable")
      .map((r) => r.name);
    expect(names).toContain("Publish");
    expect(names).toContain("Discard");
    expect(names).toContain("Keyboard reachable");
    expect(names).toContain("Message body");
    expect(snap.text).toMatch(/clickable "Publish" #e\d+/);
    expect(snap.text).toMatch(/clickable "Message body" \[editable\] #e\d+/);
  });

  test("the real button and link stay with the accessibility tree, once each", async () => {
    const snap = await snapshotPage(page, { interactiveOnly: true });
    const roles = (name: string) =>
      snap.refs.filter((r) => r.name === name).map((r) => r.role);
    expect(roles("Real button")).toEqual(["button"]);
    expect(roles("Real link")).toEqual(["link"]);
  });

  test("an inherited cursor reports the card, not the span inside it", async () => {
    const snap = await snapshotPage(page, { interactiveOnly: true });
    expect(snap.refs.filter((r) => r.name === "Nested card")).toHaveLength(1);
  });

  test("a display:none control is left out", async () => {
    const snap = await snapshotPage(page, { interactiveOnly: true });
    expect(snap.refs.map((r) => r.name)).not.toContain("Hidden control");
  });

  test("clicking the ref fires the div's own handler", async () => {
    await evalPage("document.getElementById('log').textContent = ''");
    const snap = await snapshotPage(page, { interactiveOnly: true });
    const [hit] = matchRefs(snap.refs, "Publish");
    expect(hit).toBeDefined();
    await actions.click(page, hit.ref);
    expect(await evalPage("document.getElementById('log').textContent")).toBe(
      "fired:publish",
    );
  });

  test("a span with an addEventListener click and no attribute works too", async () => {
    await evalPage("document.getElementById('log').textContent = ''");
    const snap = await snapshotPage(page, { interactiveOnly: true });
    const [hit] = matchRefs(snap.refs, "Discard");
    await actions.click(page, hit.ref);
    expect(await evalPage("document.getElementById('log').textContent")).toBe(
      "fired:discard",
    );
  });

  test("typing lands in the contenteditable", async () => {
    const snap = await snapshotPage(page, { interactiveOnly: true });
    const [hit] = matchRefs(snap.refs, "Message body");
    await actions.type(page, hit.ref, "hello there");
    expect(
      await evalPage("document.getElementById('editor').textContent"),
    ).toBe("hello there");
  });

  test("the scan leaves nothing of its own behind on the page", async () => {
    await snapshotPage(page);
    expect(await evalPage("'__castClickable' in window")).toBe(false);
  });

  test("the same refs come back over the extension bridge", async () => {
    // The bridge relays CDP verbatim to chrome.debugger, so the scan's three
    // extra methods (Runtime.getProperties, DOM.describeNode,
    // Runtime.releaseObjectGroup) have to survive the trip like every other.
    // Real host, real protocol, real Chrome — only background.js is a double.
    //
    // Why the temp CODECAST_DIR: testBridgeHost writes the machine's bridge
    // state file, and that file holds the token the human's extension is
    // paired with. Writing the test token there unpairs their Chrome until
    // they re-run `cast browser extension setup` (ct-49554).
    const realHome = process.env.CODECAST_DIR;
    process.env.CODECAST_DIR = fs.mkdtempSync(
      path.join(os.tmpdir(), "cast-bridge-"),
    );
    const host = await testBridgeHost();
    const tabId = 4242;
    const ext = await new FakeExtension([
      FakeExtension.tab(tabId, pageUrl, "Role-less controls"),
    ]).connect(host.port);
    // Forward what the extension would hand to chrome.debugger into the real
    // page instead of the testutil's echo.
    ext.ws.removeAllListeners("message");
    ext.ws.on("message", async (raw: unknown) => {
      const m = JSON.parse(String(raw));
      if (m.op === "ping") return;
      const reply = (extra: Record<string, unknown>) =>
        ext.ws.send(JSON.stringify({ id: m.id, ok: true, ...extra }));
      if (m.op === "tabs.list") return reply({ tabs: ext.tabs });
      if (m.op === "attach" || m.op === "detach") return reply({});
      if (m.op === "cdp") {
        try {
          return reply({
            result: await conn.send(m.method, m.params, page.sessionId),
          });
        } catch (err) {
          return ext.ws.send(
            JSON.stringify({
              id: m.id,
              ok: false,
              error: (err as Error).message,
            }),
          );
        }
      }
      return ext.ws.send(
        JSON.stringify({ id: m.id, ok: false, error: `unknown op ${m.op}` }),
      );
    });

    let viaBridge: CdpConnection | undefined;
    try {
      viaBridge = await CdpConnection.fromPort({
        port: host.port,
        token: host.token,
      });
      const bridged = await attachToTarget(viaBridge, targetIdOfTab(tabId));
      const snap = await snapshotPage(bridged, { interactiveOnly: true });
      const names = snap.refs
        .filter((r) => r.role === "clickable")
        .map((r) => r.name);
      expect(names).toContain("Publish");
      expect(names).toContain("Message body");
      // Same node, so the same ref as the direct CDP path minted.
      const direct = await snapshotPage(page, { interactiveOnly: true });
      const refOf = (s: typeof snap, name: string) =>
        s.refs.find((r) => r.name === name)?.ref;
      expect(refOf(snap, "Publish")).toBe(refOf(direct, "Publish"));
    } finally {
      viaBridge?.close();
      ext.ws.close();
      await host.close();
      fs.rmSync(process.env.CODECAST_DIR!, { recursive: true, force: true });
      if (realHome === undefined) delete process.env.CODECAST_DIR;
      else process.env.CODECAST_DIR = realHome;
    }
  }, 30_000);
});
