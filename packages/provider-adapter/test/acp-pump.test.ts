import { expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "@codecast/effect-kit/effect/testing";
import type { ProviderEvent } from "@codecast/provider-contract";
import { waitFor } from "@codecast/test-helpers/waitFor";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ProviderAdapter, providerAdapterLayer } from "../src/effect";
import { spawnProvider } from "../src/provider-process";
import {
  answer,
  bestEffort,
  bufferCapacity,
  controlOutcome,
  fixture,
  installAcpFixtureHooks,
  interrupt,
  originalKill,
  processStopped,
  scope,
  steer,
} from "./acp-fixture";

installAcpFixtureHooks();

const fsRequest = {
  id: "unsupported-fs",
  method: "fs/read_text_file",
  params: { path: "/fixture.txt" },
};

function context(sessionId: string, availableCommands: object[] = []) {
  return {
    method: "session/update",
    params: {
      sessionId,
      update: { sessionUpdate: "available_commands_update", availableCommands },
    },
  };
}

function opened<T extends { status: string }>(outcome: T) {
  if (outcome.status !== "opened") throw new Error(JSON.stringify(outcome));
  return outcome as Extract<T, { status: "opened" }>;
}

function read(iterator: AsyncIterator<ProviderEvent>) {
  return Effect.promise(async () => {
    let result:
      | { item: IteratorResult<ProviderEvent> }
      | { error: unknown }
      | undefined;
    void iterator.next().then(
      (item) => {
        result = { item };
      },
      (error: unknown) => {
        result = { error };
      },
    );
    expect(await waitFor(() => result !== undefined, 1500, 5)).toBe(true);
    if (result && "error" in result) throw result.error;
    return result?.item;
  });
}

