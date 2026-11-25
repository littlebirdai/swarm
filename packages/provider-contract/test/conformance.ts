import { describe, expect, test } from "bun:test";
import type { CanonicalEvent } from "@codecast/edge-contract";
import type {
  AnswerRequest,
  InterruptRequest,
  OpenOutcome,
  ObservedSession,
  OwnedSession,
  ProviderAdapter,
  ResumeSpec,
  SteerRequest,
} from "../src";

type Session = ObservedSession | OwnedSession;

export interface ProviderFixture {
  readonly adapter: ProviderAdapter;
  readonly mode: Session["mode"];
  readonly steer: SteerRequest;
  readonly interrupt: InterruptRequest;
  readonly answer: AnswerRequest;
  readonly orderedEvents: readonly [CanonicalEvent, CanonicalEvent];
  readonly nonReceiptDelivery: "best-effort" | "unknown" | "unsupported";
  open(): Promise<OpenOutcome<Session>>;
  resumeSpec(checkpoint: string): ResumeSpec;
  sendEvent(index: 0 | 1): Promise<void>;
  atActiveTurn<T>(run: () => Promise<T>): Promise<T>;
  effects(): readonly string[];
  releases(): number;
}

async function open(fixture: ProviderFixture): Promise<Session> {
  const result = await fixture.open();
  expect(result.status).toBe("opened");
  if (result.status !== "opened") throw new Error("Fixture did not open");
  expect(result.session.mode).toBe(fixture.mode);
  return result.session;
}

