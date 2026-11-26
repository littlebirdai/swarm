import { expect } from "bun:test";
import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "@codecast/effect-kit/effect/testing";
import type {
  DeliveryReceiptJournal,
  DeliveryReceiptRecord,
  ProviderEvent,
} from "@codecast/provider-contract";
import { waitFor } from "@codecast/test-helpers/waitFor";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ProviderAdapter, providerAdapterLayer } from "../src/effect";
import {
  fixture,
  installAppServerFixtureHooks,
  steer,
  threadId,
  turn,
} from "./app-server-fixture";
import { requireOpened } from "./provider-fixture";

installAppServerFixtureHooks();

function journalAt(directory: string): DeliveryReceiptJournal {
  const path = join(directory, "delivery-receipts.jsonl");
  return {
    async read(session, checkpoint) {
      const source = await readFile(path, "utf8").catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return "";
          throw error;
        },
      );
      return source
        .trim()
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          const saved: {
            session: string;
            checkpoint: string;
            record: DeliveryReceiptRecord;
          } = JSON.parse(line);
          return saved.session === session && saved.checkpoint === checkpoint
            ? [saved.record]
            : [];
        });
    },
    async record(session, checkpoint, record) {
      const file = await open(path, "a");
      try {
        await file.writeFile(
          JSON.stringify({ session, checkpoint, record }) + "\n",
        );
        await file.sync();
      } finally {
        await file.close();
      }
    },
  };
}

function adapter(
  fake: ReturnType<typeof fixture>,
  receiptJournal = journalAt(fake.directory),
) {
  return ProviderAdapter.pipe(
    Effect.provide(providerAdapterLayer({ ...fake.options, receiptJournal })),
  );
}

function userItem(
  fake: ReturnType<typeof fixture>,
  id: string,
  clientId: unknown,
  method = "item/completed",
) {
  return Effect.promise(() =>
    fake.wrote({
      frame: {
        method,
        params: {
          threadId,
          turnId: turn,
          item: { type: "userMessage", id, clientId, content: steer.input },
        },
      },
    }),
  );
}

function receipts(events: readonly ProviderEvent[]) {
  return events.flatMap((event) =>
    event.kind === "receipt" ? [event.body] : [],
  );
}

it.effect("an accepted provider item commits before emitting one receipt", () =>
  Effect.gen(function* () {
    const fake = fixture({ FIXTURE_HOLD_START: "1" });
    const journal = journalAt(fake.directory);
    const recording = yield* Deferred.make<void>();
    const allowCommit = yield* Deferred.make<void>();
    const provider = yield* adapter(fake, {
      ...journal,
      async record(session, checkpoint, receipt, signal) {
        await Effect.runPromise(Deferred.succeed(recording, undefined));
        await Effect.runPromise(Deferred.await(allowCommit), { signal });
        await journal.record(session, checkpoint, receipt, signal);
      },
    });
    expect(provider.provider.capabilities).toContain("receipts");
    const { session } = requireOpened(yield* provider.own(fake.spec));
    const announced = yield* Deferred.make<void>();
    const events = yield* Effect.forkChild(
      session.events.pipe(
        Stream.tap((event) =>
          event.kind === "receipt"
            ? Deferred.succeed(announced, undefined)
            : Effect.void,
        ),
        Stream.runCollect,
      ),
    );
    const delivery = yield* Effect.forkChild(session.steer(steer));
    expect(
      yield* Effect.promise(() =>
        waitFor(() => fake.observed().length === 1, 2500, 5),
      ),
    ).toBe(true);
    const clientId = fake.observed()[0]?.message.params?.clientUserMessageId;
    expect(clientId).toBe("codecast-delivery:delivery");
    yield* Effect.promise(() =>
      fake.wrote({
        frame: {
          method: "turn/started",
          params: { threadId, turn: { id: turn, status: "inProgress" } },
        },
      }),
    );
    const accepting = yield* Effect.forkChild(
      userItem(fake, "accepted-item", clientId),
    );
    yield* Deferred.await(recording);
    yield* Effect.yieldNow;
    expect(yield* Deferred.isDone(announced)).toBe(false);
    yield* Deferred.succeed(allowCommit, undefined);
    yield* Fiber.join(accepting);
    yield* Deferred.await(announced);
    expect(
      yield* Effect.promise((signal) =>
        journal.read(fake.spec.session, threadId, signal),
      ),
    ).toEqual([
      {
        delivery_id: steer.delivery_id,
        provider_item_id: "accepted-item",
        turn,
      },
    ]);
    yield* Effect.promise(() => fake.wrote({ ackStart: true }));
    const receipt = { delivery_id: steer.delivery_id };
    expect(yield* Fiber.join(delivery)).toEqual({
      status: "accepted",
      receipt,
    });
    expect(
      yield* session.steer({ ...steer, expected: { ...steer.expected, turn } }),
    ).toEqual({ status: "duplicate", receipt });
    yield* userItem(fake, "accepted-item", clientId);
    yield* Effect.promise(fake.contract.processExit);
    expect(receipts(yield* Fiber.join(events))).toEqual([receipt]);
    expect(fake.observed()).toHaveLength(1);
  }),
);

