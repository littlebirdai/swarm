import { expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseCanonicalEvent } from "@codecast/edge-contract";
import type { SteerRequest } from "@codecast/provider-contract";
import { providerConformance } from "@codecast/provider-contract/test";
import { waitFor } from "@codecast/test-helpers/waitFor";
import { it } from "@codecast/effect-kit/effect/testing";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import { createProviderAdapter } from "../src";
import { ProviderAdapter, providerAdapterLayer } from "../src/effect";
import {
  answer,
  author,
  bestEffort,
  bufferCapacity,
  controlOutcome,
  fixture,
  installAcpFixtureHooks,
  interrupt,
  originalKill,
  processStopped,
  recorded,
  scope,
  steer,
} from "./acp-fixture";

installAcpFixtureHooks();

providerConformance("Grok ACP stdio", () => fixture().contract);

it.effect(
  "scoped ownership kills the process group, including a descendant",
  () =>
    Effect.gen(function* () {
      const fake = fixture({ ACP_CHILD: "1" });
      const run = yield* Scope.make();
      const open = Effect.flatMap(ProviderAdapter, (adapter) =>
        adapter.own(fake.spec),
      ).pipe(
        Scope.provide(run),
        Effect.provide(providerAdapterLayer(fake.options)),
      );
      const result = yield* open;
      expect(result.status).toBe("opened");
      const descendant = Number(
        readFileSync(join(fake.directory, "descendant"), "utf8"),
      );
      try {
        yield* Scope.close(run, Exit.void);
        expect(
          yield* Effect.promise(() =>
            waitFor(() => processStopped(descendant), 2500, 5),
          ),
        ).toBe(true);
      } finally {
        if (!processStopped(descendant)) originalKill(descendant, "SIGKILL");
      }
    }),
);

it.effect(
  "retains malformed and replay frames, streams text, and ends the named turn",
  () =>
    Effect.promise(async () => {
      const fake = fixture();
      const opened = await fake.client.resume({
        ...fake.spec,
        checkpoint: "resumed",
      });
      if (opened.status !== "opened") throw new Error(JSON.stringify(opened));
      const session = opened.session;
      try {
        const iterator = session.events[Symbol.asyncIterator]();
        expect(await session.steer(steer)).toEqual(bestEffort);
        expect(await iterator.next()).toMatchObject({
          value: { kind: "turn.started", turn: "1:1", seq: 11 },
        });
        await fake.wrote({ raw: "{broken-frame" });
        for (const frame of recorded.slice(1, 13)) {
          await fake.wrote({
            frame: {
              ...frame,
              params: { ...frame.params, sessionId: "resumed" },
            },
          });
        }
        await fake.wrote({ complete: true });
        const events = [];
        for (
          let item = await iterator.next();
          !item.done;
          item = await iterator.next()
        ) {
          events.push(item.value);
          if (item.value.kind === "turn.ended") break;
        }
        expect(events.map((event) => event.kind)).toEqual([
          "message.user",
          "message.delta",
          "message.delta",
          "message.assistant",
          "tool.call",
          "tool.result",
          "tool.call",
          "tool.result",
          "message.delta",
          "message.assistant",
          "turn.ended",
        ]);
        expect(events[0]?.body).toEqual({
          text: "list the files here",
          authors: [author],
          delivery_id: "delivery",
        });
        expect(events[2]?.body).toMatchObject({
          text: "let me look.",
          offset: 6,
        });
        expect(events[3]?.body).toMatchObject({ text: "Sure, let me look." });
        expect(events.at(-1)).toMatchObject({
          turn: "1:1",
          body: { reason: "end_turn" },
        });
        expect(fake.raw).toContainEqual({
          session: "session-1",
          run: 1,
          line: "{broken-frame",
          disposition: "unknown",
        });
        expect(fake.raw.some((frame) => frame.disposition === "replay")).toBe(
          true,
        );
        expect(session.getUnknownPayloadCount()).toBe(
          fake.raw.filter((frame) => frame.disposition === "unknown").length,
        );
      } finally {
        await session.close();
      }
    }),
);

