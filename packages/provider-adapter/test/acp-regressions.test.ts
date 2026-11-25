import { requireOpened } from "./provider-fixture";
import { acpCase } from "./acp-fixture";
import { expect } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { it } from "@codecast/effect-kit/effect/testing";
import { waitFor } from "@codecast/test-helpers/waitFor";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { createProviderAdapter } from "../src";
import { ProviderAdapter, providerAdapterLayer } from "../src/effect";
import {
  answer,
  bestEffort,
  bufferCapacity,
  controlOutcome,
  fixture,
  installAcpFixtureHooks,
  interrupt,
  processStopped,
  scope,
  steer,
} from "./acp-fixture";

installAcpFixtureHooks();

function openEffect(fake: ReturnType<typeof fixture>) {
  return Effect.flatMap(ProviderAdapter, (adapter) =>
    adapter.own(fake.spec),
  ).pipe(Effect.provide(providerAdapterLayer(fake.options)));
}

function permission(sessionId: string, id = "permission") {
  return {
    id,
    method: "session/request_permission",
    params: {
      sessionId,
      toolCall: { title: null },
      options: [{ optionId: "allow", kind: "allow_once" }],
    },
  };
}

function context(sessionId: string) {
  return {
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: [],
      },
    },
  };
}

acpCase(
  "an EPIPE rejects the native write and leaves an in-doubt delivery",
  async (session, fake) => {
    expect(
      await waitFor(
        () => existsSync(join(fake.directory, "stdin-closed")),
        2500,
        5,
      ),
    ).toBe(true);
    expect(
      await session.steer({
        ...steer,
        input: [{ type: "text", text: "x".repeat(600_000) }],
      }),
    ).toMatchObject({
      status: "in-doubt",
      reason: "unknown",
      code: "write-failed",
    });
  },
  { ACP_CLOSE_STDIN: "1" },
);

it.effect("a rejected write can still have a late prompt reply", () =>
  Effect.promise(async () => {
    const fake = fixture();
    let rejectFirst = true;
    fake.interceptWrite((data, write) => {
      const written = write(data);
      if (
        !rejectFirst ||
        typeof data !== "string" ||
        !data.includes("session/prompt")
      )
        return written;
      rejectFirst = false;
      return Promise.resolve(written).then(() => {
        throw new Error("late sink failure");
      });
    });
    const { session } = requireOpened(await fake.client.start(fake.spec));
    try {
      expect(await session.steer(steer)).toMatchObject({
        status: "in-doubt",
        reason: "unknown",
        code: "write-failed",
      });
      expect(await waitFor(() => fake.observed().length === 1, 2500, 5)).toBe(
        true,
      );
      await fake.wrote({ complete: true });
      const events = session.events[Symbol.asyncIterator]();
      expect(await events.next()).toMatchObject({
        value: { kind: "turn.started" },
      });
      expect(await events.next()).toMatchObject({
        value: { kind: "turn.ended", body: { reason: "end_turn" } },
      });
      expect(await session.steer(steer)).toEqual(bestEffort);
    } finally {
      await session.close();
    }
  }),
);

it.effect("malformed prompt replies emit a diagnostic and end the turn", () =>
  Effect.promise(async () => {
    const fake = fixture();
    const { session } = requireOpened(await fake.contract.open(scope));
    try {
      await session.steer(steer);
      await fake.wrote({ complete: "malformed" });
      const events = session.events[Symbol.asyncIterator]();
      expect(await events.next()).toMatchObject({
        value: { kind: "turn.started" },
      });
      expect(await events.next()).toMatchObject({
        value: { kind: "error", body: { class: "acp-prompt" } },
      });
      const next = events.next();
      let arrived = false;
      void next.then(() => {
        arrived = true;
      });
      expect(await waitFor(() => arrived, 500, 5)).toBe(true);
      expect(await next).toMatchObject({
        value: { kind: "turn.ended", body: { reason: "unknown" } },
      });
      expect(await session.steer(steer)).toEqual(bestEffort);
    } finally {
      await session.close();
    }
  }),
);

