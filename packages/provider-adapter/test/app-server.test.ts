import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseCanonicalEvent,
  parseMessageDelta,
} from "@codecast/edge-contract";
import { it } from "@codecast/effect-kit/effect/testing";
import { providerConformance } from "@codecast/provider-contract/test";
import { waitFor } from "@codecast/test-helpers/waitFor";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { createProviderAdapter } from "../src";
import { ProviderAdapter, providerAdapterLayer } from "../src/effect";
import {
  answer,
  answerOutcome,
  approval,
  bestEffort,
  fixture,
  installAppServerFixtureHooks,
  interrupt,
  recorded,
  requireOpened,
  steer,
  threadId,
  turn,
} from "./app-server-fixture";

installAppServerFixtureHooks();
providerConformance("Codex app-server stdio", () => fixture().contract);

it.effect("a late rejection clears an ambiguous turn start after timeout", () =>
  Effect.gen(function* () {
    const fake = fixture({ FIXTURE_HOLD_START: "1" });
    const adapter = yield* ProviderAdapter.pipe(
      Effect.provide(providerAdapterLayer(fake.options)),
    );
    const { session } = requireOpened(yield* adapter.own(fake.spec));
    try {
      const first = yield* Effect.forkChild(session.steer(steer));
      expect(
        yield* Effect.promise(() =>
          waitFor(() => fake.observed().length === 1, 2500, 5),
        ),
      ).toBe(true);
      yield* TestClock.adjust("31 seconds");
      expect(yield* Fiber.join(first)).toMatchObject({
        status: "in-doubt",
        reason: "unknown",
        code: "timeout",
      });
      yield* Effect.promise(() => fake.wrote({ rejectStart: true }));
      const retry = yield* Effect.forkChild(session.steer(steer));
      expect(
        yield* Effect.promise(() =>
          waitFor(() => fake.observed().length === 2, 2500, 5),
        ),
      ).toBe(true);
      yield* Effect.promise(() => fake.wrote({ rejectStart: true }));
      expect(yield* Fiber.join(retry)).toMatchObject({
        status: "refused",
        code: "rpc-rejected",
      });
    } finally {
      yield* session.close;
    }
  }),
);

it.effect("replays recorded app-server items into ordered live events", () =>
  Effect.promise(async () => {
    const fake = fixture({ FIXTURE_HOLD_SECOND: "1" });
    const { session } = requireOpened(await fake.client.start(fake.spec));
    const events = session.events[Symbol.asyncIterator]();
    try {
      expect(await session.steer(steer)).toEqual(bestEffort);
      expect((await events.next()).value).toMatchObject({
        kind: "turn.started",
        turn,
      });
      const passed = fake.observed()[0]?.message.params;
      expect(passed?.sandboxPolicy).toEqual({
        type: "readOnly",
        networkAccess: false,
      });
      const completed = recorded.filter(
        (event) => event.method === "item/completed",
      );
      const echoed = completed.find(
        (event) => event.params.item?.type === "userMessage",
      )!;
      const assistant = completed.find(
        (event) => event.params.item?.type === "agentMessage",
      )!;
      const command = completed.find(
        (event) => event.params.item?.type === "commandExecution",
      )!;
      const itemId = assistant.params.item!.id;
      for (const delta of ["abc", "🦉"]) {
        await fake.wrote({
          frame: {
            method: "item/agentMessage/delta",
            params: { threadId, turnId: turn, itemId, delta },
          },
        });
      }
      for (const event of [echoed, command, assistant, assistant]) {
        await fake.wrote({
          frame: {
            ...event,
            params: { ...event.params, threadId, turnId: turn },
          },
        });
      }
      const completion = recorded.find(
        (event) => event.method === "turn/completed",
      )!;
      const wireTurn = completion.params.turn as object;
      await fake.wrote({
        frame: {
          ...completion,
          params: { threadId, turn: { ...wireTurn, id: turn } },
        },
      });
      const receive = async () => {
        const value = (await events.next()).value;
        expect(value?.turn).toBe(turn);
        expect(
          value?.kind === "message.delta"
            ? parseMessageDelta(value).ok
            : parseCanonicalEvent(value).ok,
        ).toBe(true);
        return value;
      };
      expect(await receive()).toMatchObject({
        kind: "message.delta",
        body: { message_id: itemId, offset: 0, text: "abc" },
      });
      expect(await receive()).toMatchObject({
        kind: "message.delta",
        body: { message_id: itemId, offset: 3, text: "🦉" },
      });
      expect(await receive()).toMatchObject({
        kind: "message.user",
        body: { authors: [] },
      });
      expect(await receive()).toMatchObject({
        kind: "tool.call",
        body: { call_id: command.params.item!.id, name: "commandExecution" },
      });
      expect(await receive()).toMatchObject({
        kind: "tool.result",
        body: { call_id: command.params.item!.id, is_error: false },
      });
      expect(await receive()).toMatchObject({
        kind: "message.assistant",
        body: { message_id: itemId },
      });
      expect(await receive()).toMatchObject({
        kind: "turn.ended",
        body: { reason: "completed" },
      });
      expect(fake.raw.some(({ line }) => line.includes("clientId"))).toBe(true);
      const next = session.steer(steer);
      expect(await waitFor(() => fake.observed().length === 2, 2500, 5)).toBe(
        true,
      );
      await fake.wrote({
        frame: {
          method: "turn/started",
          params: { threadId, turn: { id: turn, status: "inProgress" } },
        },
      });
      await fake.wrote({ ackStart: true });
      expect(await next).toEqual(bestEffort);
      expect((await events.next()).value).toMatchObject({
        kind: "turn.started",
        turn: "actual-turn-2",
      });
    } finally {
      await session.close();
    }
  }),
);