export function providerConformance(
  name: string,
  create: () => ProviderFixture,
): void {
  describe(name, () => {
    test("events preserve canonical order", async () => {
      const fixture = create();
      const session = await open(fixture);
      try {
        const events = session.events[Symbol.asyncIterator]();
        await fixture.sendEvent(0);
        await fixture.sendEvent(1);
        for (const event of fixture.orderedEvents) {
          expect(await events.next()).toEqual({ done: false, value: event });
        }
        expect(fixture.orderedEvents[1].seq).toBeGreaterThan(
          fixture.orderedEvents[0].seq,
        );
      } finally {
        await session.close();
      }
    });

    test("receipts are emitted at most once and survive resume", async () => {
      const fixture = create();
      const session = await open(fixture);
      try {
        const events = session.events[Symbol.asyncIterator]();
        if (!fixture.adapter.provider.capabilities.includes("receipts")) {
          const outcome = await session.steer(fixture.steer);
          if (fixture.nonReceiptDelivery === "unsupported") {
            expect(outcome.status).toBe("unsupported");
            expect(fixture.effects()).toEqual([]);
          } else {
            expect(outcome).toEqual({
              status: "in-doubt",
              reason: fixture.nonReceiptDelivery,
            });
            expect(fixture.effects()).toEqual(["steer"]);
          }
          await fixture.sendEvent(0);
          expect((await events.next()).value).toEqual(fixture.orderedEvents[0]);
          return;
        }

        const receipt = { delivery_id: fixture.steer.delivery_id };
        const results = await Promise.all([
          session.steer(fixture.steer),
          session.steer(fixture.steer),
        ]);
        expect(results).toContainEqual({ status: "accepted", receipt });
        expect(results).toContainEqual({ status: "duplicate", receipt });
        expect(fixture.effects()).toEqual(["steer"]);
        const receiptEvent = await events.next();
        expect(receiptEvent.value).toMatchObject({
          kind: "receipt",
          body: receipt,
        });
        if (receiptEvent.done || receiptEvent.value.kind !== "receipt") {
          throw new Error("Expected a receipt event");
        }
        await fixture.sendEvent(0);
        const next = await events.next();
        expect(next.value).toEqual(fixture.orderedEvents[0]);
        expect(fixture.orderedEvents[0].seq).toBeGreaterThan(
          receiptEvent.value.seq,
        );

        if (session.mode !== "own")
          throw new Error("Receipts require ownership");
        const spec = fixture.resumeSpec(session.checkpoint);
        await session.close();
        const resumed = await fixture.adapter.resume(spec);
        expect(resumed.status).toBe("opened");
        if (resumed.status !== "opened")
          throw new Error("Fixture did not resume");
        try {
          expect(resumed.session.recoveredReceipts).toEqual([receipt]);
          expect(
            await resumed.session.steer({
              ...fixture.steer,
              expected: {
                ...fixture.steer.expected,
                run: spec.run,
                fencing_token: spec.fencing_token,
              },
            }),
          ).toEqual({ status: "duplicate", receipt });
          expect(fixture.effects()).toEqual(["steer"]);
          await fixture.sendEvent(0);
          const resumedEvents = resumed.session.events[Symbol.asyncIterator]();
          expect((await resumedEvents.next()).value).toEqual(
            fixture.orderedEvents[0],
          );
        } finally {
          await resumed.session.close();
        }
      } finally {
        await session.close();
      }
    });

    test("stale actions reach neither the agent nor the pane", async () => {
      const fixture = create();
      const session = await open(fixture);
      try {
        if (fixture.nonReceiptDelivery !== "unsupported") {
          const { expected } = fixture.steer;
          for (const wrong of [
            { ...expected, run: expected.run + 1 },
            { ...expected, fencing_token: "old-fence" },
            { ...expected, turn: "old-turn" },
            ...(session.mode === "observe"
              ? [{ ...expected, pane_instance: "old-pane" }]
              : []),
          ]) {
            const outcome = await session.steer({
              ...fixture.steer,
              expected: wrong,
            });
            expect(outcome).toMatchObject({
              status: "stale",
              observed: { run: expected.run, turn: expected.turn },
            });
          }
        }
        const { capabilities } = fixture.adapter.provider;
        await fixture.atActiveTurn(async () => {
          if (capabilities.includes("interrupt")) {
            expect(
              await session.interrupt({
                expected: { ...fixture.interrupt.expected, turn: "old-turn" },
              }),
            ).toMatchObject({ status: "stale" });
          }
          if (capabilities.includes("prompts")) {
            expect(
              await session.answer({
                ...fixture.answer,
                expected: {
                  ...fixture.answer.expected,
                  prompt_id: "old-prompt",
                },
              }),
            ).toMatchObject({
              status: "stale",
              observed: { prompt_id: fixture.answer.expected.prompt_id },
            });
          }
        });
        expect(fixture.effects()).toEqual([]);
      } finally {
        await session.close();
      }
    });

    test("unsupported operations have no effect", async () => {
      const fixture = create();
      const session = await open(fixture);
      try {
        const { capabilities } = fixture.adapter.provider;
        const spec = fixture.resumeSpec("checkpoint");
        if (!capabilities.includes("own")) {
          expect(await fixture.adapter.start(spec)).toEqual({
            status: "unsupported",
            requires: "own",
          });
        }
        if (!capabilities.includes("resume")) {
          expect(await fixture.adapter.resume(spec)).toEqual({
            status: "unsupported",
            requires: "resume",
          });
        }
        if (!capabilities.includes("steer-mid-turn")) {
          expect(
            await fixture.atActiveTurn(() =>
              session.steer({
                ...fixture.steer,
                expected: {
                  ...fixture.steer.expected,
                  turn: fixture.interrupt.expected.turn,
                },
              }),
            ),
          ).toMatchObject({ status: "unsupported" });
        }
        if (!capabilities.includes("interrupt")) {
          expect(await session.interrupt(fixture.interrupt)).toMatchObject({
            status: "unsupported",
          });
        }
        if (!capabilities.includes("prompts")) {
          expect(await session.answer(fixture.answer)).toMatchObject({
            status: "unsupported",
          });
        }
        expect(fixture.effects()).toEqual([]);
      } finally {
        await session.close();
      }
    });

    test("close releases once and ends the stream even if the source emits again", async () => {
      const fixture = create();
      const session = await open(fixture);
      try {
        const events = session.events[Symbol.asyncIterator]();
        const pending = events.next();
        expect(await Promise.all([session.close(), session.close()])).toEqual([
          { status: "closed" },
          { status: "closed" },
        ]);
        expect(fixture.releases()).toBe(1);
        await fixture.sendEvent(0);
        expect((await pending).done).toBe(true);
        expect((await events.next()).done).toBe(true);
        expect(await session.steer(fixture.steer)).toEqual({
          status: "closed",
        });
        expect(fixture.effects()).toEqual([]);
      } finally {
        await session.close();
      }
    });
  });
}
