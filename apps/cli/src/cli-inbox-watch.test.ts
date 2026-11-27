import { expect, spyOn, test } from "bun:test";
import type { ConvexClient } from "convex/browser";
import { subscribeCliInboxWatch } from "./cli-inbox-watch.js";

test.each([
  ["user-wide", undefined],
  ["named", "watched"],
] as const)(
  "%s watch falls back when the server does not know the watch argument",
  (_scope, sessionId) => {
    const args = {
      api_token: "fixture",
      limit: 2,
      session_ids: sessionId ? [sessionId] : undefined,
    };
    const registrations: {
      args: Record<string, unknown>;
      onFrame: (value: unknown) => void;
      onError?: (error: Error) => void;
    }[] = [];
    let unsubscribed = 0;
    const client = {
      onUpdate(
        _query: unknown,
        args: Record<string, unknown>,
        onFrame: (value: unknown) => void,
        onError?: (error: Error) => void,
      ) {
        registrations.push({ args, onFrame, onError });
        return () => unsubscribed++;
      },
    } as unknown as Pick<ConvexClient, "onUpdate">;
    const frames: unknown[] = [];
    subscribeCliInboxWatch(client, args, (rows) => frames.push(rows));
    expect(registrations.map(({ args }) => args)).toEqual([
      { ...args, watch: true },
    ]);
    registrations[0].onError?.(
      new Error("ArgumentValidationError: Object contains extra field `watch`"),
    );
    expect(unsubscribed).toBe(1);
    expect(registrations[1]?.args).toEqual(args);
    registrations[1].onFrame({ sessions: [{ title: "Current" }] });
    expect(frames).toEqual([[{ title: "Current" }]]);
  },
);

test("reports a truncated watch once per episode and still delivers every frame", () => {
  let receive!: (frame: unknown) => void;
  const client = {
    onUpdate(_query: unknown, _args: unknown, callback: typeof receive) {
      receive = callback;
      return () => {};
    },
  } as unknown as Pick<ConvexClient, "onUpdate">;
  const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
  const frames: unknown[] = [];
  try {
    subscribeCliInboxWatch(client, { api_token: "fixture" }, (rows) =>
      frames.push(rows),
    );
    const sessions = [{ id: "work" }];
    const truncated = {
      sessions,
      watch_truncation: { shown: 1, matching: 3, windows: [] },
    };
    receive(truncated);
    receive(truncated);
    expect(stderr.mock.calls.map(([line]) => line)).toEqual([
      "cast sessions: watch truncated to 1 of 3 matching sessions.\n",
    ]);
    receive({ sessions });
    receive({
      ...truncated,
      watch_truncation: { shown: 1, matching: 1, windows: ["owned"] },
    });
    expect(stderr.mock.calls.map(([line]) => line)).toHaveLength(2);
    expect(stderr.mock.calls[1][0]).toContain(
      "watch windows also reached their limits",
    );
    expect(frames).toEqual([sessions, sessions, sessions, sessions]);
  } finally {
    stderr.mockRestore();
  }
});
