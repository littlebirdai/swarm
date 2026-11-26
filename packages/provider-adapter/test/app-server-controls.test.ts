import { readEvent, requireOpened } from "./provider-fixture";
import { appServerCase } from "./app-server-fixture";
import { expect } from "bun:test";
import { parseCanonicalEvent } from "@codecast/edge-contract";
import { it } from "@codecast/effect-kit/effect/testing";
import type { SteerRequest } from "@codecast/provider-contract";
import { waitFor } from "@codecast/test-helpers/waitFor";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ProviderAdapter, providerAdapterLayer } from "../src/effect";
import {
  answer,
  answerOutcome,
  approval,
  bestEffort,
  fixture,
  installAppServerFixtureHooks,
  interrupt,
  steer,
  threadId,
  turn,
} from "./app-server-fixture";

installAppServerFixtureHooks();

for (const method of ["turn/start", "turn/steer", "turn/interrupt"]) {
  appServerCase(
    `${method} settles with 35 unread notifications in wire order`,
    async (session) => {
      const next = readEvent(session);
      if (method !== "turn/start") {
        expect(await session.steer(steer)).toEqual(bestEffort);
        expect(await next()).toMatchObject({
          kind: "turn.started",
          turn,
        });
      }
      const pending =
        method === "turn/interrupt"
          ? session.interrupt(interrupt)
          : session.steer({
              ...steer,
              expected: {
                ...steer.expected,
                turn: method === "turn/start" ? null : turn,
              },
            });
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      expect(await waitFor(() => settled, 1500, 5)).toBe(true);
      expect(await pending).toEqual(
        method === "turn/interrupt" ? { status: "applied" } : bestEffort,
      );
      for (let index = 0; index < 35; index++) {
        expect(await next()).toMatchObject({
          kind: "context",
          turn: method === "turn/start" ? null : turn,
          body: { data: { name: String(index) } },
        });
      }
      if (method === "turn/start")
        expect(await next()).toMatchObject({
          kind: "turn.started",
          turn,
        });
    },
    {
      FIXTURE_BURST_METHOD: method,
      FIXTURE_REPLY_ONLY: "1",
    },
  );
}

function echo(text: string) {
  return {
    method: "item/completed",
    params: {
      threadId,
      turnId: turn,
      item: {
        type: "userMessage",
        id: "echo",
        content: [{ type: "text", text }],
      },
    },
  };
}

it.effect(
  "a late steer refusal frees attribution for the next identical steer",
  () =>
    Effect.gen(function* () {
      const fake = fixture({ FIXTURE_HOLD_FIRST_STEER: "1" });
      const adapter = yield* ProviderAdapter.pipe(
        Effect.provide(providerAdapterLayer(fake.options)),
      );
      const { session } = requireOpened(yield* adapter.own(fake.spec));
      const events = Stream.toAsyncIterable(session.events)[
        Symbol.asyncIterator
      ]();
      try {
        expect(yield* session.steer(steer)).toEqual(bestEffort);
        expect(
          (yield* Effect.promise(() => events.next())).value,
        ).toMatchObject({ kind: "turn.started" });
        const base: SteerRequest = {
          ...steer,
          expected: { ...steer.expected, turn },
          input: [{ type: "text", text: "repeat" }],
        };
        const first = yield* Effect.forkChild(
          session.steer({
            ...base,
            delivery_id: "first",
            authors: [{ kind: "person", id: "first-author" }],
          }),
        );
        expect(
          yield* Effect.promise(() =>
            waitFor(() => fake.observed().length === 2, 2500, 5),
          ),
        ).toBe(true);
        yield* TestClock.adjust("31 seconds");
        expect(yield* Fiber.join(first)).toMatchObject({
          status: "in-doubt",
          code: "timeout",
        });
        yield* Effect.promise(() => fake.wrote({ rejectSteer: true }));
        const second = {
          ...base,
          delivery_id: "second",
          authors: [{ kind: "person" as const, id: "second-author" }],
        };
        expect(yield* session.steer(second)).toEqual(bestEffort);
        yield* Effect.promise(() => fake.wrote({ frame: echo("repeat") }));
        expect(
          (yield* Effect.promise(() => events.next())).value,
        ).toMatchObject({
          kind: "message.user",
          body: {
            text: "repeat",
            delivery_id: second.delivery_id,
            authors: second.authors,
          },
        });
        expect(
          fake.raw.some(
            ({ line, disposition }) =>
              line.includes("Delayed steer refusal") &&
              disposition === "decoded",
          ),
        ).toBe(true);
      } finally {
        yield* session.close;
      }
    }),
);

appServerCase(
  "an approval refuses option IDs and invalid canonical settlements",
  async (session, fake) => {
    const events = session.events[Symbol.asyncIterator]();
    await session.steer(steer);
    await fake.wrote({ frame: approval() });
    for (const request of [
      { ...answer, answer: { behavior: "allow", option_id: "accept" } },
      { ...answer, answer: { behavior: "allow", option_id: "" } },
      { ...answer, by: { ...answer.by, id: "" } },
    ]) {
      expect(await session.answer(request)).toMatchObject({
        status: "refused",
        code: "invalid-answer",
      });
    }
    expect(await session.answer(answer)).toEqual(answerOutcome);
    for (const kind of [
      "turn.started",
      "prompt.opened",
      "prompt.settled",
    ] as const) {
      const item = (await events.next()).value;
      expect(item?.kind).toBe(kind);
      expect(parseCanonicalEvent(item).ok).toBe(true);
    }
  },
);

