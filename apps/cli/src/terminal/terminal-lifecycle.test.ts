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

test.each([
  ["replacement", false],
  ["missing", false],
  ["missing", true],
] as const)(
  "the capture loop records a start and an end for a %s pane (unconfirmed: %s)",
  async (loss, unconfirmed) => {
    const directory = mkdtempSync(path.join(tmpdir(), "terminal-lifecycle-"));
    const events: CanonicalEvent[] = [];
    let failStart = unconfirmed;
    const writer = createTerminalEventWriter(
      grant,
      directory,
      async (...batch) => {
        if (failStart) {
          failStart = false;
          throw new Error("HTTP 503");
        }
        events.push(...batch);
      },
    );
    try {
      await writer.startWatching();
      expect(observeClaimedTerminal("legacy", "pane", "owner")).toBeUndefined();
      let captures = 0;
      const frames: unknown[] = [];
      await streamTeamPane(
        "watched",
        {
          capture: () => {
            if (++captures === 1) return { identity: "pane", text: "screen" };
            return loss === "missing"
              ? null
              : { identity: "replacement", text: "screen" };
          },
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
            outcome: { kind: loss === "missing" ? "lost" : "replaced" },
          },
        },
      ]);
      expect(JSON.stringify(events)).not.toContain("screen");
    } finally {
      await writer.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

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

test.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
] as const)(
  "a failed terminal response preserves provider writes and cleanup (committed: %s, capped: %s)",
  async (committed, capped) => {
    const directory = mkdtempSync(path.join(tmpdir(), "terminal-lifecycle-"));
    const events: CanonicalEvent[] = [];
    const attempts: CanonicalEvent[][] = [];
    let through = grant.last_event_seq as number;
    const writer = createTerminalEventWriter(
      grant,
      directory,
      async (...batch) => {
        attempts.push(batch);
        const first = attempts.length === 1;
        const refused =
          first || (capped && batch[0].kind === "terminal.started");
        if (!refused || (first && committed)) {
          for (const event of batch) {
            if (event.seq <= through) continue;
            expect(event.seq).toBe(through + 1);
            through = event.seq;
            events.push(event);
          }
        }
        if (refused) throw new Error("HTTP 503");
      },
    );
    try {
      await writer.startWatching();
      expect(
        await observeClaimedTerminal(grant.session, "pane", "owner"),
      ).toEqual(expect.any(Function));
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
      expect(attempts[1][0]).toEqual(attempts[0][0]);
      if (capped) {
        expect(attempts[2].map(({ kind, seq }) => [kind, seq])).toEqual([
          ["context", 9],
          ["context", 10],
        ]);
      }
      await writer.close();
      expect(events.map(({ seq, kind }) => [seq, kind])).toEqual([
        [9, capped && !committed ? "context" : "terminal.started"],
        [10, "context"],
        [11, "terminal.ended"],
      ]);
      expect(events.at(-1)).toMatchObject({
        body: { pane_instance: 21, outcome: { kind: "lost" } },
      });
    } finally {
      await writer.close().catch(() => {});
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("blank and oversized owner IDs never reach the terminal event transport", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "terminal-lifecycle-"));
  const events: CanonicalEvent[] = [];
  const writer = createTerminalEventWriter(
    grant,
    directory,
    async (...batch) => {
      events.push(...batch);
    },
  );
  try {
    await writer.startWatching();
    for (const owner of ["", " ", "x".repeat(257)])
      expect(
        await observeClaimedTerminal(grant.session, "pane", owner),
      ).toBeUndefined();
    expect(events).toEqual([]);
    const end = await observeClaimedTerminal(
      grant.session,
      "pane",
      "x".repeat(256),
    );
    expect(events[0]).toMatchObject({
      seq: 9,
      kind: "terminal.started",
      body: { pane_instance: 21 },
    });
    await end?.({ kind: "lost" });
  } finally {
    await writer.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a pane that disappears before any provider event exhausts only one start retry", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "terminal-lifecycle-"));
  const attempts: CanonicalEvent[][] = [];
  const writer = createTerminalEventWriter(
    grant,
    directory,
    async (...batch) => {
      attempts.push(batch);
      if (batch[0].kind === "terminal.started") throw new Error("HTTP 503");
    },
  );
  try {
    await writer.startWatching();
    const end = await observeClaimedTerminal(grant.session, "pane", "owner");
    await expect(end?.({ kind: "lost" })).rejects.toThrow("HTTP 503");
    await writer.append({
      v: 1,
      session: grant.session,
      run: grant.run,
      seq: 9,
      at: 1,
      source: "provider",
      turn: null,
      kind: "context",
      body: { data: "provider event" },
    });
    expect(attempts.map((batch) => batch[0].kind)).toEqual([
      "terminal.started",
      "terminal.started",
      "context",
      "terminal.ended",
    ]);
    expect(attempts[2][1]).toMatchObject({
      seq: 10,
      body: { data: "provider event" },
    });
    expect(attempts[3][0]).toMatchObject({
      seq: 11,
      kind: "terminal.ended",
      body: { outcome: { kind: "lost" } },
    });
  } finally {
    await writer.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
