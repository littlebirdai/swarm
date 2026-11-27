import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CanonicalEvent } from "@codecast/edge-contract";
import { streamTeamPane } from "./team-pane-stream.js";
import {
  createTerminalEventWriter,
  observeClaimedTerminal,
} from "./terminal-lifecycle.js";

const grant = {
  v: 1,
  status: "granted",
  session: "watched-session",
  run: 3,
  fencing_token: "fixture",
  lease_ms: 5000,
  last_event_seq: 8,
  last_pane_instance: 20,
  terminal_lifecycle: true,
} as const;

test("the capture loop orders its start and replacement end with provider events in the current claim", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "terminal-lifecycle-"));
  const events: CanonicalEvent[] = [];
  const writer = createTerminalEventWriter(grant, directory, async (event) => {
    events.push(event);
  });
  try {
    await writer.startWatching();
    expect(observeClaimedTerminal("legacy", "pane", "owner")).toBeUndefined();
    let captures = 0;
    const frames: unknown[] = [];
    await streamTeamPane(
      "watched",
      {
        capture: () => ({
          identity: ++captures === 1 ? "pane" : "replacement",
          text: "screen",
        }),
        observePane: (identity) =>
          observeClaimedTerminal(grant.session, identity, "owner"),
        now: () => 0,
        sleep: async () => {},
        push: async (frame) => {
          frames.push(frame);
          if (frame.pane_instance)
            await writer.append({
              v: 1,
              session: grant.session,
              run: grant.run,
              seq: 9,
              at: 1,
              source: "provider",
              turn: null,
              kind: "context",
              body: { data: null },
            });
          return false;
        },
      },
      "pane",
    );
    expect(frames).toEqual([{ pane_instance: "pane", frame: "screen" }, {}]);
    expect(events.map(({ seq }) => seq)).toEqual([9, 10, 11]);
    expect(events).toMatchObject([
      {
        kind: "terminal.started",
        body: { pane_instance: 21, actor: { id: "owner" } },
      },
      { kind: "context" },
      {
        kind: "terminal.ended",
        body: {
          pane_instance: 21,
          started_run: 3,
          outcome: { kind: "replaced" },
        },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("screen");
  } finally {
    await writer.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a subsequent claim recovers an unconfirmed pane and reserves a higher instance", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "terminal-lifecycle-"));
  const first = createTerminalEventWriter(grant, directory, async (event) => {
    if (event.kind === "terminal.ended") throw new Error("transport lost");
  });
  try {
    await first.startWatching();
    const end = await observeClaimedTerminal(grant.session, "pane", "owner");
    expect(end).toEqual(expect.any(Function));
    await expect(first.close()).rejects.toThrow("transport lost");

    const events: CanonicalEvent[] = [];
    const second = createTerminalEventWriter(
      { ...grant, run: 4 },
      directory,
      async (event) => {
        events.push(event);
      },
    );
    try {
      await second.startWatching();
      const stop = await observeClaimedTerminal(
        grant.session,
        "new pane",
        "owner",
      );
      await stop?.({ kind: "lost" });
      expect(events).toMatchObject([
        {
          kind: "terminal.ended",
          run: 4,
          body: {
            pane_instance: 21,
            started_run: 3,
            outcome: { kind: "replaced" },
          },
        },
        { kind: "terminal.started", run: 4, body: { pane_instance: 22 } },
        {
          kind: "terminal.ended",
          run: 4,
          body: { pane_instance: 22, started_run: 4 },
        },
      ]);
    } finally {
      await second.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