it.effect(
  "refuses unregistered versions and reports an ambiguous open after a wire exit",
  () =>
    Effect.promise(async () => {
      const fake = fixture({ ACP_EXIT_ON_NEW: "1" });
      const unknown = createProviderAdapter({
        ...fake.options,
        provider: { agent: "grok", version: "next" },
      });
      try {
        const resumeSpec = { ...fake.spec, checkpoint: "ignored" };
        expect(await unknown.start(resumeSpec)).toEqual({
          status: "unsupported",
          requires: "own",
        });
        expect(existsSync(join(fake.directory, "pid"))).toBe(false);
        expect(await fake.client.start(fake.spec)).toMatchObject({
          status: "in-doubt",
          reason: "unknown",
          code: "channel-ended",
        });
      } finally {
        await unknown.dispose();
      }
    }),
);

it.effect("aborting a pending open stops the spawned process", () =>
  Effect.promise(async () => {
    const fake = fixture({ ACP_HOLD_NEW: "1" });
    const controller = new AbortController();
    const result = fake.client.start(fake.spec, controller.signal);
    expect(
      await waitFor(
        () => existsSync(join(fake.directory, "new-seen")),
        2500,
        5,
      ),
    ).toBe(true);
    const pid = Number(readFileSync(join(fake.directory, "pid"), "utf8"));
    controller.abort();
    await expect(result).rejects.toThrow();
    expect(await waitFor(() => processStopped(pid), 2500, 5)).toBe(true);
  }),
);

it.effect("disposal closes an owned handle and pending event read", () =>
  Effect.promise(async () => {
    const fake = fixture();
    const opened = await fake.client.start(fake.spec);
    if (opened.status !== "opened") throw new Error(JSON.stringify(opened));
    const { session } = opened;
    const pid = Number(readFileSync(join(fake.directory, "pid"), "utf8"));
    const reading = session.events[Symbol.asyncIterator]().next();
    await fake.client.dispose();
    expect(await reading).toEqual({ done: true, value: undefined });
    expect(processStopped(pid)).toBe(true);
    expect(await session.close()).toEqual({ status: "closed" });
    expect(await session.steer(steer)).toEqual({ status: "closed" });
  }),
);

