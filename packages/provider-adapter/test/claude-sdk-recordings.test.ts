import { expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCanonicalEvent } from "@codecast/edge-contract";
import { it } from "@codecast/effect-kit/effect/testing";
import type {
  ProviderEventIterator,
  SteerRequest,
} from "@codecast/provider-contract";
import { waitFor } from "@codecast/test-helpers/waitFor";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { createProviderAdapter, type RawProviderFrame } from "../src";
import { ProviderAdapter, providerAdapterLayer } from "../src/effect";
import {
  fence,
  noAnswerAck,
  noReceipt,
  person,
  provider,
  requireOpened,
  scope,
  steer,
} from "./claude-sdk-fixture";

const cli = join(import.meta.dir, "../../../apps/cli/src/claudeSdk");

function recording(name: string) {
  const cwd = mkdtempSync(join(tmpdir(), "adapter-claude-recording-"));
  const path = join(cwd, "wire-log");
  const raw: RawProviderFrame[] = [];
  const options = {
    provider,
    env: { FAKE_CLAUDE_RECORDINGS: name, FAKE_CLAUDE_LOG: path },
    command: [process.execPath, join(cli, "testing/fakeClaude.ts")] as const,
    retainRaw: (frame: RawProviderFrame) => {
      raw.push(frame);
    },
  };
  return {
    options,
    spec: { ...scope, ...fence, cwd },
    log: () => (existsSync(path) ? readFileSync(path, "utf8") : ""),
    raw,
    remove: () => rmSync(cwd, { force: true, recursive: true }),
  };
}

async function through<K extends string>(
  events: ProviderEventIterator,
  end: K,
) {
  const found = [];
  for (;;) {
    const result = await events.next();
    if (result.done) throw new Error(`Missing ${end}`);
    const event = result.value;
    expect(parseCanonicalEvent(event).ok).toBe(true);
    found.push(event);
    if (event.kind === end) return found;
  }
}

function input(
  delivery_id: string,
  text: string,
  turn: string | null = null,
): SteerRequest {
  return {
    ...steer,
    delivery_id,
    input: [{ type: "text", text }],
    expected: { ...fence, turn },
  };
}

for (const name of ["text", "no-result", "limit", "resume-first"] as const) {
  it.effect(
    `the ${name} recording emits text or a terminal error and closes the turn`,
    () =>
      Effect.promise(async () => {
        const fake = recording(name);
        const client = createProviderAdapter(fake.options);
        try {
          const { session } = requireOpened(await client.start(fake.spec));
          expect(client.provider.capabilities).toEqual([
            "own",
            "steer-mid-turn",
            "interrupt",
            "prompts",
            "resume",
          ]);
          const first = input("seen-text", "fixture text");
          expect(await session.steer(first)).toEqual(noReceipt);
          const events = await through(
            session.events[Symbol.asyncIterator](),
            "turn.ended",
          );
          expect(events[0]).toMatchObject({
            kind: "turn.started",
            seq: scope.afterSeq + 1,
          });
          expect(
            events.find(({ kind }) => kind === "message.user"),
          ).toMatchObject({
            body: {
              delivery_id: "seen-text",
              text: "fixture text",
              authors: [person],
            },
          });
          if (name === "limit") {
            expect(events.find(({ kind }) => kind === "error")).toMatchObject({
              body: { class: "rate_limit", retryable: true },
            });
            expect(events.at(-1)).toMatchObject({ body: { reason: "failed" } });
          } else {
            expect(
              events.some(({ kind }) => kind === "message.assistant"),
            ).toBe(true);
            expect(events.at(-1)).toMatchObject({
              body: {
                reason: name === "no-result" ? "no-result" : "completed",
              },
            });
          }
          expect(events.some(({ kind }) => kind === "receipt")).toBe(false);
          expect(session.recoveredReceipts).toEqual([]);
        } finally {
          await client.dispose();
          fake.remove();
        }
      }),
  );
}

it.effect("resume passes the saved checkpoint to the recording process", () =>
  Effect.promise(async () => {
    const fake = recording("resume");
    const client = createProviderAdapter(fake.options);
    const checkpoint = "00000000-0000-4000-8000-000000000001";
    try {
      const { session } = requireOpened(
        await client.resume({ ...fake.spec, checkpoint }),
      );
      expect(fake.log()).toContain(`--resume=${checkpoint}`);
      expect(fake.log()).not.toContain("--session-id=");
      expect(session.getCheckpoint()).toBe(checkpoint);
      expect(await session.steer(steer)).toEqual(noReceipt);
      const turn = await through(
        session.events[Symbol.asyncIterator](),
        "turn.ended",
      );
      expect(turn.some(({ kind }) => kind === "message.assistant")).toBe(true);
    } finally {
      await client.dispose();
      fake.remove();
    }
  }),
);