it.effect("a steer acknowledges only the named provider turn", () =>
  Effect.promise(async () => {
    const fake = fixture({
      FIXTURE_WRONG_STEER: "1",
      FIXTURE_REPLY_ONLY: "1",
      FIXTURE_INVALID_INTERRUPT: "1",
    });
    const { session } = requireOpened(await fake.client.start(fake.spec));
    try {
      expect(
        await session.steer({
          ...steer,
          input: [{ type: "local-image", path: "/fixture/picture.png" }],
        }),
      ).toEqual(bestEffort);
      const events = session.events[Symbol.asyncIterator]();
      expect((await events.next()).value).toMatchObject({
        kind: "turn.started",
        turn,
      });
      expect(fake.observed()[0]?.message.params?.input).toEqual([
        { type: "localImage", path: "/fixture/picture.png" },
      ]);
      expect(
        await session.steer({
          ...steer,
          expected: { ...steer.expected, turn },
        }),
      ).toMatchObject({
        status: "in-doubt",
        reason: "unknown",
        code: "invalid-steer",
      });
      expect(fake.observed()[1]?.message).toMatchObject({
        method: "turn/steer",
        params: { threadId, expectedTurnId: turn },
      });
      expect(await session.interrupt(interrupt)).toMatchObject({
        status: "in-doubt",
        reason: "unknown",
        code: "invalid-interrupt",
      });
    } finally {
      await session.close();
    }
  }),
);

it.effect(
  "wrong-thread and wrong-turn frames cannot open or settle a prompt",
  () =>
    Effect.promise(async () => {
      const fake = fixture();
      const { session } = requireOpened(await fake.client.start(fake.spec));
      const events = session.events[Symbol.asyncIterator]();
      try {
        await session.steer(steer);
        await events.next();
        await fake.wrote({ frame: approval("wrong-thread") });
        await fake.wrote({ frame: approval(threadId, "previous-turn") });
        expect(await session.answer(answer)).toMatchObject({ status: "stale" });
        const secret = `sk_test_${"a".repeat(28)}`;
        await fake.wrote({
          frame: {
            id: "approval",
            method: "item/permissions/requestApproval",
            params: {
              threadId,
              turnId: turn,
              itemId: "tool",
              reason: `Use\n${secret}`,
              permissions: { network: { enabled: true } },
            },
          },
        });
        expect((await events.next()).value).toMatchObject({
          kind: "prompt.opened",
          turn,
          body: { summary: "Use [redacted:stripe-secret-key]" },
        });
        expect(await session.answer(answer)).toEqual(answerOutcome);
        expect(
          await waitFor(
            () => fake.observed().some((entry) => entry.action === "answer"),
            2500,
            5,
          ),
        ).toBe(true);
        expect(fake.observed().at(-1)?.message.result).toEqual({
          permissions: { network: { enabled: true } },
          scope: "turn",
        });
        expect((await events.next()).value).toMatchObject({
          kind: "prompt.settled",
          turn,
        });
        await fake.wrote({
          frame: {
            method: "turn/completed",
            params: {
              threadId,
              turn: { id: turn, status: "failed", error: { message: secret } },
            },
          },
        });
        expect((await events.next()).value).toMatchObject({
          kind: "error",
          body: { message: "[redacted:stripe-secret-key]" },
        });
        expect((await events.next()).value).toMatchObject({
          kind: "turn.ended",
          turn,
        });
        expect(
          fake.raw.filter(({ disposition }) => disposition === "replay"),
        ).toHaveLength(2);
      } finally {
        await session.close();
      }
    }),
);

