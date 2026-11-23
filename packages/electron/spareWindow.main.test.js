const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
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
