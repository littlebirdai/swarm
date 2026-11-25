import { describe, expect, test } from "bun:test";
import {
  parseCanonicalEvent,
  parseMessageDelta,
  type CanonicalEvent,
} from "@codecast/edge-contract";
import type {
  AnswerRequest,
  CloseOutcome,
  ControlOutcome,
  InDoubt,
  InterruptRequest,
  ObservedPosition,
  OpenOutcome,
  ObservedSession,
  OwnedSession,
  ProviderAdapter,
  ProviderEventIterator,
  ResumeSpec,
  SessionScope,
  Stale,
  SteerRequest,
} from "../src";

type Session = ObservedSession | OwnedSession;

export interface ProviderFixture {
  readonly adapter: ProviderAdapter;
  readonly mode: Session["mode"];
  readonly scope: SessionScope;
  readonly steer: SteerRequest;
  readonly interrupt: InterruptRequest;
  readonly answer: AnswerRequest;
  readonly orderedEvents: readonly [
    Pick<CanonicalEvent, "kind" | "body">,
    Pick<CanonicalEvent, "kind" | "body">,
  ];
  readonly nonReceiptDelivery: InDoubt | { readonly status: "unsupported" };
  readonly interruptOutcome: ControlOutcome;
  readonly answerOutcome: ControlOutcome;
  readonly bufferCapacity: number;
  open(scope: SessionScope): Promise<OpenOutcome<Session>>;
  resumeSpec(checkpoint: string): ResumeSpec;
  advanceCheckpoint(): Promise<string>;
  sendEvent(index: number): Promise<void>;
  waitForBackpressure(): Promise<void>;
  atActiveTurn<T>(run: () => Promise<T>): Promise<T>;
  pauseBeforeWrite(): { entered: Promise<void>; release(): void };
  processExit(): Promise<void>;
  streamDefect(error: Error): Promise<void>;
  failClose(): Extract<CloseOutcome, { status: "failed" }>;
  effects(): readonly string[];
  releases(): number;
}

async function open(
  fixture: ProviderFixture,
  scope = fixture.scope,
): Promise<Session> {
  const result = await fixture.open(scope);
  expect(result.status).toBe("opened");
  if (result.status !== "opened") throw new Error("Fixture did not open");
  expect(result.session.mode).toBe(fixture.mode);
  return result.session;
}

function reader(events: ProviderEventIterator, scope: SessionScope) {
  let previousSeq = scope.afterSeq;
  return async () => {
    const { done, value } = await events.next();
    if (done) return undefined;
    expect(value.session).toBe(scope.session);
    expect(value.run).toBe(scope.run);
    if (value.kind === "message.delta") {
      expect(parseMessageDelta(value).ok).toBe(true);
    } else {
      expect(parseCanonicalEvent(value).ok).toBe(true);
      expect(value.seq).toBeGreaterThan(previousSeq);
      previousSeq = value.seq;
    }
    return value;
  };
}

function stale(observed: ObservedPosition): Stale {
  return { status: "stale", observed };
}

function actions(fixture: ProviderFixture, session: Session) {
  const capabilities = fixture.adapter.provider.capabilities;
  return [
    {
      kind: "steer",
      available: fixture.nonReceiptDelivery.status !== "unsupported",
      run: () => session.steer(fixture.steer),
    },
    {
      kind: "interrupt",
      available: capabilities.includes("interrupt"),
      run: () =>
        fixture.atActiveTurn(() => session.interrupt(fixture.interrupt)),
    },
    {
      kind: "answer",
      available: capabilities.includes("prompts"),
      run: () => fixture.atActiveTurn(() => session.answer(fixture.answer)),
    },
  ];
}

