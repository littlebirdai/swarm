const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const { harness } = require("./mainTestRig");

beforeEach(harness.setup);
afterEach(harness.teardown);

function warmSpare(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const rig = harness.loadShell();
  rig.mainWindow.webContents.emit("did-finish-load");
  t.mock.timers.tick(6000);
  const spare = rig.windows.at(-1);
  assert.notEqual(spare, rig.mainWindow);
  spare.webContents.emit("did-finish-load");
  return { rig, spare };
}

test("detaching a tab discards a crashed spare and loads a fresh window", (t) => {
  const { rig, spare } = warmSpare(t);
  spare.webContents.isCrashed = () => true;
  rig.handlers.get("detach-tab")(rig.event(), "/inbox");
  const detached = rig.windows.at(-1);
  assert.equal(spare.isDestroyed(), true);
  assert.notEqual(detached, spare);
  assert.deepEqual(detached.last("loadURL"), ["https://codecast.sh/inbox"]);
  detached.emit("ready-to-show");
  assert.equal(detached.isVisible(), true);
});

test("detaching a tab still reuses a healthy ready spare", async (t) => {
  const { rig, spare } = warmSpare(t);
  assert.ok(spare.options.webPreferences.additionalArguments.includes("--warm-spare"));
  const events = [];
  spare.webContents.send = (channel, role) => {
    if (channel === "window-role") events.push(["role", role.spare]);
  };
  spare.webContents.executeJavaScript = async (script) => {
    if (script.includes("codecast-navigate")) events.push(["navigate"]);
  };
  rig.listeners.get("browser-window-created")(null, spare);
  spare.webContents.emit("did-finish-load");
  t.mock.timers.tick(30);
  assert.deepEqual(events, [["role", true]]);

  const created = rig.windows.length;
  rig.handlers.get("detach-tab")(rig.event(), "/questions");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rig.windows.length, created);
  assert.equal(spare.isDestroyed(), false);
  assert.equal(spare.isVisible(), true);
  assert.equal(spare.did("loadURL").length, 1);
  assert.deepEqual(events, [["role", true], ["role", false], ["navigate"]]);

  // A reload gets the claimed role again even though preload still has the flag.
  spare.webContents.emit("did-finish-load");
  t.mock.timers.tick(30);
  assert.deepEqual(events.at(-1), ["role", false]);
});

test("the preload sees the current role when a spare reloads after claim", (t) => {
  const { rig, spare } = warmSpare(t);
  const preload = readFileSync(require.resolve("./preload"), "utf8");
  const boot = () => {
    let bridge;
    runInNewContext(preload, {
      location: { href: spare.webContents.getURL() },
      process: { argv: spare.options.webPreferences.additionalArguments, env: {}, isMainFrame: true },
      require: (name) => name !== "electron" ? require(name) : {
        contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } },
        ipcRenderer: {
          on() {},
          sendSync(channel) {
            const event = rig.event(spare.webContents);
            rig.handlers.get(channel)(event);
            return event.returnValue;
          },
        },
        webFrame: { setZoomFactor() {} },
      },
    });
    return bridge.isWarmSpare;
  };
  assert.equal(boot(), true);
  rig.handlers.get("detach-tab")(rig.event(), "/inbox");
  assert.equal(boot(), false);
});

test("only claimed windows can update the badge", (t) => {
  const { rig, spare } = warmSpare(t);
  const counts = [];
  rig.electron.app.setBadgeCount = (count) => counts.push(count);
  const setBadgeCount = rig.handlers.get("set-badge-count");
  const event = rig.event(spare.webContents);
  setBadgeCount(rig.event(), 3);
  setBadgeCount(event, 0);
  assert.deepEqual(counts, [3]);
  rig.handlers.get("detach-tab")(rig.event(), "/inbox");
  setBadgeCount(event, 0);
  assert.deepEqual(counts, [3, 0]);
});

test("main reveals the claimed spare if the renderer never answers", async (t) => {
  const { rig, spare } = warmSpare(t);
  spare.webContents.executeJavaScript = () => new Promise(() => {});
  rig.handlers.get("detach-tab")(rig.event(), "/inbox");
  t.mock.timers.tick(499);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(spare.isVisible(), false);
  t.mock.timers.tick(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(spare.isVisible(), true);
});

for (const hydrates of [true, false]) {
  test(hydrates ? "reveal waits for hydration and the painted route" : "reveal has a deadline if hydration stalls", async (t) => {
    const { rig, spare } = warmSpare(t);
    const document = { title: "Inbox" };
    const inboxState = { clientStateInitialized: false };
    spare.webContents.executeJavaScript = (source) => {
      if (source.includes("codecast-navigate")) {
        document.title = "Questions";
        return Promise.resolve();
      }
      return runInNewContext(source, {
        document,
        window: { __inboxStore: { getState: () => inboxState } },
        requestAnimationFrame: (fn) => setTimeout(fn, 16),
        cancelAnimationFrame: clearTimeout,
        setTimeout,
        clearTimeout,
      });
    };
    rig.handlers.get("detach-tab")(rig.event(), "/questions");
    t.mock.timers.tick(16);
    const flush = () => new Promise((resolve) => setImmediate(resolve));
    await flush();
    assert.equal(spare.isVisible(), false);

    if (hydrates) {
      inboxState.clientStateInitialized = true;
      t.mock.timers.tick(16);
      await flush();
      assert.equal(spare.isVisible(), false);
      t.mock.timers.tick(16);
    } else {
      t.mock.timers.tick(383);
      await flush();
      assert.equal(spare.isVisible(), false);
      t.mock.timers.tick(1);
    }
    await flush();
    assert.equal(spare.isVisible(), true);
  });
}