it.effect(
  "local images are sent with their bytes and close fences preparing input",
  () =>
    Effect.promise(async () => {
      const fake = fixture();
      const image = join(fake.directory, "input.png");
      writeFileSync(image, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const request: SteerRequest = {
        ...steer,
        input: [{ type: "local-image", path: image }, ...steer.input],
      };
      const opened = await fake.contract.open(scope);
      if (opened.status !== "opened") throw new Error(JSON.stringify(opened));
      expect(await opened.session.steer(request)).toEqual(bestEffort);
      expect(fake.observed()[0]?.message.params?.prompt).toEqual([
        { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
        { type: "text", text: "list the files here" },
      ]);
      await opened.session.close();

      const fresh = await fake.client.start(fake.spec);
      if (fresh.status !== "opened") throw new Error(JSON.stringify(fresh));
      const preparing = fresh.session.steer(request);
      const closing = fresh.session.close();
      expect(await preparing).toEqual({ status: "closed" });
      expect(await closing).toEqual({ status: "closed" });
      expect(fake.observed()).toHaveLength(1);
    }),
);

it.effect(
  "permission choices are fenced, validated and translated to ACP option IDs",
  () =>
    Effect.promise(async () => {
      const fake = fixture();
      const opened = await fake.contract.open(scope);
      if (opened.status !== "opened") throw new Error(JSON.stringify(opened));
      try {
        await fake.contract.atPendingPrompt(async () => {
          expect(fake.observed()).toEqual([]);
          expect(
            await opened.session.answer({ ...answer, answer: "allow" }),
          ).toMatchObject({
            status: "refused",
            code: "invalid-option",
          });
          expect(
            await opened.session.answer({
              ...answer,
              answer: { behavior: "allow", updatedPermissions: ["remember"] },
            }),
          ).toEqual(controlOutcome);
          expect(fake.observed().map(({ message }) => message.result)).toEqual([
            { outcome: { outcome: "selected", optionId: "always" } },
          ]);
          expect(await opened.session.answer(answer)).toMatchObject({
            status: "stale",
          });
        });
      } finally {
        await opened.session.close();
      }
    }),
);

it.effect(
  "ACP displays bounded redacted options and answers only offered IDs",
  () =>
    Effect.promise(async () => {
      const fake = fixture();
      const opened = await fake.contract.open(scope);
      if (opened.status !== "opened") throw new Error(JSON.stringify(opened));
      const { session } = opened;
      if (session.mode !== "own") throw new Error("Expected an owned session");
      const token = `sk_test_${"a".repeat(28)}`;
      const id = " exact-id ";
      try {
        await fake.wrote({
          frame: {
            id: "permission",
            method: "session/request_permission",
            params: {
              sessionId: session.getCheckpoint(),
              toolCall: { title: `Read\u2028${token}` },
              options: [
                { optionId: "" },
                { optionId: " " },
                { optionId: "x".repeat(129) },
                { optionId: id, name: `Read\r\n${token}`, kind: "allow_once" },
                { optionId: id, name: "Duplicate" },
                { optionId: "other", name: "x".repeat(129), kind: "new_kind" },
                ...Array.from({ length: 15 }, (_, i) => ({
                  optionId: `choice-${i}`,
                })),
              ],
            },
          },
        });
        const events = session.events[Symbol.asyncIterator]();
        const prompt = await events.next();
        const parsed = parseCanonicalEvent(prompt.value);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok || parsed.value.kind !== "prompt.opened")
          throw new Error("Expected an ACP permission prompt");
        expect(parsed.value.body.options?.[1]).not.toHaveProperty("kind");
        expect(prompt).toMatchObject({
          value: {
            kind: "prompt.opened",
            body: {
              summary: "Read [redacted:stripe-secret-key]",
              options: [
                {
                  id,
                  label: "Read [redacted:stripe-secret-key]",
                  kind: "allow_once",
                },
                { id: "other", label: "x".repeat(128) },
                ...Array.from({ length: 14 }, (_, i) => ({
                  id: `choice-${i}`,
                  label: `Option ${i + 3}`,
                })),
              ],
            },
          },
        });
        expect(
          await session.answer({
            ...answer,
            answer: { option_id: "choice-14" },
          }),
        ).toMatchObject({ status: "refused", code: "invalid-option" });
        expect(
          await session.answer({
            ...answer,
            answer: { option_id: id, behavior: "allow" },
          }),
        ).toMatchObject({ status: "refused", code: "invalid-option" });
        expect(
          await session.answer({ ...answer, answer: { option_id: id } }),
        ).toEqual(controlOutcome);
        expect(fake.observed()[0]?.message.result).toEqual({
          outcome: { outcome: "selected", optionId: id },
        });
        await events.next();
        await fake.wrote({
          frame: {
            id: "no-options",
            method: "session/request_permission",
            params: {
              sessionId: session.getCheckpoint(),
              options: [{ optionId: "" }],
            },
          },
        });
        const empty = await events.next();
        expect(parseCanonicalEvent(empty.value).ok).toBe(true);
        expect(empty.value?.body).not.toHaveProperty("options");
      } finally {
        await session.close();
      }
    }),
);

it.effect("interrupt cancels pending permissions for the named turn", () =>
  Effect.promise(async () => {
    const fake = fixture();
    const opened = await fake.contract.open(scope);
    if (opened.status !== "opened") throw new Error(JSON.stringify(opened));
    try {
      await fake.contract.atActiveTurn(() =>
        fake.contract.atPendingPrompt(async () => {
          expect(await opened.session.interrupt(interrupt)).toEqual(
            controlOutcome,
          );
          expect(
            await waitFor(() => fake.observed().length === 3, 2500, 5),
          ).toBe(true);
          expect(fake.observed().slice(1)).toMatchObject([
            {
              action: "answer",
              message: { result: { outcome: { outcome: "cancelled" } } },
            },
            { action: "interrupt" },
          ]);
          expect(await opened.session.answer(answer)).toMatchObject({
            status: "stale",
          });
        }),
      );
    } finally {
      await opened.session.close();
    }
  }),
);

it.effect("oversized frames are retained in order and counted once", () =>
  Effect.promise(async () => {
    const fake = fixture();
    const opened = await fake.client.start(fake.spec);
    if (opened.status !== "opened") throw new Error(JSON.stringify(opened));
    try {
      const raw = "x".repeat(8 * 1024 * 1024) + "é";
      await fake.wrote({ raw });
      const fragments = fake.raw.filter((frame) => frame.base64Fragment);
      expect(fragments.length).toBeGreaterThan(1);
      expect(fragments.map((frame) => frame.base64Fragment?.index)).toEqual(
        fragments.map((_, index) => index),
      );
      expect(fragments.at(-1)?.base64Fragment?.last).toBe(true);
      expect(
        Buffer.concat(
          fragments.map(({ line }) => Buffer.from(line, "base64")),
        ).toString(),
      ).toBe(raw);
      expect(opened.session.getUnknownPayloadCount()).toBe(2);
    } finally {
      await opened.session.close();
    }
  }),
);

it.effect("a saturated live stream preserves every durable event", () =>
  Effect.promise(async () => {
    const fake = fixture();
    const opened = await fake.contract.open(scope);
    if (opened.status !== "opened") throw new Error(JSON.stringify(opened));
    const { session } = opened;
    try {
      for (let index = 0; index < bufferCapacity; index++)
        await fake.contract.sendEvent(index);
      const excess = fake.contract.sendEvent(bufferCapacity);
      if (fake.contract.backpressure.kind !== "block")
        throw new Error("Expected a pausable source");
      await fake.contract.backpressure.wait();
      const iterator = session.events[Symbol.asyncIterator]();
      const first = await iterator.next();
      await excess;
      await fake.contract.processExit();
      const sequences = [];
      for (let item = first; !item.done; item = await iterator.next()) {
        if (item.value.kind !== "message.delta") sequences.push(item.value.seq);
      }
      expect(sequences).toEqual(
        Array.from({ length: bufferCapacity + 2 }, (_, index) => 11 + index),
      );
    } finally {
      await session.close();
    }
  }),
);

const semanticChoices = [
  {
    label: "plain allow prefers once",
    behavior: "allow",
    options: [
      { optionId: "always", kind: "allow_always" },
      { optionId: "once", kind: "allow_once" },
    ],
    selected: "once",
  },
  {
    label: "deny selects rejection",
    behavior: "deny",
    options: [
      { optionId: "allow", kind: "allow_once" },
      { optionId: "deny", kind: "reject_once" },
    ],
    selected: "deny",
  },
  {
    label: "allow reaches beyond both display limits",
    behavior: "allow",
    options: [
      ...Array.from({ length: 16 }, (_, i) => ({
        optionId: `deny-${i}`,
        kind: "reject_once",
      })),
      { optionId: "x".repeat(129), kind: "allow_once" },
    ],
    selected: "x".repeat(129),
  },
  {
    label: "allow skips blank IDs",
    behavior: "allow",
    options: [
      { optionId: " ", kind: "allow_once" },
      { optionId: "valid", kind: "allow_always" },
    ],
    selected: "valid",
  },
  {
    label: "allow skips shadowed duplicate IDs",
    behavior: "allow",
    options: [
      { optionId: "duplicate", kind: "reject_once" },
      { optionId: "duplicate", kind: "allow_once" },
      { optionId: "valid", kind: "allow_always" },
    ],
    selected: "valid",
  },
];

for (const { label, behavior, options, selected } of semanticChoices) {
  it.effect(`ACP semantic permission: ${label}`, () =>
    Effect.promise(async () => {
      const fake = fixture();
      const opened = await fake.contract.open(scope);
      if (opened.status !== "opened" || opened.session.mode !== "own")
        throw new Error("Expected an owned session");
      const { session } = opened;
      try {
        await fake.wrote({
          frame: {
            id: "permission",
            method: "session/request_permission",
            params: { sessionId: session.getCheckpoint(), options },
          },
        });
        expect(
          await session.answer({ ...answer, answer: { behavior } }),
        ).toEqual(controlOutcome);
        expect(fake.observed()[0]?.message.result).toEqual({
          outcome: { outcome: "selected", optionId: selected },
        });
      } finally {
        await session.close();
      }
    }),
  );
}