it.effect(
  "a blocked stdin does not stall inbound updates and expires queued writes promptly",
  () =>
    Effect.gen(function* () {
      const fake = fixture({ ACP_PAUSE_STDIN: "1" });
      const outcome = yield* Effect.flatMap(ProviderAdapter, (adapter) =>
        adapter.own(fake.spec),
      ).pipe(Effect.provide(providerAdapterLayer(fake.options)));
      const { session } = opened(outcome);
      const events = Stream.toAsyncIterable(session.events)[
        Symbol.asyncIterator
      ]();
      try {
        const sending = yield* Effect.forkChild(
          session.steer({
            ...steer,
            input: [{ type: "text", text: "x".repeat(4 * 1024 * 1024) }],
          }),
        );
        expect(yield* read(events)).toMatchObject({
          value: { kind: "turn.started" },
        });
        yield* Effect.promise(() =>
          fake.wrote(
            {
              frames: [fsRequest, context(session.getCheckpoint())],
            },
            false,
          ),
        );
        expect(yield* read(events)).toMatchObject({
          value: { kind: "context" },
        });
        yield* TestClock.adjust("29 seconds");
        expect(sending.pollUnsafe()).toBeUndefined();
        const queued = yield* Effect.forkChild(session.interrupt(interrupt), {
          startImmediately: true,
        });
        expect(queued.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust("1 second");
        expect(
          yield* Effect.promise(() =>
            waitFor(
              () => !!sending.pollUnsafe() && !!queued.pollUnsafe(),
              500,
              5,
            ),
          ),
        ).toBe(true);
        expect(yield* Fiber.join(sending)).toMatchObject({
          status: "in-doubt",
          reason: "unknown",
          code: "write-timeout",
        });
        expect(yield* Fiber.join(queued)).toMatchObject({
          status: "refused",
          code: "write-queue-timeout",
        });
      } finally {
        yield* session.close;
      }
    }),
);

const timedOutSession = Effect.fn("test.acpTimedOutSession")(function* (
  fake: ReturnType<typeof fixture>,
) {
  const result = yield* Effect.flatMap(ProviderAdapter, (adapter) =>
    adapter.own(fake.spec),
  ).pipe(Effect.provide(providerAdapterLayer(fake.options)));
  const { session } = opened(result);
  const events = Stream.toAsyncIterable(session.events)[Symbol.asyncIterator]();
  const sending = yield* Effect.forkChild(
    session.steer({
      ...steer,
      input: [{ type: "text", text: "x".repeat(4 * 1024 * 1024) }],
    }),
  );
  expect(yield* read(events)).toMatchObject({
    value: { kind: "turn.started" },
  });
  yield* TestClock.adjust("30 seconds");
  expect(yield* Fiber.join(sending)).toMatchObject({
    status: "in-doubt",
    reason: "unknown",
    code: "write-timeout",
  });
  return { session, events };
});

it.effect(
  "a stream defect closes controls even when stdin still has an expired write",
  () =>
    Effect.gen(function* () {
      const fake = fixture({ ACP_PAUSE_STDIN: "1" });
      const { session, events } = yield* timedOutSession(fake);
      const fault = new Error("fixture's receive pump failed");
      try {
        yield* Effect.promise(() => fake.contract.streamDefect(fault));
        const next = yield* Effect.result(
          Effect.tryPromise({
            try: () => events.next(),
            catch: (error) => error,
          }),
        );
        expect(next).toMatchObject({ _tag: "Failure", failure: fault });
        expect(yield* session.steer(steer)).toEqual({ status: "closed" });
        expect(yield* session.interrupt(interrupt)).toEqual({
          status: "closed",
        });
        expect(yield* session.answer(answer)).toEqual({ status: "closed" });
      } finally {
        yield* session.close;
      }
    }),
);

it.effect(
  "a failed close fences controls even when stdin still has an expired write",
  () =>
    Effect.gen(function* () {
      const fake = fixture({ ACP_PAUSE_STDIN: "1" });
      const { session } = yield* timedOutSession(fake);
      const failure = fake.contract.failClose();
      expect(yield* session.close).toEqual(failure);
      expect(yield* session.steer(steer)).toEqual({ status: "closed" });
      expect(yield* session.interrupt(interrupt)).toEqual({ status: "closed" });
      expect(yield* session.answer(answer)).toEqual({ status: "closed" });
    }),
);

it.effect(
  "a fenced transport reports channel closure before its expired write window",
  () =>
    Effect.gen(function* () {
      const fake = fixture({ ACP_PAUSE_STDIN: "1" });
      const transport = spawnProvider(
        fake.options,
        fake.spec.cwd,
        yield* Effect.scope,
        { name: "ACP", command: ["grok", "agent", "stdio"] },
      );
      yield* Effect.addFinalizer(() => Effect.promise(transport.release));
      yield* transport.write(() =>
        Result.succeed([{ id: 1, method: "session/new" }]),
      );
      expect(
        yield* Effect.promise(() => transport.frames().next()),
      ).toMatchObject({ done: false });
      const writing = yield* Effect.forkChild(
        Effect.result(
          transport.write(() =>
            Result.succeed([
              {
                id: 2,
                method: "session/prompt",
                params: {
                  prompt: [{ type: "text", text: "x".repeat(4 * 1024 * 1024) }],
                },
              },
            ]),
          ),
        ),
        { startImmediately: true },
      );
      yield* TestClock.adjust("30 seconds");
      expect(yield* Fiber.join(writing)).toMatchObject({
        _tag: "Failure",
        failure: { code: "write-timeout" },
      });
      transport.fence();
      const result = yield* Effect.result(
        transport.write(() => {
          throw new Error("A closed transport evaluated the write plan");
        }),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { code: "channel-closed" },
      });
    }),
);

it.effect(
  "a best-effort reply to closed stdin preserves the update and clean exit",
  () =>
    Effect.gen(function* () {
      const fake = fixture({ ACP_CLOSE_STDIN: "1" });
      const { session } = opened(
        yield* Effect.promise(() => fake.client.start(fake.spec)),
      );
      try {
        const events = session.events[Symbol.asyncIterator]();
        yield* Effect.promise(() =>
          fake.wrote(
            {
              frames: [fsRequest, context(session.getCheckpoint())],
              exitAfter: true,
            },
            false,
          ),
        );
        expect(yield* read(events)).toMatchObject({
          value: { kind: "context" },
        });
        expect(yield* read(events)).toMatchObject({
          value: { kind: "session.ended", body: { reason: "exited" } },
        });
        expect(yield* read(events)).toMatchObject({ done: true });
      } finally {
        yield* Effect.promise(() => session.close());
      }
    }),
);

