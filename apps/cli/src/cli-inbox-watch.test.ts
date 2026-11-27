import { expect, test } from "bun:test";
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