appServerCase(
  "a failed notification with no error message still ends the turn",
  async (session, fake) => {
    const next = readEvent(session);
    expect(await session.steer(steer)).toEqual(bestEffort);
    expect(await next()).toMatchObject({
      kind: "turn.started",
      turn,
    });
    await fake.wrote({
      frame: {
        method: "turn/completed",
        params: {
          threadId,
          turn: { id: turn, status: "failed", error: {} },
        },
      },
    });
    expect(await session.steer(steer)).toEqual(bestEffort);
    expect(await next()).toMatchObject({
      kind: "error",
      turn,
      body: { message: "Codex turn failed" },
    });
    expect(await next()).toMatchObject({
      kind: "turn.ended",
      turn,
      body: { reason: "failed" },
    });
  },
);

appServerCase(
  "a terminal start reply starts and ends one turn and permits the next idle steer",
  async (session) => {
    const next = readEvent(session);
    expect(await session.steer(steer)).toEqual(bestEffort);
    expect(await session.steer(steer)).toEqual(bestEffort);
    for (const id of [turn, "actual-turn-2"]) {
      expect(await next()).toMatchObject({
        kind: "turn.started",
        turn: id,
      });
      expect(await next()).toMatchObject({
        kind: "turn.ended",
        turn: id,
        body: { reason: "completed" },
      });
    }
  },
  {
    FIXTURE_REPLY_ONLY: "1",
    FIXTURE_TERMINAL_START: "1",
  },
);

appServerCase(
  "a null approval uses offered cancel when decline is unavailable",
  async (session, fake) => {
    await session.steer(steer);
    const frame = approval();
    await fake.wrote({
      frame: {
        ...frame,
        params: {
          ...frame.params,
          availableDecisions: ["accept", "cancel"],
        },
      },
    });
    expect(await session.answer({ ...answer, answer: null })).toEqual(
      answerOutcome,
    );
    expect(
      await waitFor(
        () => fake.observed().some(({ action }) => action === "answer"),
        1500,
        5,
      ),
    ).toBe(true);
    expect(fake.observed().at(-1)?.message.result).toEqual({
      decision: "cancel",
    });
  },
);

appServerCase(
  "an echoed user item carries the matched delivery ID and authors",
  async (session, fake) => {
    const next = readEvent(session);
    expect(await session.steer(steer)).toEqual(bestEffort);
    await fake.wrote({ frame: echo("test message") });
    expect(await next()).toMatchObject({
      kind: "turn.started",
      turn,
    });
    expect(await next()).toMatchObject({
      kind: "message.user",
      turn,
      body: { delivery_id: steer.delivery_id, authors: steer.authors },
    });
  },
);

appServerCase(
  "overflowing stdout read-ahead reports a bounded failure",
  async (session) => {
    expect(await session.steer(steer)).toMatchObject({
      status: "in-doubt",
      reason: "unknown",
      code: "output-overflow",
    });
    const events = session.events[Symbol.asyncIterator]();
    for (let index = 0; index < 32; index++) {
      expect((await events.next()).value).toMatchObject({
        kind: "context",
        body: { data: { name: String(index) } },
      });
    }
    await expect(
      (async () => {
        while (!(await events.next()).done) {}
      })(),
    ).rejects.toThrow("stdout read-ahead limit");
  },
  {
    FIXTURE_BURST_METHOD: "turn/start",
    FIXTURE_BURST_COUNT: "128",
    FIXTURE_REPLY_ONLY: "1",
  },
);

it.effect("forgotten turn RPC IDs retain only a bounded recent history", () =>
  Effect.gen(function* () {
    const fake = fixture({ FIXTURE_HOLD_ALL_STEERS: "1" });
    const adapter = yield* ProviderAdapter.pipe(
      Effect.provide(providerAdapterLayer(fake.options)),
    );
    const { session } = requireOpened(yield* adapter.own(fake.spec));
    try {
      expect(yield* session.steer(steer)).toEqual(bestEffort);
      const request = { ...steer, expected: { ...steer.expected, turn } };
      const sending = yield* Effect.forkChild(
        Effect.forEach(
          Array.from({ length: 130 }, (_, index) => index),
          (index) =>
            session.steer({ ...request, delivery_id: `pending-${index}` }),
          { concurrency: "unbounded" },
        ),
      );
      expect(
        yield* Effect.promise(() =>
          waitFor(() => fake.observed().length === 131, 2500, 5),
        ),
      ).toBe(true);
      yield* TestClock.adjust("31 seconds");
      expect(
        (yield* Fiber.join(sending)).every(
          (outcome) =>
            outcome.status === "in-doubt" && outcome.code === "timeout",
        ),
      ).toBe(true);
      const sent = fake.observed();
      for (const [id, message] of [
        [sent[1]?.message.id, "old refusal"],
        [sent.at(-1)?.message.id, "recent refusal"],
      ] as const) {
        yield* Effect.promise(() =>
          fake.wrote({ frame: { id, error: { code: -32000, message } } }),
        );
      }
      expect(
        fake.raw.find(({ line }) => line.includes("old refusal"))?.disposition,
      ).toBe("unknown");
      expect(
        fake.raw.find(({ line }) => line.includes("recent refusal"))
          ?.disposition,
      ).toBe("decoded");
    } finally {
      yield* session.close;
    }
  }),
);
