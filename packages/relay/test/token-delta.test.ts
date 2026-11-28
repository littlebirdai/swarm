import { expect } from "bun:test";
import { it } from "@codecast/effect-kit/effect/testing";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { Relay } from "../src/index";
import { capabilities, claims, harness, machine, peer } from "./fixtures";

const viewerHub = { kind: "session", id: "viewer:session-A" } as const;
const deltaCapabilities = [...capabilities, "token_delta"];
const viewerPublish = ["presence", "draft_cursor", "reading_cursor"] as const;

function deltaFrame(delta_seq: number, text: string, run = 4) {
  return {
    v: 1 as const,
    type: "token_delta" as const,
    hub: viewerHub,
    run,
    turn: "turn-1",
    message_id: "msg-1",
    delta_seq,
    text,
  };
}

it.effect(
  "fans token deltas to granted viewers without coalescing or echoing to the publisher",
  () =>
    harness(
      Effect.gen(function* () {
        yield* TestClock.setTime(1000);
        const relay = yield* Relay;
        const owner = yield* peer(
          relay,
          claims({
            subject: machine,
            grants: [{ ...viewerHub, run: 4, publish: ["token_delta"] }],
          }),
          deltaCapabilities,
        );
        const granted = yield* peer(
          relay,
          claims({
            subject: { kind: "user", id: "viewer-granted" },
            grants: [{ ...viewerHub, publish: [...viewerPublish] }],
          }),
          deltaCapabilities,
        );
        const readOnlyViewer = yield* peer(
          relay,
          claims({
            subject: { kind: "user", id: "viewer-readonly" },
            grants: [{ ...viewerHub, publish: [] }],
          }),
          deltaCapabilities,
        );
        const ungranted = yield* peer(
          relay,
          claims({
            subject: { kind: "user", id: "viewer-other" },
            grants: [
              {
                kind: "session",
                id: "viewer:session-B",
                publish: [...viewerPublish],
              },
            ],
          }),
          deltaCapabilities,
        );
        const flagOffViewer = yield* peer(
          relay,
          claims({
            subject: { kind: "user", id: "viewer-no-cap" },
            grants: [{ ...viewerHub, publish: [...viewerPublish] }],
          }),
          capabilities,
        );

        yield* owner.subscribe(viewerHub);
        yield* granted.subscribe(viewerHub);
        yield* readOnlyViewer.subscribe(viewerHub);
        yield* ungranted.subscribe(viewerHub);
        yield* flagOffViewer.subscribe(viewerHub);

        expect(ungranted.events.at(-1)).toMatchObject({
          type: "subscription",
          hub: viewerHub,
          status: "denied",
        });

        granted.socket.pauseOnNextSend = true;
        const ownerCountBefore = owner.events.length;

        yield* owner.send(deltaFrame(1, "Hel"));
        yield* owner.send(deltaFrame(2, "lo "));
        yield* owner.send(deltaFrame(3, "world"));
        yield* owner.send(deltaFrame(1, "stale", 3));
        yield* granted.send(deltaFrame(4, "forged"));

        expect(owner.events.slice(ownerCountBefore)).toEqual([]);
        expect(granted.events.filter((e) => e.type === "token_delta")).toEqual([
          expect.objectContaining({
            type: "token_delta",
            hub: viewerHub,
            machine_id: machine.id,
            run: 4,
            turn: "turn-1",
            message_id: "msg-1",
            delta_seq: 1,
            text: "Hel",
          }),
        ]);

        yield* granted.connection.writable;
        expect(
          granted.events
            .filter((e) => e.type === "token_delta")
            .map((e) =>
              e.type === "token_delta" ? [e.delta_seq, e.text] : [],
            ),
        ).toEqual([
          [1, "Hel"],
          [2, "lo "],
          [3, "world"],
        ]);
        expect(
          readOnlyViewer.events.filter((e) => e.type === "token_delta"),
        ).toHaveLength(3);
        expect(
          ungranted.events.filter((e) => e.type === "token_delta"),
        ).toHaveLength(0);
        expect(
          flagOffViewer.events.filter((e) => e.type === "token_delta"),
        ).toHaveLength(0);
      }),
    ),
);

it.effect(
  "stops delivering token deltas when a viewer grant is released or expires",
  () =>
    harness(
      Effect.gen(function* () {
        yield* TestClock.setTime(1000);
        const relay = yield* Relay;
        const owner = yield* peer(
          relay,
          claims({
            subject: machine,
            expires_at_ms: 60_000,
            grants: [{ ...viewerHub, run: 2, publish: ["token_delta"] }],
          }),
          deltaCapabilities,
        );
        const released = yield* peer(
          relay,
          claims({
            subject: { kind: "user", id: "viewer-released" },
            expires_at_ms: 60_000,
            grants: [{ ...viewerHub, publish: [] }],
          }),
          deltaCapabilities,
        );
        const expiring = yield* peer(
          relay,
          claims({
            subject: { kind: "user", id: "viewer-expiring" },
            expires_at_ms: 16_000,
            grants: [{ ...viewerHub, publish: [] }],
          }),
          deltaCapabilities,
        );

        yield* owner.subscribe(viewerHub);
        yield* released.subscribe(viewerHub);
        yield* expiring.subscribe(viewerHub);

        yield* owner.send(deltaFrame(1, "first", 2));
        expect(
          released.events.filter((e) => e.type === "token_delta"),
        ).toHaveLength(1);
        expect(
          expiring.events.filter((e) => e.type === "token_delta"),
        ).toHaveLength(1);

        yield* released.release([viewerHub]);
        yield* owner.send(deltaFrame(2, "second", 2));
        expect(
          released.events.filter((e) => e.type === "token_delta"),
        ).toHaveLength(1);
        expect(
          expiring.events.filter((e) => e.type === "token_delta"),
        ).toHaveLength(2);

        yield* TestClock.adjust(15_000);
        yield* owner.send(deltaFrame(3, "third", 2));
        expect(
          expiring.events.filter((e) => e.type === "token_delta"),
        ).toHaveLength(2);
      }),
    ),
);