it.effect(
  "an answer returns before the saturated stream drains and keeps its settlement in order",
  () =>
    Effect.promise(async () => {
      const fake = fixture();
      const { session } = requireOpened(await fake.contract.open(scope));
      try {
        await fake.contract.atPendingPrompt(async () => {});
        for (let index = 0; index < bufferCapacity - 1; index++)
          await fake.contract.sendEvent(index);
        const overflow = fake.contract.sendEvent(bufferCapacity);
        if (fake.contract.backpressure.kind !== "block")
          throw new Error("Expected a pausable source");
        await fake.contract.backpressure.wait();
        let answered = false;
        const result = session.answer(answer).then((result) => {
          answered = true;
          return result;
        });
        expect(await waitFor(() => answered, 500, 5)).toBe(true);
        expect(await result).toEqual(controlOutcome);
        const events = session.events[Symbol.asyncIterator]();
        expect(await events.next()).toMatchObject({
          value: { kind: "prompt.opened", seq: 11 },
        });
        await overflow;
        await fake.contract.processExit();
        const remaining = [];
        for (
          let item = await events.next();
          !item.done;
          item = await events.next()
        )
          remaining.push(item.value);
        expect(remaining.map((event) => event.kind).slice(-3)).toEqual([
          "prompt.settled",
          "context",
          "session.ended",
        ]);
        expect(
          remaining.flatMap((event) =>
            event.kind === "message.delta" ? [] : [event.seq],
          ),
        ).toEqual(
          Array.from({ length: bufferCapacity + 2 }, (_, index) => index + 12),
        );
      } finally {
        await session.close();
      }
    }),
);

it.effect(
  "concurrent answers and an unsupported request reach the wire in order",
  () =>
    Effect.promise(async () => {
      const fake = fixture();
      const hold = Promise.withResolvers<void>();
      const held = Promise.withResolvers<void>();
      fake.interceptWrite((data, write) => {
        if (
          typeof data !== "string" ||
          !data.includes('"id":"permission"') ||
          !data.includes('"selected"')
        )
          return write(data);
        held.resolve();
        return hold.promise.then(() => write(data));
      });
      const { session } = requireOpened(await fake.client.start(fake.spec));
      try {
        await fake.wrote({ frame: permission(session.getCheckpoint()) });
        await fake.wrote({
          frame: permission(session.getCheckpoint(), "second"),
        });
        const first = session.answer(answer);
        await held.promise;
        const second = session.answer({
          ...answer,
          expected: {
            ...answer.expected,
            prompt_id: "1:permission:string:second",
          },
        });
        const unsupported = fake.wrote({
          frame: { id: "unknown-request", method: "fs/unknown" },
        });
        expect(
          await waitFor(
            () => fake.raw.some(({ line }) => line.includes("fs/unknown")),
            500,
            5,
          ),
        ).toBe(true);
        hold.resolve();
        expect(await Promise.all([first, second])).toEqual([
          controlOutcome,
          controlOutcome,
        ]);
        await unsupported;
        expect(
          JSON.parse(
            readFileSync(join(fake.directory, "unsupported-seen"), "utf8"),
          ),
        ).toMatchObject({ code: -32601 });
        expect(await waitFor(() => fake.observed().length > 1, 2500, 5)).toBe(
          true,
        );
        expect(fake.observed().map(({ message }) => message.id)).toEqual([
          "permission",
          "second",
        ]);
      } finally {
        hold.resolve();
        await session.close();
      }
    }),
);

it.effect(
  "a steer queued at idle rechecks the turn before it can publish or write",
  () =>
    Effect.promise(async () => {
      const fake = fixture();
      const hold = Promise.withResolvers<void>();
      const held = Promise.withResolvers<void>();
      fake.interceptWrite((data, write) => {
        if (
          typeof data !== "string" ||
          !data.includes('"id":"unknown-request"')
        )
          return write(data);
        held.resolve();
        return hold.promise.then(() => write(data));
      });
      const { session } = requireOpened(await fake.client.start(fake.spec));
      try {
        await fake.wrote(
          { frame: { id: "unknown-request", method: "fs/unknown" } },
          false,
        );
        await held.promise;
        const first = session.steer(steer);
        const second = session.steer(steer);
        await new Promise<void>((resolve) => setImmediate(resolve));
        hold.resolve();
        expect(await first).toEqual(bestEffort);
        expect(await second).toEqual({
          status: "stale",
          observed: { kind: "turn", turn: "1:1" },
        });
        expect(await waitFor(() => fake.observed().length > 0, 2500, 5)).toBe(
          true,
        );
        await fake.contract.processExit();
        const events = session.events[Symbol.asyncIterator]();
        const kinds = [];
        for (
          let item = await events.next();
          !item.done;
          item = await events.next()
        )
          kinds.push(item.value.kind);
        expect(kinds).toEqual(["turn.started", "turn.ended", "session.ended"]);
        expect(fake.observed().map(({ action }) => action)).toEqual(["steer"]);
      } finally {
        hold.resolve();
        await session.close();
      }
    }),
);