it.effect(
  "best-effort replies have a bounded backlog while the writer is busy",
  () =>
    Effect.gen(function* () {
      const fake = fixture();
      const hold = Promise.withResolvers<void>();
      const held = Promise.withResolvers<void>();
      const seen: string[] = [];
      fake.interceptWrite((data, write) => {
        if (typeof data !== "string" || !data.includes('"id":"fs-burst-'))
          return write(data);
        const { id } = JSON.parse(data);
        seen.push(id);
        if (id !== "fs-burst-held") return write(data);
        held.resolve();
        return hold.promise.then(() => write(data));
      });
      const { session } = opened(
        yield* Effect.promise(() => fake.client.start(fake.spec)),
      );
      try {
        yield* Effect.promise(() =>
          fake.wrote({ frame: { ...fsRequest, id: "fs-burst-held" } }, false),
        );
        yield* Effect.promise(() => held.promise);
        yield* Effect.promise(() =>
          fake.wrote(
            {
              frames: [
                ...Array.from({ length: 40 }, (_, index) => ({
                  ...fsRequest,
                  id: `fs-burst-${index}`,
                })),
                context(session.getCheckpoint()),
              ],
            },
            false,
          ),
        );
        expect(
          yield* read(session.events[Symbol.asyncIterator]()),
        ).toMatchObject({ value: { kind: "context" } });
        expect(seen).toEqual(["fs-burst-held"]);
        hold.resolve();
        expect(
          yield* Effect.promise(() =>
            waitFor(() => seen.length >= 33, 1500, 5),
          ),
        ).toBe(true);
        yield* Effect.promise(() => fake.wrote({}));
        expect(seen).toEqual([
          "fs-burst-held",
          ...Array.from({ length: 32 }, (_, index) => `fs-burst-${index}`),
        ]);
      } finally {
        hold.resolve();
        yield* Effect.promise(() => session.close());
      }
    }),
);

it.effect(
  "prompt settlement precedes tool and turn results even while the answer write is pending",
  () =>
    Effect.gen(function* () {
      const fake = fixture();
      const hold = Promise.withResolvers<void>();
      let flushed = false;
      fake.interceptWrite((data, write) => {
        const result = write(data);
        if (typeof data !== "string" || !data.includes('"selected"'))
          return result;
        return Promise.resolve(result).then((count) =>
          hold.promise.then(() => count),
        );
      });
      const { session } = opened(
        yield* Effect.promise(() => fake.contract.open(scope)),
      );
      try {
        expect(yield* Effect.promise(() => session.steer(steer))).toEqual(
          bestEffort,
        );
        yield* Effect.promise(() =>
          fake.contract.atPendingPrompt(async () => {}),
        );
        const answering = session.answer(answer).then((result) => {
          flushed = true;
          return result;
        });
        expect(
          yield* Effect.promise(() =>
            waitFor(
              () => fake.observed().some(({ action }) => action === "answer"),
              1500,
              5,
            ),
          ),
        ).toBe(true);
        yield* Effect.promise(() =>
          fake.wrote(
            {
              frames: [
                {
                  method: "session/update",
                  params: {
                    sessionId: "fake-acp-session",
                    update: {
                      sessionUpdate: "tool_call_update",
                      toolCallId: "tool",
                      status: "completed",
                    },
                  },
                },
              ],
              complete: true,
            },
            false,
          ),
        );
        const events = session.events[Symbol.asyncIterator]();
        for (const kind of [
          "turn.started",
          "prompt.opened",
          "prompt.settled",
          "tool.result",
          "turn.ended",
        ])
          expect(yield* read(events)).toMatchObject({ value: { kind } });
        expect(flushed).toBe(false);
        hold.resolve();
        expect(yield* Effect.promise(() => answering)).toEqual(controlOutcome);
      } finally {
        hold.resolve();
        yield* Effect.promise(() => session.close());
      }
    }),
);

