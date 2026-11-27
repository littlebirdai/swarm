import { expect } from "bun:test";
import { it } from "@codecast/effect-kit/effect/testing";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { Relay } from "../src/index";
import { claims, harness, peer, session } from "./fixtures";

const viewerSession = { kind: "session", id: "viewer:session-A" } as const;
const viewerPublish = ["presence", "draft_cursor", "reading_cursor"] as const;

it.effect(
  "isolates viewer hubs, expires shared-tier viewer grants on TestClock, and suppresses departures during drain",
  () =>
    harness(
      Effect.gen(function* () {
        yield* TestClock.setTime(1000);
        const relay = yield* Relay;
        const owner = yield* peer(
          relay,
          claims({
            subject: { kind: "user", id: "owner" },
            expires_at_ms: 61_000,
            grants: [
              { ...viewerSession, publish: [...viewerPublish] },
              { ...session, publish: ["baton_heartbeat"] },
            ],
          }),
        );
        const guest = yield* peer(
          relay,
          claims({
            subject: { kind: "user", id: "guest" },
            expires_at_ms: 16_000,
            grants: [{ ...viewerSession, publish: [...viewerPublish] }],
          }),
        );
        yield* owner.subscribe(viewerSession);
        yield* owner.subscribe(session);
        yield* guest.subscribe(viewerSession);
        yield* guest.subscribe(session);
        expect(guest.events.at(-1)).toMatchObject({
          type: "subscription",
          hub: session,
          status: "denied",
        });

        yield* guest.send({
          type: "presence",
          v: 1,
          hub: viewerSession,
          state: "active",
          in_draft: true,
        });
        yield* guest.send({
          type: "reading_cursor",
          v: 1,
          hub: viewerSession,
          cursor: { message_id: "msg-1", offset: 0.25 },
        });
        yield* guest.send({
          type: "baton_heartbeat",
          v: 1,
          hub: viewerSession,
        });

        expect(owner.events.slice(-2)).toEqual([
          expect.objectContaining({
            type: "presence",
            hub: viewerSession,
            user_id: "guest",
            state: "active",
            in_draft: true,
          }),
          expect.objectContaining({
            type: "reading_cursor",
            hub: viewerSession,
            user_id: "guest",
            cursor: { message_id: "msg-1", offset: 0.25 },
          }),
        ]);
        expect(
          owner.events.filter(
            (event) =>
              "hub" in event &&
              event.hub.id === session.id &&
              event.type !== "subscription",
          ),
        ).toEqual([]);

        yield* TestClock.adjust(14_999);
        expect(
          guest.events.some(
            (event) =>
              event.type === "subscription" && event.status === "unsubscribed",
          ),
        ).toBe(false);
        yield* TestClock.adjust(1);
        expect(guest.events.slice(-2)).toEqual([
          {
            type: "subscription",
            v: 1,
            hub: viewerSession,
            status: "unsubscribed",
            reason: "expired",
          },
          { type: "closed", code: 1008 },
        ]);
        expect(owner.events.at(-1)).toMatchObject({
          type: "presence",
          hub: viewerSession,
          user_id: "guest",
          state: "left",
          in_draft: false,
          ttl_ms: 0,
        });

        const ownerCountBeforeDrain = owner.events.length;
        yield* owner.send({
          type: "presence",
          v: 1,
          hub: viewerSession,
          state: "active",
          in_draft: false,
        });
        const peerB = yield* peer(
          relay,
          claims({
            subject: { kind: "user", id: "teammate" },
            expires_at_ms: 61_000,
            grants: [{ ...viewerSession, publish: [...viewerPublish] }],
          }),
        );
        yield* peerB.subscribe(viewerSession);
        yield* relay.drain;
        expect(yield* relay.isDraining).toBe(true);
        expect(owner.events.slice(ownerCountBeforeDrain)).toEqual([
          expect.objectContaining({ type: "presence", user_id: "owner" }),
          { type: "hello", status: "unavailable", retry_after_ms: 1234 },
          { type: "closed", code: 1012 },
        ]);
        expect(peerB.events.slice(-2)).toEqual([
          { type: "hello", status: "unavailable", retry_after_ms: 1234 },
          { type: "closed", code: 1012 },
        ]);
      }),
    ),
);