it.effect("an RPC refusal redacts diagnostics and frees the turn start", () =>
  Effect.promise(async () => {
    const secret = `sk_test_${"a".repeat(28)}`;
    const fake = fixture({ FIXTURE_START_ERROR: `Bad key ${secret}` });
    const { session } = requireOpened(await fake.client.start(fake.spec));
    try {
      for (let i = 0; i < 2; i++) {
        expect(await session.steer(steer)).toEqual({
          status: "refused",
          code: "rpc-rejected",
          message: "Bad key [redacted:stripe-secret-key]",
        });
      }
      expect(fake.observed()).toHaveLength(2);
      expect(fake.raw.some(({ line }) => line.includes(secret))).toBe(true);
    } finally {
      await session.close();
    }
  }),
);

it.effect("resume verifies the checkpoint and ignores saved turns", () =>
  Effect.promise(async () => {
    const fake = fixture();
    const { session } = requireOpened(
      await fake.client.resume({ ...fake.spec, checkpoint: threadId }),
    );
    const events = session.events[Symbol.asyncIterator]();
    try {
      expect(session.getCheckpoint()).toBe(threadId);
      expect(session.recoveredReceipts).toEqual([]);
      expect(
        JSON.parse(
          readFileSync(join(fake.directory, "thread-request"), "utf8"),
        ),
      ).toMatchObject({
        method: "thread/resume",
        params: { threadId, cwd: fake.directory },
      });
      await fake.wrote({
        frame: {
          method: "turn/started",
          params: {
            threadId,
            turn: { id: "historical-turn", status: "inProgress" },
          },
        },
      });
      await fake.wrote({ frame: { method: "turn/future", params: {} } });
      await fake.wrote({
        frame: {
          method: "thread/status/changed",
          params: { threadId, status: { type: "idle" } },
        },
      });
      expect((await events.next()).value).toMatchObject({
        kind: "context",
        turn: null,
      });
      const unknown = fake.raw.filter(
        ({ disposition }) => disposition === "unknown",
      );
      expect(unknown.some(({ line }) => line.includes("turn/future"))).toBe(
        true,
      );
      expect(session.getUnknownPayloadCount()).toBe(unknown.length);
      expect(
        fake.raw.some(
          ({ disposition, line }) =>
            disposition === "replay" && line.includes("historical-turn"),
        ),
      ).toBe(true);
    } finally {
      await session.close();
    }
    const wrong = fixture({ FIXTURE_WRONG_CHECKPOINT: "1" });
    expect(
      await wrong.client.resume({ ...wrong.spec, checkpoint: threadId }),
    ).toMatchObject({ status: "in-doubt", code: "checkpoint-mismatch" });
  }),
);

it.effect(
  "question replies are fenced by question ID and keep secret values off canonical events",
  () =>
    Effect.promise(async () => {
      const fake = fixture();
      const { session } = requireOpened(await fake.client.start(fake.spec));
      const events = session.events[Symbol.asyncIterator]();
      try {
        await session.steer(steer);
        await events.next();
        await fake.wrote({
          frame: {
            id: "approval",
            method: "item/tool/requestUserInput",
            params: {
              threadId,
              turnId: turn,
              itemId: "questions",
              questions: [
                {
                  id: "choice",
                  question: "Which one?",
                  options: [{ label: "A", description: "First" }],
                },
                { id: "key", question: "API key?", isSecret: true },
              ],
            },
          },
        });
        expect((await events.next()).value).toMatchObject({
          kind: "prompt.opened",
          body: { kind: "question" },
        });
        expect((await events.next()).value).toMatchObject({
          kind: "context",
          body: {
            data: {
              questions: [
                {
                  id: "choice",
                  options: [{ label: "A", description: "First" }],
                },
                { id: "key", is_secret: true },
              ],
            },
          },
        });
        expect(
          await session.answer({
            ...answer,
            answer: { answers: { other: { answers: ["wrong"] } } },
          }),
        ).toMatchObject({ status: "refused", code: "invalid-answer" });
        const response = {
          answers: {
            choice: { answers: ["A"] },
            key: { answers: ["sensitive"] },
          },
        };
        expect(await session.answer({ ...answer, answer: response })).toEqual(
          answerOutcome,
        );
        expect(
          await waitFor(
            () => fake.observed().some((entry) => entry.action === "answer"),
            2500,
            5,
          ),
        ).toBe(true);
        expect(fake.observed().at(-1)?.message.result).toEqual(response);
        expect((await events.next()).value).toMatchObject({
          kind: "prompt.settled",
          body: {
            answer: {
              answers: {
                choice: { answers: ["A"] },
                key: { answers: ["[redacted]"] },
              },
            },
          },
        });
      } finally {
        await session.close();
      }
    }),
);