it.effect(
  "the request deadline closes a provider that does not reply to session/new",
  () =>
    Effect.gen(function* () {
      const fake = fixture({ ACP_HOLD_NEW: "1" });
      const open = yield* Effect.forkChild(openEffect(fake));
      expect(
        yield* Effect.promise(() =>
          waitFor(() => existsSync(join(fake.directory, "new-seen")), 2500, 5),
        ),
      ).toBe(true);
      yield* TestClock.adjust(29_999);
      expect(open.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust(1);
      expect(
        yield* Effect.promise(() => waitFor(() => !!open.pollUnsafe(), 500, 5)),
      ).toBe(true);
      expect(yield* Fiber.join(open)).toMatchObject({
        status: "in-doubt",
        code: "timeout",
      });
      expect(
        processStopped(
          Number(readFileSync(join(fake.directory, "pid"), "utf8")),
        ),
      ).toBe(true);
    }),
);

it.effect(
  "the write deadline covers queue wait and native flush and still permits a late reply",
  () =>
    Effect.gen(function* () {
      const fake = fixture();
      const hold = Promise.withResolvers<void>();
      fake.interceptWrite((data, write) => {
        const written = write(data);
        return typeof data === "string" && data.includes("session/prompt")
          ? Promise.resolve(written).then((count) =>
              hold.promise.then(() => count),
            )
          : written;
      });
      const { session } = requireOpened(yield* openEffect(fake));
      const events = Stream.toAsyncIterable(session.events)[
        Symbol.asyncIterator
      ]();
      const sending = yield* Effect.forkChild(session.steer(steer));
      try {
        expect(
          yield* Effect.promise(() =>
            waitFor(() => fake.observed().length === 1, 2500, 5),
          ),
        ).toBe(true);
        const queued = yield* Effect.forkChild(session.interrupt(interrupt), {
          startImmediately: true,
        });
        yield* TestClock.adjust(29_999);
        expect(sending.pollUnsafe()).toBeUndefined();
        expect(queued.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust(1);
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
        expect(fake.observed().map(({ action }) => action)).toEqual(["steer"]);
        hold.resolve();
        yield* Effect.promise(
          () => new Promise<void>((resolve) => setImmediate(resolve)),
        );
        expect(yield* session.interrupt(interrupt)).toEqual(controlOutcome);
        expect(yield* Effect.promise(() => events.next())).toMatchObject({
          value: { kind: "turn.started" },
        });
        expect(yield* Effect.promise(() => events.next())).toMatchObject({
          value: { kind: "turn.ended", body: { reason: "cancelled" } },
        });
      } finally {
        hold.resolve();
        yield* session.close;
      }
    }),
);

it.effect(
  "the prompt deadline uses Effect Clock and preserves the cancel reply",
  () =>
    Effect.gen(function* () {
      const fake = fixture();
      yield* TestClock.setTime(21_000);
      const { session } = requireOpened(yield* openEffect(fake));
      try {
        const events = Stream.toAsyncIterable(session.events)[
          Symbol.asyncIterator
        ]();
        expect(yield* session.steer(steer)).toEqual(bestEffort);
        expect(yield* Effect.promise(() => events.next())).toMatchObject({
          value: { kind: "turn.started", at: 21_000 },
        });
        let arrived = false;
        const reading = events.next().then((item) => {
          arrived = true;
          return item;
        });
        yield* TestClock.adjust(3_599_999);
        expect(arrived).toBe(false);
        yield* TestClock.adjust(1);
        expect(
          yield* Effect.promise(() => waitFor(() => arrived, 500, 5)),
        ).toBe(true);
        expect(yield* Effect.promise(() => reading)).toMatchObject({
          value: {
            kind: "error",
            at: 3_621_000,
            body: { class: "acp-prompt-timeout" },
          },
        });
        expect(yield* session.interrupt(interrupt)).toEqual(controlOutcome);
        expect(yield* Effect.promise(() => events.next())).toMatchObject({
          value: { kind: "turn.ended", body: { reason: "cancelled" } },
        });
        expect(yield* session.steer(steer)).toEqual(bestEffort);
      } finally {
        yield* session.close;
      }
    }),
);

it.effect("initialize refuses an unsupported protocol version", () =>
  Effect.promise(async () => {
    const fake = fixture({ ACP_PROTOCOL_VERSION: "2" });
    expect(await fake.client.start(fake.spec)).toMatchObject({
      status: "refused",
      code: "protocol-version",
    });
    expect(existsSync(join(fake.directory, "new-seen"))).toBe(false);
  }),
);

it.effect("initialize checks Grok's reported agent version", () =>
  Effect.promise(async () => {
    const fake = fixture({ ACP_AGENT_VERSION: "1.0.14" });
    expect(await fake.client.start(fake.spec)).toMatchObject({
      status: "refused",
      code: "agent-version",
    });
    expect(existsSync(join(fake.directory, "new-seen"))).toBe(false);
  }),
);

it.effect("resume requires the provider to offer session/load", () =>
  Effect.promise(async () => {
    const fake = fixture({ ACP_LOAD_DISABLED: "1" });
    expect(
      await fake.client.resume({ ...fake.spec, checkpoint: "resumed" }),
    ).toEqual({ status: "unsupported", requires: "resume" });
    expect(fake.raw.some(({ disposition }) => disposition === "replay")).toBe(
      false,
    );
  }),
);

it.effect("resume refuses an event burst before the consumer can open", () =>
  Effect.promise(async () => {
    const fake = fixture({ ACP_LOAD_BURST: String(bufferCapacity + 1) });
    expect(
      await fake.client.resume({ ...fake.spec, checkpoint: "resumed" }),
    ).toMatchObject({
      status: "in-doubt",
      reason: "unknown",
      code: "event-overflow",
    });
    expect(
      processStopped(Number(readFileSync(join(fake.directory, "pid"), "utf8"))),
    ).toBe(true);
  }),
);

acpCase(
  "updates for another session stay raw and do not publish canonical events",
  async (session, fake) => {
    await fake.wrote({ frame: context("other-session") });
    await fake.wrote({ frame: context(session.getCheckpoint()) });
    await fake.contract.processExit();
    const events = session.events[Symbol.asyncIterator]();
    expect(await events.next()).toMatchObject({
      value: { kind: "context", seq: 11 },
    });
    expect(await events.next()).toMatchObject({
      value: { kind: "session.ended", seq: 12 },
    });
    expect(
      fake.raw.find(({ line }) => line.includes("other-session"))?.disposition,
    ).toBe("unknown");
  },
);

acpCase(
  "a permission request for another session never opens a prompt",
  async (session, fake) => {
    await fake.wrote({ frame: permission("other-session") });
    expect(await session.answer(answer)).toMatchObject({
      status: "stale",
      observed: { prompt_id: null },
    });
    await fake.contract.processExit();
    expect(await session.events[Symbol.asyncIterator]().next()).toMatchObject({
      value: { kind: "session.ended", seq: 11 },
    });
    expect(
      fake.raw.find(({ line }) => line.includes("other-session"))?.disposition,
    ).toBe("unknown");
  },
);

it.effect(
  "null ACP replies, nullable tool fields and omitted option labels use the live session",
  () =>
    Effect.promise(async () => {
      const fake = fixture();
      const { session } = requireOpened(
        await fake.client.resume({ ...fake.spec, checkpoint: "resumed" }),
      );
      try {
        await fake.wrote({ frame: permission(session.getCheckpoint()) });
        const events = session.events[Symbol.asyncIterator]();
        expect(await events.next()).toMatchObject({
          value: {
            kind: "prompt.opened",
            body: { prompt_id: answer.expected.prompt_id },
          },
        });
        expect(await session.answer(answer)).toEqual(controlOutcome);
        expect(await events.next()).toMatchObject({
          value: { kind: "prompt.settled" },
        });
        for (const status of [null, "completed"]) {
          await fake.wrote({
            frame: {
              method: "session/update",
              params: {
                sessionId: session.getCheckpoint(),
                update: {
                  sessionUpdate: "tool_call_update",
                  toolCallId: "tool",
                  status,
                  content: null,
                },
              },
            },
          });
        }
        expect(
          fake.raw
            .filter(({ line }) => line.includes("tool_call_update"))
            .map(({ disposition }) => disposition),
        ).toEqual(["decoded", "decoded"]);
        expect(await events.next()).toMatchObject({
          value: { kind: "tool.result", body: { output: { inline: [] } } },
        });
      } finally {
        await session.close();
      }
    }),
);

it.effect("oversized and nonregular image inputs never reach the wire", () =>
  Effect.promise(async () => {
    const fake = fixture();
    const oversized = join(fake.directory, "large.png");
    writeFileSync(oversized, "");
    truncateSync(oversized, 16 * 1024 * 1024 + 1);
    const directory = join(fake.directory, "directory.png");
    mkdirSync(directory);
    const { session } = requireOpened(await fake.client.start(fake.spec));
    try {
      for (const path of [oversized, directory]) {
        expect(
          await session.steer({
            ...steer,
            input: [{ type: "local-image", path }],
          }),
        ).toMatchObject({
          status: "refused",
          code: "input",
        });
      }
      expect(fake.observed()).toEqual([]);
    } finally {
      await session.close();
    }
  }),
);

it.effect("stderr and prompt diagnostics redact provider secrets", () =>
  Effect.promise(async () => {
    const fake = fixture();
    const { session } = requireOpened(await fake.contract.open(scope));
    const token = `sk_test_${"a".repeat(28)}`;
    const redacted = "Bad key [redacted:stripe-secret-key]";
    try {
      await fake.wrote({ stderr: `Bad key ${token.slice(0, 10)}` });
      expect(fake.stderr).toEqual([]);
      await fake.wrote({ stderr: token.slice(10) + "\n" });
      expect(await waitFor(() => fake.stderr.length === 1, 500, 5)).toBe(true);
      expect(fake.stderr).toEqual([redacted]);
      for (const line of [
        "-----BEGIN PRIVATE KEY-----",
        "fixture-private-key-body",
        "-----END PRIVATE KEY-----",
        "stderr still works",
      ])
        await fake.wrote({ stderr: line + "\n" });
      expect(
        await waitFor(() => fake.stderr.includes("stderr still works"), 500, 5),
      ).toBe(true);
      expect(fake.stderr).toEqual([
        redacted,
        "[redacted:private-key]",
        "stderr still works",
      ]);
      await session.steer(steer);
      await fake.wrote({ promptError: `Bad key ${token}` });
      const events = session.events[Symbol.asyncIterator]();
      expect(await events.next()).toMatchObject({
        value: { kind: "turn.started" },
      });
      expect(await events.next()).toMatchObject({
        value: { kind: "error", body: { message: redacted } },
      });
      expect(fake.raw.some(({ line }) => line.includes(token))).toBe(true);
    } finally {
      await session.close();
    }
  }),
);

it.effect(
  "aborted starts throw the same caller reason before or after spawn",
  () =>
    Effect.promise(async () => {
      const fake = fixture({ ACP_HOLD_NEW: "1" });
      const reason = new Error("caller cancelled");
      const controller = new AbortController();
      await expect(
        fake.client.start(fake.spec, AbortSignal.abort(reason)),
      ).rejects.toBe(reason);
      expect(existsSync(join(fake.directory, "pid"))).toBe(false);
      const opened = fake.client.start(fake.spec, controller.signal);
      expect(
        await waitFor(
          () => existsSync(join(fake.directory, "new-seen")),
          2500,
          5,
        ),
      ).toBe(true);
      controller.abort(reason);
      await expect(opened).rejects.toBe(reason);
    }),
);

it.effect("lazy initialization failure permits retry and disposal", () =>
  Effect.promise(async () => {
    const fake = fixture();
    const error = new Error("fixture cannot initialize the adapter");
    const create = () => {
      let reads = 0;
      return createProviderAdapter({
        ...fake.options,
        get provider() {
          if (++reads === 2) throw error;
          return fake.options.provider;
        },
      });
    };
    const retried = create();
    try {
      await expect(retried.start(fake.spec)).rejects.toBe(error);
      requireOpened(await retried.start(fake.spec));
    } finally {
      await retried.dispose();
    }
    const disposed = create();
    const opening = disposed.start(fake.spec);
    const closing = disposed.dispose();
    await expect(opening).rejects.toBe(error);
    await expect(closing).resolves.toBeUndefined();
  }),
);

it.effect("missing executables return a typed binary refusal", () =>
  Effect.promise(async () => {
    const fake = fixture();
    const adapter = createProviderAdapter({
      ...fake.options,
      command: [join(fake.directory, "missing-provider")],
    });
    try {
      expect(await adapter.start(fake.spec)).toMatchObject({
        status: "refused",
        code: "binary-missing",
      });
    } finally {
      await adapter.dispose();
    }
  }),
);
