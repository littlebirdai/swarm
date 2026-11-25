import { afterEach, expect, test } from "bun:test";
import { setKnownValuesForTest } from "../known-value-redaction.js";
import { tmuxRun } from "../tmux.js";
import { captureTeamPane, streamTeamPane } from "./team-pane-stream.js";

afterEach(() => setKnownValuesForTest(null));

test("team publishing redacts each screen before it crosses the transport", async () => {
  const secret = "test-registered-secret-value";
  setKnownValuesForTest([{ value: secret, name: "test", vault: true }]);
  let now = 0;
  const captured: { pane_instance?: string; frame?: string }[] = [];
  const screens = [`First ${secret}`, `Second ${secret}`];
  await streamTeamPane("cc-watch", {
    capture: () => ({ identity: "%1|42", cols: 80, text: screens.shift()! }),
    push: async (frame) => {
      captured.push(frame);
      return captured.length === 2;
    },
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  });
  expect(captured.map((frame) => frame.frame)).toEqual([
    expect.stringContaining("First "),
    expect.stringContaining("Second "),
  ]);
  expect(JSON.stringify(captured)).not.toContain(secret);
});

test("a replacement in the same tmux target sends only the end signal", async () => {
  let now = 0;
  const captured: { pane_instance?: string; frame?: string }[] = [];
  await streamTeamPane("cc-watch", {
    capture: () =>
      now === 0
        ? { identity: "first", cols: 80, text: "Old pane" }
        : { identity: "replacement", cols: 80, text: "New pane" },
    push: async (frame) => {
      captured.push(frame);
      return captured.length >= 2;
    },
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  });
  expect(captured).toEqual([{ pane_instance: "first", frame: "Old pane" }, {}]);
});

test("a re-dispatched stream checks the original physical pane before sending a screen", async () => {
  const captured: { pane_instance?: string; frame?: string }[] = [];
  await streamTeamPane(
    "cc-watch",
    {
      capture: () => ({ identity: "replacement", cols: 80, text: "New pane" }),
      push: async (frame) => {
        captured.push(frame);
        return true;
      },
      now: () => 0,
      sleep: async () => {},
    },
    "original",
  );
  expect(captured).toEqual([{}]);
});

test("capture binds the physical pane and refuses a partial tmux session name", () => {
  const name = "cc-watch-exact";
  expect(tmuxRun(["new-session", "-d", "-s", name, "sleep", "60"]).status).toBe(
    0,
  );
  try {
    const first = captureTeamPane(name);
    expect(first?.identity).toStartWith(`${name}|`);
    expect(captureTeamPane("cc-watch-exac")).toBeNull();
    expect(
      tmuxRun(["respawn-pane", "-k", "-t", `${name}:0.0`, "sleep", "60"])
        .status,
    ).toBe(0);
    const replacement = captureTeamPane(name);
    expect(replacement?.identity).toStartWith(`${name}|`);
    expect(replacement?.identity).not.toBe(first?.identity);
  } finally {
    tmuxRun(["kill-session", "-t", name]);
  }
});