it.effect(
  "a pending turn start keeps concurrent delivery in doubt until its refusal",
  () =>
    Effect.promise(async () => {
      const fake = fixture({ FIXTURE_HOLD_START: "1" });
      const { session } = requireOpened(await fake.client.start(fake.spec));
      try {
        const first = session.steer(steer);
        expect(await waitFor(() => fake.observed().length === 1, 2500, 5)).toBe(
          true,
        );
        expect(await session.steer(steer)).toMatchObject({
          status: "in-doubt",
          reason: "unknown",
          code: "turn-pending",
        });
        expect(fake.observed()).toHaveLength(1);
        await fake.wrote({ rejectStart: true });
        expect(await first).toMatchObject({
          status: "refused",
          code: "rpc-rejected",
        });
        const retry = session.steer(steer);
        expect(await waitFor(() => fake.observed().length === 2, 2500, 5)).toBe(
          true,
        );
        await fake.wrote({ rejectStart: true });
        expect(await retry).toMatchObject({
          status: "refused",
          code: "rpc-rejected",
        });
      } finally {
        await session.close();
      }
    }),
);

it.effect(
  "a resumed thread with no live turn ID waits for confirmed idle",
  () =>
    Effect.promise(async () => {
      const fake = fixture({ FIXTURE_ACTIVE: "1" });
      const { session } = requireOpened(
        await fake.client.resume({ ...fake.spec, checkpoint: threadId }),
      );
      try {
        expect(await session.steer(steer)).toMatchObject({
          status: "in-doubt",
          reason: "unknown",
          code: "turn-pending",
        });
        expect(fake.observed()).toHaveLength(0);
        await fake.wrote({
          frame: {
            method: "thread/status/changed",
            params: { threadId, status: { type: "idle" } },
          },
        });
        expect(await session.steer(steer)).toEqual(bestEffort);
      } finally {
        await session.close();
      }
    }),
);

it.effect(
  "registry and initialization reject unverified versions before thread start",
  () =>
    Effect.promise(async () => {
      const fake = fixture({ FIXTURE_USER_AGENT: "codex_cli_rs/0.171.0" });
      expect(fake.client.provider.capabilities).toEqual([
        "own",
        "steer-mid-turn",
        "interrupt",
        "prompts",
        "resume",
      ]);
      expect(await fake.client.start(fake.spec)).toMatchObject({
        status: "refused",
        code: "agent-version",
      });
      expect(
        fake.raw.some(({ line }) => line.includes("codex_cli_rs/0.171.0")),
      ).toBe(true);
      expect(fake.observed()).toEqual([]);
    }),
);

it.effect(
  "command approvals respect offered decisions and server resolution",
  () =>
    Effect.promise(async () => {
      const fake = fixture();
      const { session } = requireOpened(await fake.client.start(fake.spec));
      try {
        await session.steer(steer);
        const request = approval();
        await fake.wrote({
          frame: {
            ...request,
            params: { ...request.params, availableDecisions: ["decline"] },
          },
        });
        expect(await session.answer(answer)).toMatchObject({
          status: "refused",
          code: "invalid-answer",
        });
        await fake.wrote({
          frame: {
            method: "serverRequest/resolved",
            params: { threadId, requestId: request.id },
          },
        });
        expect(
          await session.answer({ ...answer, answer: { behavior: "deny" } }),
        ).toMatchObject({ status: "stale" });
        expect(fake.observed().map(({ action }) => action)).toEqual(["steer"]);
      } finally {
        await session.close();
      }
    }),
);

it.effect(
  "a completed turn in a start reply leaves the next start usable",
  () =>
    Effect.promise(async () => {
      const fake = fixture({ FIXTURE_COMPLETED_REPLY: "1" });
      const { session } = requireOpened(await fake.client.start(fake.spec));
      try {
        expect(await session.steer(steer)).toEqual(bestEffort);
        expect(await session.steer(steer)).toEqual(bestEffort);
        expect(
          (await session.events[Symbol.asyncIterator]().next()).value,
        ).toMatchObject({
          kind: "turn.started",
          turn: "actual-turn-2",
        });
      } finally {
        await session.close();
      }
    }),
);

it.effect("failed open waits for asynchronous handshake retention", () =>
  Effect.promise(async () => {
    const fake = fixture({ FIXTURE_WRONG_CHECKPOINT: "1" });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const client = createProviderAdapter({
      ...fake.options,
      async retainRaw(frame, signal) {
        if (frame.line.includes("wrong-thread")) {
          entered.resolve();
          await release.promise;
          signal.throwIfAborted();
        }
        fake.options.retainRaw(frame);
      },
    });
    try {
      const opened = client.resume({ ...fake.spec, checkpoint: threadId });
      await entered.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      release.resolve();
      expect(await opened).toMatchObject({
        status: "in-doubt",
        code: "checkpoint-mismatch",
      });
      expect(fake.raw.some(({ line }) => line.includes("wrong-thread"))).toBe(
        true,
      );
    } finally {
      release.resolve();
      await client.dispose();
    }
  }),
);
