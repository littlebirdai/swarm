import { readEvent, requireOpened } from "./provider-fixture";
import { expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "@codecast/effect-kit/effect/testing";
import { providerConformance } from "@codecast/provider-contract/test";
import { waitFor } from "@codecast/test-helpers/waitFor";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { ProviderAdapter, providerAdapterLayer } from "../src/effect";
import {
  answer,
  approval,
  claudeCase,
  fence,
  fixture,
  installClaudeFixtureHooks,
  interrupt,
  interruptReply,
  noAnswerAck,
  noReceipt,
  runningFrame,
  steer,
} from "./claude-sdk-fixture";

installClaudeFixtureHooks();
providerConformance("Claude SDK stdio", () => fixture().contract);

it.effect(
  "owned Claude starts with SDK persistence and no parent session markers",
  () =>
    Effect.promise(async () => {
      const fake = fixture({
        CLAUDECODE: "1",
        CLAUDE_CODE_CHILD_SESSION: "1",
        CLAUDE_CODE_SESSION_ID: "parent",
        CLAUDE_CODE_ENTRYPOINT: "parent",
        CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "0",
      });
      requireOpened(await fake.client.start(fake.spec));
      expect(fake.sessionEnv()).toEqual({
        entrypoint: "sdk-ts",
        persistence: "1",
      });
    }),
);

it.effect("initialize retains a wrong version and refuses to open", () =>
  Effect.promise(async () => {
    const fake = fixture({ FIXTURE_CLAUDE_VERSION: "2.1.318" });
    expect(await fake.client.start(fake.spec)).toMatchObject({
      status: "refused",
      code: "agent-version",
    });
    expect(fake.raw.some(({ line }) => line.includes("2.1.318"))).toBe(true);
    expect(fake.observed()).toEqual([]);
  }),
);

claudeCase(
  "an interrupt passes 35 unread events and uses its own reply",
  async (session, fake) => {
    const events = session.events[Symbol.asyncIterator]();
    fake.send({ frames: [runningFrame] });
    await fake.retained(runningFrame.uuid);
    const pending = session.interrupt(interrupt);
    await fake.wrote(1);
    const id = fake.observed()[0]!.request_id!;
    fake.send({
      frames: [
        ...Array.from({ length: 35 }, (_, index) => fake.eventFrame(index)),
        interruptReply("900"),
        interruptReply(id),
      ],
    });
    expect(await pending).toEqual({ status: "applied" });
    expect((await events.next()).value).toMatchObject({ kind: "turn.started" });
    for (let index = 0; index < 35; index++)
      expect((await events.next()).value).toMatchObject({
        kind: "context",
        body: { data: { model: index === 32 ? "full" : `model-${index}` } },
      });
  },
  { FIXTURE_HOLD_INTERRUPTS: "1" },
);

claudeCase(
  "a full event buffer preserves exit order and releases a pending interrupt",
  async (session, fake) => {
    fake.send({ frames: [runningFrame] });
    await fake.retained(runningFrame.uuid);
    const pending = session.interrupt(interrupt);
    await fake.wrote(1);
    fake.send({
      frames: Array.from({ length: 35 }, (_, index) => fake.eventFrame(index)),
      exit: 7,
    });
    expect(await pending).toMatchObject({
      status: "in-doubt",
      reason: "unknown",
      code: "channel-ended",
    });
    const result = await Array.fromAsync(session.events);
    expect(result.map(({ kind }) => kind)).toEqual([
      "turn.started",
      ...Array(35).fill("context"),
      "turn.ended",
      "session.ended",
    ]);
    expect(result.at(-1)).toMatchObject({ body: { reason: "exit-7" } });
  },
  { FIXTURE_HOLD_INTERRUPTS: "1" },
);

it.effect(
  "read-ahead overflow stops controls before the event buffer drains",
  () =>
    Effect.promise(async () => {
      const fake = fixture({ FIXTURE_HOLD_INTERRUPTS: "1" });
      const { session } = requireOpened(await fake.contract.open(fake.spec));
      fake.send({ frames: [runningFrame] });
      await fake.retained(runningFrame.uuid);
      const pending = session.interrupt(interrupt);
      await fake.wrote(1);
      fake.send({
        frames: Array.from({ length: 110 }, (_, index) =>
          fake.eventFrame(index),
        ),
      });
      expect(await pending).toMatchObject({
        status: "in-doubt",
        reason: "unknown",
        code: "output-overflow",
      });
      expect(await session.interrupt(interrupt)).toEqual({ status: "closed" });
      expect(await waitFor(() => fake.contract.releases() === 1, 2500, 5)).toBe(
        true,
      );
      await expect(Array.fromAsync(session.events)).rejects.toMatchObject({
        code: "output-overflow",
      });
    }),
);

it.effect(
  "a late interrupt acknowledgement does not settle the next control",
  () =>
    Effect.gen(function* () {
      const fake = fixture({ FIXTURE_HOLD_INTERRUPTS: "1" });
      const adapter = yield* ProviderAdapter.pipe(
        Effect.provide(providerAdapterLayer(fake.options)),
      );
      const { session } = requireOpened(yield* adapter.own(fake.spec));
      yield* Effect.sync(() => fake.send({ frames: [runningFrame] }));
      yield* Effect.promise(() => fake.retained(runningFrame.uuid));
      const first = yield* Effect.forkChild(session.interrupt(interrupt));
      expect(
        yield* Effect.promise(() =>
          waitFor(() => fake.observed().length === 1, 2500, 5),
        ),
      ).toBe(true);
      yield* TestClock.adjust("31 seconds");
      expect(yield* Fiber.join(first)).toMatchObject({
        status: "in-doubt",
        code: "timeout",
      });
      const second = yield* Effect.forkChild(session.interrupt(interrupt));
      expect(
        yield* Effect.promise(() =>
          waitFor(() => fake.observed().length === 2, 2500, 5),
        ),
      ).toBe(true);
      const [old, next] = fake.observed();
      yield* Effect.sync(() =>
        fake.send({
          frames: [
            interruptReply(old!.request_id!),
            {
              type: "control_response",
              response: {
                subtype: "error",
                request_id: next!.request_id!,
                error: "fixture refused",
              },
            },
          ],
        }),
      );
      expect(yield* Fiber.join(second)).toMatchObject({
        status: "refused",
        code: "rpc-rejected",
      });
      yield* Effect.promise(() =>
        fake.retained(`"request_id":"${old!.request_id!}"`),
      );
      expect(
        fake.raw.find(({ line }) =>
          line.includes(`"request_id":"${old!.request_id!}"`),
        )?.disposition,
      ).toBe("replay");
    }),
);

claudeCase(
  "repeated delivery and prompt IDs do not resend or reopen",
  async (session, fake) => {
    const next = readEvent(session);
    expect(await session.steer(steer)).toEqual(noReceipt);
    fake.send({ frames: [runningFrame, approval, approval] });
    expect(await next()).toMatchObject({ kind: "turn.started" });
    expect(await next()).toMatchObject({
      kind: "prompt.opened",
    });
    expect(
      await session.steer({ ...steer, expected: interrupt.expected }),
    ).toMatchObject({
      status: "in-doubt",
      reason: "unknown",
      code: "delivery-seen",
    });
    expect(await session.answer(answer)).toEqual(noAnswerAck);
    expect(await next()).toMatchObject({
      kind: "prompt.settled",
      body: { answer: { option_id: "allow" } },
    });
    fake.send({ frames: [approval, fake.eventFrame(10)] });
    expect(await next()).toMatchObject({ kind: "context" });
    expect(await session.answer(answer)).toMatchObject({ status: "stale" });
    expect(fake.observed().map(({ type }) => type)).toEqual([
      "user",
      "control_response",
    ]);
    expect(fake.observed()[1]?.response?.response).toEqual({
      behavior: "allow",
      updatedInput: { command: "pwd" },
      toolUseID: "tool-1",
    });
  },
);

claudeCase(
  "a late result from an earlier UUID leaves the current turn active",
  async (session, fake) => {
    const next = readEvent(session);
    expect(await session.steer(steer)).toEqual(noReceipt);
    await fake.wrote(1);
    const uuid = fake.observed()[0]!.uuid!;
    const result = {
      type: "result",
      subtype: "success",
      is_error: false,
      user_message_uuids: [uuid],
      uuid: "result",
    };
    fake.send({ frames: [runningFrame, result] });
    expect(await next()).toMatchObject({
      kind: "turn.started",
    });
    expect(await next()).toMatchObject({
      kind: "message.user",
    });
    expect(await next()).toMatchObject({ kind: "turn.ended" });
    fake.send({
      frames: [
        { ...runningFrame, uuid: "other-turn" },
        { ...result, uuid: "late-result" },
        fake.eventFrame(10),
      ],
    });
    expect(await next()).toMatchObject({
      kind: "turn.started",
    });
    expect(await next()).toMatchObject({ kind: "context" });
    expect(
      await session.interrupt({
        expected: { ...fence, turn: "claude-sdk:1:2" },
      }),
    ).toEqual({ status: "applied" });
  },
);

claudeCase(
  "ask-user answers map question IDs to original question text on the wire",
  async (session, fake) => {
    const next = readEvent(session);
    const questions = [
      {
        question: "Which color?",
        options: [{ label: "Blue" }, { label: "Orange" }],
      },
      {
        question: "Which shapes?",
        multiSelect: true,
        options: [{ label: "Circle" }, { label: "Square" }],
      },
    ];
    fake.send({
      frames: [
        runningFrame,
        {
          ...approval,
          request: {
            ...approval.request,
            tool_name: "AskUserQuestion",
            input: { questions },
          },
        },
      ],
    });
    expect(await next()).toMatchObject({
      kind: "turn.started",
    });
    expect(await next()).toMatchObject({
      kind: "prompt.opened",
      body: { kind: "question" },
    });
    const context = await next();
    expect(context).toMatchObject({
      kind: "context",
      body: { data: { prompt_id: answer.expected.prompt_id } },
    });
    expect(
      await session.answer({
        ...answer,
        answer: { answers: { "0": { answers: ["Blue"] } } },
      }),
    ).toMatchObject({
      status: "refused",
      code: "invalid-answer",
    });
    expect(fake.observed()).toEqual([]);
    expect(
      await session.answer({
        ...answer,
        answer: {
          answers: {
            "0": { answers: ["Orange"] },
            "1": { answers: ["Circle", "Square"] },
          },
        },
      }),
    ).toEqual(noAnswerAck);
    await fake.wrote(1);
    expect(fake.observed()[0]?.response?.response).toEqual({
      behavior: "allow",
      toolUseID: "tool-1",
      updatedInput: {
        questions,
        answers: {
          "Which color?": "Orange",
          "Which shapes?": "Circle, Square",
        },
      },
    });
  },
);

claudeCase(
  "provider cancellation retires the prompt without an actorless settlement",
  async (session, fake) => {
    const next = readEvent(session);
    fake.send({
      frames: [
        runningFrame,
        approval,
        {
          type: "control_cancel_request",
          request_id: approval.request_id,
        },
        approval,
        fake.eventFrame(0),
      ],
    });
    expect(await next()).toMatchObject({
      kind: "turn.started",
    });
    expect(await next()).toMatchObject({
      kind: "prompt.opened",
    });
    expect(await next()).toMatchObject({ kind: "context" });
    expect(await session.answer(answer)).toMatchObject({
      status: "stale",
      observed: { kind: "prompt", prompt_id: null },
    });
    expect(fake.observed()).toEqual([]);
  },
);

claudeCase(
  "idle before lifecycle completion does not start a phantom turn",
  async (session, fake) => {
    const next = readEvent(session);
    expect(await session.steer(steer)).toEqual(noReceipt);
    await fake.wrote(1);
    const command_uuid = fake.observed()[0]!.uuid!;
    fake.send({
      frames: [
        runningFrame,
        {
          type: "command_lifecycle",
          state: "started",
          command_uuid,
          uuid: "start-input",
        },
        { ...runningFrame, state: "idle", uuid: "now-idle" },
        {
          type: "command_lifecycle",
          state: "completed",
          command_uuid,
          uuid: "late-completion",
        },
        fake.eventFrame(0),
      ],
    });
    expect(await next()).toMatchObject({
      kind: "turn.started",
    });
    expect(await next()).toMatchObject({
      kind: "message.user",
    });
    expect(await next()).toMatchObject({
      kind: "turn.ended",
      body: { reason: "no-result" },
    });
    expect(await next()).toMatchObject({
      kind: "context",
      turn: null,
    });
    expect(await session.steer({ ...steer, delivery_id: "second" })).toEqual(
      noReceipt,
    );
  },
);

claudeCase(
  "local images use SDK base64 blocks before the text",
  async (session, fake) => {
    const path = join(fake.spec.cwd, "fixture.png");
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1EAAAAASUVORK5CYII=",
      "base64",
    );
    writeFileSync(path, bytes);
    expect(
      await session.steer({
        ...steer,
        input: [...steer.input, { type: "local-image", path }],
      }),
    ).toEqual(noReceipt);
    await fake.wrote(1);
    expect(fake.observed()[0]?.message).toEqual({
      role: "user",
      content: [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: bytes.toString("base64"),
          },
        },
        { type: "text", text: "fixture input" },
      ],
    });
  },
);

it.effect(
  "a semantic denial uses the original permission request and tool IDs",
  () =>
    Effect.promise(async () => {
      const fake = fixture();
      const { session } = requireOpened(await fake.contract.open(fake.spec));
      await fake.contract.atPendingPrompt(async () => {
        expect(
          await session.answer({ ...answer, answer: { behavior: "deny" } }),
        ).toEqual(noAnswerAck);
      });
      expect(fake.observed()[0]?.response).toMatchObject({
        request_id: approval.request_id,
        response: { behavior: "deny", toolUseID: approval.request.tool_use_id },
      });
      expect(await session.answer(answer)).toMatchObject({ status: "stale" });
    }),
);