for (const name of ["tool-allow", "tool-deny", "ask"] as const) {
  it.effect(
    `the ${name} recording projects a prompt, settlement, and tool result`,
    () =>
      Effect.promise(async () => {
        const fake = recording(name);
        const client = createProviderAdapter(fake.options);
        try {
          const { session } = requireOpened(await client.start(fake.spec));
          expect(await session.steer(steer)).toEqual(noReceipt);
          const events = session.events[Symbol.asyncIterator]();
          const start = await through(events, "prompt.opened");
          const prompt = start.find((event) => event.kind === "prompt.opened")!;
          const tool = start.find((event) => event.kind === "tool.call")!;
          expect(tool.kind).toBe("tool.call");
          expect(prompt.body.kind).toBe(
            name === "ask" ? "question" : "permission",
          );
          expect(prompt.body.tool_call_id).toBe(tool.body.call_id);
          const option =
            name === "tool-deny" ? "deny" : name === "ask" ? "0" : "allow";
          expect(
            prompt.body.options?.find(({ id }) => id === option)?.label,
          ).toBeTruthy();
          const selection = { option_id: option };
          expect(
            await session.answer({
              expected: { ...fence, prompt_id: prompt.body.prompt_id },
              by: person,
              answer: selection,
            }),
          ).toEqual(noAnswerAck);
          const end = await through(events, "turn.ended");
          expect(end).toContainEqual(
            expect.objectContaining({
              kind: "prompt.settled",
              body: {
                prompt_id: prompt.body.prompt_id,
                answer: selection,
                by: person,
              },
            }),
          );
          expect(end.find(({ kind }) => kind === "tool.result")).toMatchObject({
            body: {
              call_id: tool.body.call_id,
              is_error: name === "tool-deny",
            },
          });
        } finally {
          await client.dispose();
          fake.remove();
        }
      }),
  );
}

it.effect(
  "recorded mid-turn steer uses next priority and one turn consumes both inputs",
  () =>
    Effect.promise(async () => {
      const fake = recording("steer");
      const client = createProviderAdapter(fake.options);
      try {
        const { session } = requireOpened(await client.start(fake.spec));
        const events = session.events[Symbol.asyncIterator]();
        expect(
          await session.steer(input("first", "first fixture input")),
        ).toEqual(noReceipt);
        const start = await through(events, "turn.started");
        const turn = start[0]!.turn;
        expect(
          await session.steer(input("second", "second fixture input", turn)),
        ).toEqual(noReceipt);
        const end = await through(events, "turn.ended");
        expect(fake.log()).toContain("user priority=next");
        expect(
          end
            .filter((event) => event.kind === "message.user")
            .map((event) => event.body.delivery_id),
        ).toEqual(["first", "second"]);
        expect(end.every((event) => event.turn === turn)).toBe(true);
        expect(end.some(({ kind }) => kind === "tool.result")).toBe(true);
      } finally {
        await client.dispose();
        fake.remove();
      }
    }),
);

it.effect(
  "recorded interrupt leaves the next idle steer able to start a turn",
  () =>
    Effect.promise(async () => {
      const fake = recording("interrupt");
      const client = createProviderAdapter(fake.options);
      try {
        const { session } = requireOpened(await client.start(fake.spec));
        const events = session.events[Symbol.asyncIterator]();
        expect(
          await session.steer(input("first", "first fixture input")),
        ).toEqual(noReceipt);
        const start = await through(events, "turn.started");
        expect(
          await session.interrupt({
            expected: { ...fence, turn: start[0]!.turn! },
          }),
        ).toEqual({ status: "applied" });
        expect((await through(events, "turn.ended")).at(-1)).toMatchObject({
          body: { reason: "interrupted" },
        });
        expect(
          await session.steer(input("second", "second fixture input")),
        ).toEqual(noReceipt);
        const next = await through(events, "turn.ended");
        expect(next[0]).toMatchObject({ kind: "turn.started" });
        expect(next[0]?.turn).not.toBe(start[0]?.turn);
        expect(next.at(-1)).toMatchObject({ body: { reason: "completed" } });
      } finally {
        await client.dispose();
        fake.remove();
      }
    }),
);

it.effect(
  "recorded /clear updates the checkpoint and keeps the process open",
  () =>
    Effect.promise(async () => {
      const fake = recording("clear");
      const client = createProviderAdapter(fake.options);
      try {
        const { session } = requireOpened(await client.start(fake.spec));
        const previous = session.getCheckpoint();
        const events = session.events[Symbol.asyncIterator]();
        expect(await session.steer(steer)).toEqual(noReceipt);
        await through(events, "turn.ended");
        expect(await session.steer(input("clear", "/clear"))).toEqual(
          noReceipt,
        );
        const reset = await through(events, "turn.ended");
        const checkpoint = session.getCheckpoint();
        expect(checkpoint).not.toBe(previous);
        expect(
          reset.find(
            (event) =>
              event.kind === "context" &&
              "checkpoint" in (event.body.data as object),
          ),
        ).toMatchObject({
          body: { data: { checkpoint } },
        });
        const recordedInit = fake.raw
          .map(({ line }) => JSON.parse(line))
          .find(
            (frame) =>
              frame.type === "system" &&
              frame.subtype === "init" &&
              frame.session_id !== previous,
          );
        expect(checkpoint).toBe(recordedInit.session_id);
        expect(
          await session.steer(input("after-clear", "third fixture input")),
        ).toEqual(noReceipt);
        const next = await through(events, "turn.ended");
        expect(next.some(({ kind }) => kind === "message.assistant")).toBe(
          true,
        );
        expect(fake.log().match(/^spawn /gm)).toHaveLength(1);
      } finally {
        await client.dispose();
        fake.remove();
      }
    }),
);

it.effect(
  "a recorded initialize hang times out without opening a session",
  () =>
    Effect.gen(function* () {
      const fake = recording("hang");
      try {
        const adapter = yield* ProviderAdapter.pipe(
          Effect.provide(providerAdapterLayer(fake.options)),
        );
        const opening = yield* Effect.forkChild(adapter.own(fake.spec));
        expect(
          yield* Effect.promise(() =>
            waitFor(() => fake.log().includes("control initialize"), 2500, 5),
          ),
        ).toBe(true);
        yield* TestClock.adjust("31 seconds");
        expect(yield* Fiber.join(opening)).toMatchObject({
          status: "in-doubt",
          reason: "unknown",
          code: "timeout",
        });
      } finally {
        fake.remove();
      }
    }),
);