export function providerConformanceCases(create: () => ProviderFixture) {
  return {
    async "events are canonical, scoped and ordered"() {
      const fixture = create();
      for (const afterSeq of [fixture.scope.afterSeq, 0]) {
        const scope = { ...fixture.scope, afterSeq };
        const session = await open(fixture, scope);
        try {
          const read = reader(session.events[Symbol.asyncIterator](), scope);
          for (const [index, expected] of fixture.orderedEvents.entries()) {
            const [event] = await Promise.all([
              read(),
              fixture.sendEvent(index),
            ]);
            expect(event).toMatchObject(expected);
          }
        } finally {
          await session.close();
        }
      }
    },

    async "receipts are emitted at most once and require a valid fence"() {
      const fixture = create();
      const session = await open(fixture);
      const hasReceipts =
        fixture.adapter.provider.capabilities.includes("receipts");
      const read = reader(
        session.events[Symbol.asyncIterator](),
        fixture.scope,
      );
      const receipt = { delivery_id: fixture.steer.delivery_id };
      try {
        const seenReceipts: string[] = [];
        const drain = async () => {
          for (let event = await read(); event; event = await read()) {
            if (event.kind === "receipt")
              seenReceipts.push(event.body.delivery_id);
          }
        };
        const draining = drain();
        try {
          await fixture.sendEvent(0);
          if (hasReceipts) {
            const results = await Promise.all([
              session.steer(fixture.steer),
              session.steer(fixture.steer),
            ]);
            expect(results).toContainEqual({ status: "accepted", receipt });
            expect(results).toContainEqual({ status: "duplicate", receipt });
            expect(fixture.effects()).toEqual(["steer"]);
            const { expected } = fixture.steer;
            for (const wrong of [
              { run: expected.run + 1 },
              { fencing_token: "old-fence" },
            ]) {
              expect(
                await session.steer({
                  ...fixture.steer,
                  expected: { ...expected, ...wrong },
                }),
              ).toEqual(stale({ kind: "turn", turn: expected.turn }));
            }
            expect(fixture.effects()).toEqual(["steer"]);
          } else {
            const outcome = await session.steer(fixture.steer);
            expect(outcome).toMatchObject(fixture.nonReceiptDelivery);
            expect(fixture.effects()).toEqual(
              fixture.nonReceiptDelivery.status === "unsupported"
                ? []
                : ["steer"],
            );
          }
          await fixture.processExit();
          await draining;
        } finally {
          await session.close();
          await draining;
        }
        expect(seenReceipts).toEqual(hasReceipts ? [receipt.delivery_id] : []);
      } finally {
        await session.close();
      }
    },

    async "stale actions reach neither the agent nor the pane or leak a fence"() {
      const fixture = create();
      const session = await open(fixture);
      const { capabilities } = fixture.adapter.provider;
      try {
        if (fixture.nonReceiptDelivery.status !== "unsupported") {
          const { expected } = fixture.steer;
          for (const wrong of [
            { run: expected.run + 1 },
            { fencing_token: "old-fence" },
            { turn: "old-turn" },
          ]) {
            expect(
              await session.steer({
                ...fixture.steer,
                expected: { ...expected, ...wrong },
              }),
            ).toEqual(stale({ kind: "turn", turn: expected.turn }));
          }
          if (
            session.mode === "observe" &&
            expected.pane_instance !== undefined
          ) {
            expect(
              await session.steer({
                ...fixture.steer,
                expected: {
                  ...expected,
                  pane_instance: expected.pane_instance + 1,
                },
              }),
            ).toEqual(
              stale({
                kind: "terminal",
                pane_instance: expected.pane_instance,
              }),
            );
          }
        }
        await fixture.atActiveTurn(async () => {
          if (capabilities.includes("interrupt")) {
            const { expected } = fixture.interrupt;
            for (const wrong of [
              { run: expected.run + 1 },
              { fencing_token: "old-fence" },
              { turn: "old-turn" },
            ]) {
              expect(
                await session.interrupt({
                  expected: { ...expected, ...wrong },
                }),
              ).toEqual(stale({ kind: "turn", turn: expected.turn }));
            }
          }
          if (capabilities.includes("prompts")) {
            const { expected } = fixture.answer;
            for (const wrong of [
              { run: expected.run + 1 },
              { fencing_token: "old-fence" },
              { prompt_id: "old-prompt" },
            ]) {
              expect(
                await session.answer({
                  ...fixture.answer,
                  expected: { ...expected, ...wrong },
                }),
              ).toEqual(
                stale({
                  kind: "prompt",
                  run: expected.run,
                  prompt_id: expected.prompt_id,
                }),
              );
            }
          }
        });
        expect(fixture.effects()).toEqual([]);
      } finally {
        await session.close();
      }
    },

    async "advertised controls apply in the active turn"() {
      const fixture = create();
      const session = await open(fixture);
      const { capabilities } = fixture.adapter.provider;
      const applied: string[] = [];
      try {
        await fixture.atActiveTurn(async () => {
          if (capabilities.includes("steer-mid-turn")) {
            const outcome = await session.steer({
              ...fixture.steer,
              expected: {
                ...fixture.steer.expected,
                turn: fixture.interrupt.expected.turn,
              },
            });
            expect(outcome).toMatchObject(
              capabilities.includes("receipts")
                ? {
                    status: "accepted",
                    receipt: { delivery_id: fixture.steer.delivery_id },
                  }
                : fixture.nonReceiptDelivery,
            );
            applied.push("steer");
            expect(fixture.effects()).toEqual(applied);
          }
          if (capabilities.includes("interrupt")) {
            expect(await session.interrupt(fixture.interrupt)).toEqual(
              fixture.interruptOutcome,
            );
            applied.push("interrupt");
            expect(fixture.effects()).toEqual(applied);
          }
        });
        if (capabilities.includes("prompts")) {
          await fixture.atActiveTurn(async () => {
            expect(await session.answer(fixture.answer)).toEqual(
              fixture.answerOutcome,
            );
            applied.push("answer");
            expect(fixture.effects()).toEqual(applied);
          });
        }
      } finally {
        await session.close();
      }
    },

    async "resume opens the current checkpoint and recovers durable receipts when offered"() {
      const fixture = create();
      const session = await open(fixture);
      const { capabilities } = fixture.adapter.provider;
      if (session.mode !== "own" || !capabilities.includes("resume")) {
        await session.close();
        return;
      }
      const receipt = { delivery_id: fixture.steer.delivery_id };
      const hasReceipts = capabilities.includes("receipts");
      let spec: ResumeSpec;
      try {
        const before = session.getCheckpoint();
        const latest = await fixture.advanceCheckpoint();
        expect(latest).not.toBe(before);
        expect(session.getCheckpoint()).toBe(latest);
        if (hasReceipts)
          expect(await session.steer(fixture.steer)).toEqual({
            status: "accepted",
            receipt,
          });
        spec = fixture.resumeSpec(session.getCheckpoint());
      } finally {
        await session.close();
      }
      const resumed = await fixture.adapter.resume(spec);
      expect(resumed.status).toBe("opened");
      if (resumed.status !== "opened")
        throw new Error("Fixture did not resume");
      try {
        expect(resumed.session.getCheckpoint()).toBe(spec.checkpoint);
        expect(resumed.session.recoveredReceipts).toEqual(
          hasReceipts ? [receipt] : [],
        );
        if (hasReceipts) {
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
        }
        const read = reader(
          resumed.session.events[Symbol.asyncIterator](),
          spec,
        );
        const [first] = await Promise.all([read(), fixture.sendEvent(0)]);
        expect(first).toMatchObject(fixture.orderedEvents[0]);
        await fixture.processExit();
        for (let event = await read(); event; event = await read()) {
          expect(event.kind).not.toBe("receipt");
        }
      } finally {
        await resumed.session.close();
      }
    },

    async "unsupported operations have no effect"() {
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
        await fixture.atActiveTurn(async () => {
          if (!capabilities.includes("steer-mid-turn")) {
            expect(
              await session.steer({
                ...fixture.steer,
                expected: {
                  ...fixture.steer.expected,
                  turn: fixture.interrupt.expected.turn,
                },
              }),
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
        });
        expect(fixture.effects()).toEqual([]);
      } finally {
        await session.close();
      }
    },

    async "close releases once and denies every action and late event"() {
      const fixture = create();
      const session = await open(fixture);
      const events = session.events[Symbol.asyncIterator]();
      try {
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
        expect(await session.interrupt(fixture.interrupt)).toEqual({
          status: "closed",
        });
        expect(await session.answer(fixture.answer)).toEqual({
          status: "closed",
        });
        expect(fixture.effects()).toEqual([]);
      } finally {
        await session.close();
      }
    },

    async "close fences actions paused before their write"() {
      for (const index of [0, 1, 2]) {
        const fixture = create();
        const session = await open(fixture);
        const action = actions(fixture, session)[index];
        if (!action.available) {
          await session.close();
          continue;
        }
        const gate = fixture.pauseBeforeWrite();
        try {
          const outcome = action.run();
          const first = await Promise.race([
            gate.entered.then(() => "entered"),
            outcome.then(() => "returned"),
          ]);
          expect(first, action.kind).toBe("entered");
          const closed = session.close();
          gate.release();
          expect(await outcome, action.kind).toEqual({ status: "closed" });
          expect(await closed).toEqual({ status: "closed" });
          expect(fixture.effects()).toEqual([]);
        } finally {
          gate.release();
          await session.close();
        }
      }
    },

    async "close failure keeps the stream and actions closed"() {
      const fixture = create();
      const session = await open(fixture);
      const events = session.events[Symbol.asyncIterator]();
      const pending = events.next();
      const failure = fixture.failClose();
      try {
        expect(await Promise.all([session.close(), session.close()])).toEqual([
          failure,
          failure,
        ]);
        expect(fixture.releases()).toBe(1);
        await fixture.sendEvent(0);
        expect((await pending).done).toBe(true);
        expect((await events.next()).done).toBe(true);
        expect(await session.steer(fixture.steer)).toEqual({
          status: "closed",
        });
        expect(await session.interrupt(fixture.interrupt)).toEqual({
          status: "closed",
        });
        expect(await session.answer(fixture.answer)).toEqual({
          status: "closed",
        });
        expect(fixture.effects()).toEqual([]);
      } finally {
        await session.close();
      }
    },

    async "iterator applies backpressure and return releases pending reads and producers"() {
      const fixture = create();
      const session = await open(fixture);
      const events = session.events[Symbol.asyncIterator]();
      try {
        for (let index = 0; index < fixture.bufferCapacity; index++)
          await fixture.sendEvent(index);
        const overflow = fixture.sendEvent(fixture.bufferCapacity);
        expect(
          await Promise.race([
            fixture.waitForBackpressure().then(() => "blocked"),
            overflow.then(() => "accepted"),
          ]),
        ).toBe("blocked");
        expect((await events.next()).done).toBe(false);
        await overflow;
        const pendingProducer = fixture.sendEvent(fixture.bufferCapacity + 1);
        expect((await events.return()).done).toBe(true);
        await pendingProducer;
        await fixture.sendEvent(0);
        expect((await events.next()).done).toBe(true);
        expect(fixture.releases()).toBe(0);
      } finally {
        await session.close();
      }

      const fresh = create();
      const freshSession = await open(fresh);
      try {
        const iterator = freshSession.events[Symbol.asyncIterator]();
        const pending = iterator.next();
        expect((await iterator.return()).done).toBe(true);
        expect((await pending).done).toBe(true);
      } finally {
        await freshSession.close();
      }
    },

    async "process exit emits session.ended and a defect rejects the stream"() {
      const fixture = create();
      const session = await open(fixture);
      try {
        const read = reader(
          session.events[Symbol.asyncIterator](),
          fixture.scope,
        );
        const [last] = await Promise.all([read(), fixture.processExit()]);
        expect(last).toMatchObject({ kind: "session.ended" });
        expect(await read()).toBeUndefined();
      } finally {
        await session.close();
      }

      const fresh = create();
      const freshSession = await open(fresh);
      try {
        const read = reader(
          freshSession.events[Symbol.asyncIterator](),
          fresh.scope,
        );
        const pending = read();
        const fault = new Error("fixture defect");
        const result = pending.catch((error: unknown) => error);
        await fresh.streamDefect(fault);
        expect(await result).toBe(fault);
      } finally {
        await freshSession.close();
      }
    },
  };
}

export function providerConformance(
  name: string,
  create: () => ProviderFixture,
): void {
  describe(name, () => {
    for (const [label, check] of Object.entries(
      providerConformanceCases(create),
    )) {
      test(label, check);
    }
  });
}
