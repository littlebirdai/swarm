import { afterEach, expect, test } from "bun:test";
import { setKnownValuesForTest } from "../known-value-redaction.js";
import { pollUntil } from "../test-helpers/pollUntil.js";
import { capturePane, redactFrame } from "./pane-stream.js";
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

test("capture binds the physical pane and refuses a partial tmux session name", async () => {
  const name = "watch-exact";
  const second = "watch-other";
  expect(tmuxRun(["new-session", "-d", "-s", name, "sleep", "60"]).status).toBe(
    0,
  );
  try {
    expect(
      tmuxRun(["new-session", "-d", "-s", second, "sleep", "60"]).status,
    ).toBe(0);
    expect(
      tmuxRun([
        "display-message",
        "-p",
        "-t",
        "watch-exac:0.0",
        "#{session_name}",
      ]).stdout.trim(),
    ).toBe(name);
    expect(await captureTeamPane(second)).not.toBeNull();
    const first = await captureTeamPane(name);
    expect(first?.identity).toStartWith(`${name}|`);
    expect(await captureTeamPane("watch-exac:0.0")).toBeNull();
    expect(
      tmuxRun(["respawn-pane", "-k", "-t", `${name}:0.0`, "sleep", "60"])
        .status,
    ).toBe(0);
    const replacement = await captureTeamPane(name);
    expect(replacement?.identity).toStartWith(`${name}|`);
    expect(replacement?.identity).not.toBe(first?.identity);
  } finally {
    tmuxRun(["kill-session", "-t", name]);
    tmuxRun(["kill-session", "-t", second]);
  }
});

test("isolated tmux redacts a value that wraps after a space at the pane width", async () => {
  const name = "watch-space";
  const first = "ABCDEFGHIJKLMNOPQRS";
  const second = "synthetic-tail";
  setKnownValuesForTest([
    { name: "fixture", value: first + " " + second, vault: true },
  ]);
  const create = tmuxRun([
    "new-session",
    "-d",
    "-s",
    name,
    "-x",
    "20",
    "-y",
    "8",
    `printf '%s\\n' '${first} ${second}'; sleep 60`,
  ]);
  expect(create.status).toBe(0);
  try {
    await pollUntil(
      async () => (await captureTeamPane(name))?.text.includes(second) ?? false,
      "synthetic value on the isolated pane",
    );
    const team = (await captureTeamPane(name))!;
    const owner = (await capturePane(name))!;
    for (const screen of [
      redactFrame(team.text, team.cols),
      redactFrame(owner.frame, owner.cols),
    ]) {
      expect(screen).not.toContain(first);
      expect(screen).not.toContain(second);
      expect(screen).toContain("[redacted:");
    }
  } finally {
    tmuxRun(["kill-session", "-t", name]);
  }
});

test("team frames stop before capture when the known-value matcher is unavailable", async () => {
  let published = 0;
  await streamTeamPane(
    "fixture",
    {
      redactionReady: () => published === 0,
      capture: () => ({
        identity: "original",
        cols: 80,
        text: `sample ${published}`,
      }),
      push: async () => ++published > 1,
      now: () => 1,
      sleep: async () => {},
    },
    "original",
  );
  expect(published).toBe(1);
});