it.effect("a failed journal write leaves steer in doubt with no receipt", () =>
  Effect.gen(function* () {
    const fake = fixture();
    const journal = journalAt(fake.directory);
    const writeAttempted = yield* Deferred.make<void>();
    const provider = yield* adapter(fake, {
      ...journal,
      async record() {
        await Effect.runPromise(Deferred.succeed(writeAttempted, undefined));
        throw new Error("Receipt journal unavailable");
      },
    });
    const { session } = requireOpened(yield* provider.own(fake.spec));
    const events = yield* Effect.forkChild(Stream.runCollect(session.events));
    expect(yield* session.steer(steer)).toMatchObject({ status: "in-doubt" });
    yield* userItem(
      fake,
      "accepted-item",
      fake.observed()[0]?.message.params?.clientUserMessageId,
    );
    yield* Deferred.await(writeAttempted);
    expect(
      yield* session.steer({ ...steer, expected: { ...steer.expected, turn } }),
    ).toMatchObject({ status: "in-doubt" });
    expect(fake.observed()).toHaveLength(1);
    yield* Effect.promise(fake.contract.processExit);
    expect(receipts(yield* Fiber.join(events))).toEqual([]);
    expect(
      yield* Effect.promise((signal) =>
        journal.read(fake.spec.session, threadId, signal),
      ),
    ).toEqual([]);
  }),
);

it.effect(
  "identical sends get their own item IDs when acceptance arrives out of order",
  () =>
    Effect.gen(function* () {
      const fake = fixture();
      const journal = journalAt(fake.directory);
      const provider = yield* adapter(fake, journal);
      const { session } = requireOpened(yield* provider.own(fake.spec));
      const events = yield* Effect.forkChild(Stream.runCollect(session.events));
      const second = {
        ...steer,
        delivery_id: "second-delivery",
        expected: { ...steer.expected, turn },
      };
      expect(yield* session.steer(steer)).toMatchObject({ status: "in-doubt" });
      expect(yield* session.steer(second)).toMatchObject({
        status: "in-doubt",
      });
      const [firstCall, secondCall] = fake.observed();
      expect(firstCall?.message.params?.input).toEqual(
        secondCall?.message.params?.input,
      );
      yield* userItem(
        fake,
        "second-item",
        secondCall?.message.params?.clientUserMessageId,
      );
      yield* userItem(
        fake,
        "first-item",
        firstCall?.message.params?.clientUserMessageId,
      );
      yield* Effect.promise(fake.contract.processExit);
      expect(receipts(yield* Fiber.join(events))).toEqual([
        { delivery_id: second.delivery_id },
        { delivery_id: steer.delivery_id },
      ]);
      expect(
        yield* Effect.promise((signal) =>
          journal.read(fake.spec.session, threadId, signal),
        ),
      ).toEqual([
        {
          delivery_id: second.delivery_id,
          provider_item_id: "second-item",
          turn,
        },
        {
          delivery_id: steer.delivery_id,
          provider_item_id: "first-item",
          turn,
        },
      ]);
    }),
);