it.effect(
  "permissions accept absent tool details and optional or vendor option kinds",
  () =>
    Effect.gen(function* () {
      const fake = fixture();
      const { session } = opened(
        yield* Effect.promise(() => fake.client.start(fake.spec)),
      );
      const variations = [
        { id: "omitted-tool", extra: {}, choice: {} },
        {
          id: "null-tool",
          extra: { toolCall: null },
          choice: { kind: "vendor_allow" },
        },
        {
          id: "blank-tool",
          extra: { toolCall: { toolCallId: "", title: "" } },
          choice: { kind: "allow_once" },
        },
        {
          id: "null-fields",
          extra: { toolCall: { toolCallId: null } },
          choice: { name: null, kind: null },
        },
      ];
      try {
        const events = session.events[Symbol.asyncIterator]();
        for (const { id, extra, choice } of variations) {
          yield* Effect.promise(() =>
            fake.wrote({
              frame: {
                id,
                method: "session/request_permission",
                params: {
                  sessionId: session.getCheckpoint(),
                  ...extra,
                  options: [{ optionId: "allow", ...choice }],
                },
              },
            }),
          );
          const prompt_id = `1:permission:string:${id}`;
          expect(yield* read(events)).toMatchObject({
            value: { kind: "prompt.opened", body: { prompt_id } },
          });
          expect(
            yield* Effect.promise(() =>
              session.answer({
                ...answer,
                expected: { ...answer.expected, prompt_id },
              }),
            ),
          ).toEqual(controlOutcome);
          expect(yield* read(events)).toMatchObject({
            value: { kind: "prompt.settled" },
          });
        }
      } finally {
        yield* Effect.promise(() => session.close());
      }
    }),
);

it.effect(
  "a pre-turn update delayed by backpressure retains its original turn",
  () =>
    Effect.gen(function* () {
      const fake = fixture();
      const { session } = opened(
        yield* Effect.promise(() => fake.contract.open(scope)),
      );
      try {
        for (let index = 0; index < bufferCapacity; index++)
          yield* Effect.promise(() => fake.contract.sendEvent(index));
        const frame = context("fake-acp-session", [{ name: "pre-turn" }]);
        yield* Effect.promise(() =>
          fake.wrote(
            {
              frame: {
                ...frame,
                params: {
                  ...frame.params,
                  _meta: { fixtureBuffer: bufferCapacity },
                },
              },
            },
            false,
          ),
        );
        const backpressure = fake.contract.backpressure;
        if (backpressure.kind !== "block")
          throw new Error("Expected a pausable source");
        yield* Effect.promise(backpressure.wait);
        expect(yield* Effect.promise(() => session.steer(steer))).toEqual(
          bestEffort,
        );
        const events = session.events[Symbol.asyncIterator]();
        for (let index = 0; index <= bufferCapacity; index++)
          yield* read(events);
        expect(yield* read(events)).toMatchObject({
          value: {
            turn: null,
            kind: "context",
            body: { data: { availableCommands: [{ name: "pre-turn" }] } },
          },
        });
      } finally {
        yield* Effect.promise(() => session.close());
      }
    }),
);

it.effect("session/new RPC refusals redact the provider diagnostic", () =>
  Effect.promise(async () => {
    const token = `sk_test_${"a".repeat(28)}`;
    const fake = fixture({ ACP_NEW_ERROR: `Bad key ${token}` });
    expect(await fake.client.start(fake.spec)).toEqual({
      status: "refused",
      code: "rpc-rejected",
      message: "Bad key [redacted:stripe-secret-key]",
    });
    expect(fake.raw.some(({ line }) => line.includes(token))).toBe(true);
  }),
);

it.effect("leader exit kills descendants once before session close", () =>
  Effect.gen(function* () {
    const fake = fixture({ ACP_CHILD: "1" });
    const { session } = opened(
      yield* Effect.promise(() => fake.contract.open(scope)),
    );
    const descendant = Number(
      readFileSync(join(fake.directory, "descendant"), "utf8"),
    );
    try {
      expect(processStopped(descendant)).toBe(false);
      yield* Effect.promise(() => fake.contract.processExit());
      expect(
        yield* Effect.promise(() =>
          waitFor(() => processStopped(descendant), 1500, 5),
        ),
      ).toBe(true);
      expect(fake.contract.releases()).toBe(1);
      expect(yield* Effect.promise(() => session.close())).toEqual({
        status: "closed",
      });
      expect(fake.contract.releases()).toBe(1);
    } finally {
      if (!processStopped(descendant)) originalKill(descendant, "SIGKILL");
      yield* Effect.promise(() => session.close());
    }
  }),
);