it.effect(
  "a restarted adapter replays each requested in-doubt receipt once",
  () =>
    Effect.gen(function* () {
      const fake = fixture();
      const provider = yield* adapter(fake);
      const { session } = requireOpened(yield* provider.own(fake.spec));
      const events = yield* Effect.forkChild(Stream.runCollect(session.events));
      expect(yield* session.steer(steer)).toMatchObject({ status: "in-doubt" });
      const checkpoint = session.getCheckpoint();
      yield* userItem(
        fake,
        "late-item",
        fake.observed()[0]?.message.params?.clientUserMessageId,
      );
      yield* Effect.promise(fake.contract.processExit);
      const receipt = { delivery_id: steer.delivery_id };
      expect(receipts(yield* Fiber.join(events))).toEqual([receipt]);
      yield* session.close;

      const fresh = fixture();
      const restarted = yield* adapter(fresh, journalAt(fake.directory));
      const resumed = requireOpened(
        yield* restarted.own({
          ...fresh.spec,
          checkpoint,
          run: 2,
          afterSeq: 30,
          inDoubtDeliveryIds: [steer.delivery_id, steer.delivery_id, "missing"],
        }),
      ).session;
      expect(resumed.recoveredReceipts).toEqual([receipt]);
      const recoveredEvents = yield* Effect.forkChild(
        Stream.runCollect(resumed.events),
      );
      expect(
        yield* resumed.steer({
          ...steer,
          expected: { ...steer.expected, run: 2 },
        }),
      ).toEqual({ status: "duplicate", receipt });
      expect(fresh.observed()).toHaveLength(0);

      yield* Effect.promise(() =>
        fresh.wrote({
          frame: {
            method: "thread/status/changed",
            params: { threadId, status: { type: "idle" } },
          },
        }),
      );
      const nextDelivery = { delivery_id: "post-resume-delivery" };
      expect(
        yield* resumed.steer({
          ...steer,
          ...nextDelivery,
          expected: { ...steer.expected, run: 2 },
        }),
      ).toMatchObject({ status: "in-doubt" });
      yield* userItem(
        fresh,
        "post-resume-item",
        fresh.observed()[0]?.message.params?.clientUserMessageId,
      );
      yield* Effect.promise(fresh.contract.processExit);
      const eventsAfterResume = yield* Fiber.join(recoveredEvents);
      const emitted = eventsAfterResume.filter(
        (event) => event.kind === "receipt",
      );
      expect(emitted).toMatchObject([
        { run: 2, seq: 31, body: receipt },
        { run: 2, turn, body: nextDelivery },
      ]);
      expect(eventsAfterResume).toContainEqual(
        expect.objectContaining({
          kind: "context",
          body: { data: { status: { type: "idle" } } },
        }),
      );
      expect(fresh.observed()).toHaveLength(1);
    }),
);

it.effect(
  "an RPC success and a content echo without the client ID produce no receipt",
  () =>
    Effect.gen(function* () {
      const fake = fixture({ FIXTURE_HOLD_ALL_STEERS: "1" });
      const provider = yield* adapter(fake);
      const { session } = requireOpened(yield* provider.own(fake.spec));
      const events = yield* Effect.forkChild(Stream.runCollect(session.events));
      expect(yield* session.steer(steer)).toMatchObject({
        status: "in-doubt",
        reason: "best-effort",
      });
      yield* userItem(fake, "no-client-id", null);
      yield* userItem(fake, "wrong-client-id", "other-input");
      const pending = yield* Effect.forkChild(
        session.steer({
          ...steer,
          delivery_id: "timeout-delivery",
          expected: { ...steer.expected, turn },
        }),
      );
      expect(
        yield* Effect.promise(() =>
          waitFor(() => fake.observed().length === 2, 2500, 5),
        ),
      ).toBe(true);
      yield* userItem(
        fake,
        "only-started",
        fake.observed()[1]?.message.params?.clientUserMessageId,
        "item/started",
      );
      yield* TestClock.adjust("31 seconds");
      expect(yield* Fiber.join(pending)).toMatchObject({
        status: "in-doubt",
        code: "timeout",
      });
      yield* Effect.promise(fake.contract.processExit);
      expect(receipts(yield* Fiber.join(events))).toEqual([]);
      expect(
        yield* Effect.promise((signal) =>
          journalAt(fake.directory).read(fake.spec.session, threadId, signal),
        ),
      ).toEqual([]);
    }),
);
