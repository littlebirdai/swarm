import type { EdgeJson } from "@codecast/edge-contract";
import { readEvent, requireOpened } from "./provider-fixture";
import { expect } from "bun:test";
import { it } from "@codecast/effect-kit/effect/testing";
import * as Effect from "effect/Effect";
import { createProviderAdapter } from "../src";
import {
  answer,
  approval,
  claudeCase,
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

claudeCase(
  "initialize keeps same-chunk frames",
  async (session, fake) => {
    await fake.retained("startup-model");
    expect(fake.disposition("startup-model")).toBe("decoded");
    expect(
      (await session.events[Symbol.asyncIterator]().next()).value,
    ).toMatchObject({
      kind: "context",
      body: { data: { model: "startup-model" } },
    });
  },
  { FIXTURE_INIT_FRAME: "1" },
);

for (const { label, failKill, expected, count } of [
  {
    label: "failed initialize drains async raw frames after exit",
    failKill: false,
    expected: { status: expect.stringMatching(/refused|in-doubt/u) },
    count: 2,
  },
  {
    label:
      "failed open returns cleanup uncertainty when the process group denies kill",
    failKill: true,
    expected: {
      status: "in-doubt",
      reason: "unknown",
      code: "cleanup-uncertain",
    },
    count: 1,
  },
]) {
  it.effect(label, () =>
    Effect.promise(async () => {
      const fake = fixture({
        FIXTURE_CLAUDE_VERSION: "2.1.318",
        ...(failKill
          ? { FIXTURE_DENY_KILL: "1" }
          : { FIXTURE_INIT_EXIT: "1", FIXTURE_INIT_FRAME: "1" }),
      });
      const retained: string[] = [];
      const client = createProviderAdapter({
        ...fake.options,
        async retainRaw(frame, signal) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          signal.throwIfAborted();
          retained.push(frame.line);
        },
      });
      try {
        expect(await client.start(fake.spec)).toMatchObject(expected);
        expect(retained).toHaveLength(count);
        expect(retained[0]).toContain("2.1.318");
        expect(fake.contract.releases()).toBe(1);
      } finally {
        await client.dispose();
      }
    }),
  );
}

it.effect(
  "permission replies accept exactly one selector and omit JSON-RPC framing",
  () =>
    Effect.promise(async () => {
      const fake = fixture();
      const { session } = requireOpened(await fake.contract.open(fake.spec));
      await fake.contract.atPendingPrompt(async () => {
        const rejected: EdgeJson[] = [
          { behavior: "allow", option_id: "deny" },
          { behavior: "allow", extra: true },
          { option_id: "allow", extra: true },
          { option_id: "allow_always" },
          null,
        ];
        for (const invalid of rejected) {
          expect(
            await session.answer({ ...answer, answer: invalid }),
          ).toMatchObject({ status: "refused", code: "invalid-answer" });
        }
        expect(fake.observed()).toEqual([]);
        expect(await session.answer(answer)).toEqual(noAnswerAck);
        expect(fake.observed()[0]).not.toHaveProperty("jsonrpc");
      });
    }),
);

claudeCase(
  "Claude replies to unsupported control requests and marks them unknown",
  async (session, fake) => {
    fake.frames(runningFrame, {
      ...approval,
      request_id: "unsupported",
      request: { subtype: "fixture-unsupported" },
    });
    await fake.retained("fixture-unsupported");
    expect(session.getUnknownPayloadCount()).toBe(1);
    await fake.wrote(1);
    expect(fake.observed()[0]).toMatchObject({
      type: "control_response",
      response: { request_id: "unsupported", subtype: "error" },
    });
  },
);

const assistant = (
  uuid: string,
  error?: string,
  parent_tool_use_id?: string,
) => ({
  type: "assistant",
  uuid,
  error,
  parent_tool_use_id,
  message: { content: [{ type: "text", text: "synthetic error" }] },
});
const result = (uuid: string, fields = {}) => ({
  type: "result",
  uuid,
  subtype: "success",
  is_error: false,
  ...fields,
});
const lifecycle = (state: string, command_uuid: string) => ({
  type: "command_lifecycle",
  uuid: state,
  state,
  command_uuid,
});
const idle = { ...runningFrame, uuid: "fixture-idle", state: "idle" };

claudeCase(
  "completed input outside a turn does not open a phantom turn",
  async (session, fake) => {
    const events = session.events[Symbol.asyncIterator]();
    expect(await session.steer(steer)).toEqual(noReceipt);
    await fake.wrote(1);
    expect(
      await session.steer({ ...steer, delivery_id: "second" }),
    ).toMatchObject({ code: "turn-pending" });
    fake.frames(
      lifecycle("completed", fake.observed()[0]!.uuid!),
      idle,
      fake.eventFrame(0),
    );
    expect((await events.next()).value).toMatchObject({
      kind: "context",
      turn: null,
    });
    expect(await session.steer({ ...steer, delivery_id: "second" })).toEqual(
      noReceipt,
    );
  },
);

claudeCase(
  "idle releases input that never received a start or result",
  async (session, fake) => {
    expect(await session.steer(steer)).toEqual(noReceipt);
    fake.frames(idle);
    await fake.retained(idle.uuid);
    expect(await session.steer({ ...steer, delivery_id: "next" })).toEqual(
      noReceipt,
    );
  },
);

for (const hasConsumedId of [false, true]) {
  claudeCase(
    hasConsumedId
      ? "idle after a result releases an unconsumed mid-turn steer"
      : "idle after a result without IDs releases pending input",
    async (session, fake) => {
      const next = readEvent(session);
      expect(await session.steer(steer)).toEqual(noReceipt);
      await fake.wrote(1);
      fake.frames(runningFrame);
      expect(await next()).toMatchObject({ kind: "turn.started" });
      if (hasConsumedId) {
        expect(
          await session.steer({
            ...steer,
            expected: interrupt.expected,
            delivery_id: "mid-turn",
          }),
        ).toEqual(noReceipt);
        await fake.wrote(2);
        const consumed = fake.observed()[0]!.uuid!;
        fake.frames(result("first-result", { user_message_uuids: [consumed] }));
        expect(await next()).toMatchObject({ kind: "message.user" });
      } else fake.frames(result("first-result"));
      expect(await next()).toMatchObject({ kind: "turn.ended" });
      fake.frames(idle);
      await fake.retained(idle.uuid);
      expect(await session.steer({ ...steer, delivery_id: "next" })).toEqual(
        noReceipt,
      );
    },
  );
}

claudeCase(
  "a queued successor survives the previous result's trailing idle",
  async (session, fake) => {
    const next = readEvent(session);
    fake.frames(runningFrame, result("first-result"));
    const first = await next();
    expect(first).toMatchObject({ kind: "turn.started" });
    expect(await next()).toMatchObject({ kind: "turn.ended" });
    expect(await session.steer(steer)).toEqual(noReceipt);
    await fake.wrote(1);
    const uuid = fake.observed()[0]!.uuid!;
    fake.frames(
      lifecycle("queued", uuid),
      idle,
      lifecycle("started", uuid),
      result("second-result", { user_message_uuids: [uuid] }),
      fake.eventFrame(0),
    );
    const second = await next();
    expect(second).toMatchObject({ kind: "turn.started" });
    expect(second?.turn).not.toBe(first?.turn);
    expect(await next()).toMatchObject({
      kind: "message.user",
      turn: second?.turn,
      body: { delivery_id: steer.delivery_id },
    });
    expect(await next()).toMatchObject({
      kind: "turn.ended",
      turn: second?.turn,
      body: { reason: "completed" },
    });
    expect(await next()).toMatchObject({ kind: "context", turn: null });
  },
);

for (const retiredBy of ["idle", "completed", "cancelled"] as const) {
  claudeCase(
    `later result survives an unstarted send retired by ${retiredBy}`,
    async (session, fake) => {
      const next = readEvent(session);
      expect(await session.steer(steer)).toEqual(noReceipt);
      await fake.wrote(1);
      const first = fake.observed()[0]!.uuid!;
      if (retiredBy === "idle") {
        fake.frames(runningFrame);
        expect(await next()).toMatchObject({ kind: "turn.started" });
        expect(
          await session.steer({
            ...steer,
            expected: interrupt.expected,
            delivery_id: "mid-turn",
          }),
        ).toEqual(noReceipt);
        await fake.wrote(2);
        fake.frames(
          result("first-result", { user_message_uuids: [first] }),
          idle,
        );
        expect(await next()).toMatchObject({ kind: "message.user" });
        expect(await next()).toMatchObject({ kind: "turn.ended" });
      }
      const deferred = fake.observed().at(-1)!.uuid!;
      fake.frames(
        ...(retiredBy === "idle" ? [] : [lifecycle(retiredBy, deferred)]),
        { ...runningFrame, uuid: "deferred-turn" },
        lifecycle("started", deferred),
        result("deferred-result", {
          user_message_uuids: [deferred],
          is_error: true,
        }),
        fake.eventFrame(0),
      );
      const turn = (await next())?.turn;
      expect(await next()).toMatchObject({ kind: "error", turn });
      expect(await next()).toMatchObject({
        kind: "turn.ended",
        turn,
        body: { reason: "failed" },
      });
      expect(await next()).toMatchObject({ kind: "context", turn: null });
    },
  );
}

for (const nextBoundary of [
  "completed",
  "cancelled",
  "idle",
  "running",
] as const) {
  claudeCase(
    `${nextBoundary} clears the previous result snapshot`,
    async (session, fake) => {
      const next = readEvent(session);
      fake.frames(runningFrame, result("first-result"));
      expect(await next()).toMatchObject({ kind: "turn.started" });
      expect(await next()).toMatchObject({ kind: "turn.ended" });

      if (nextBoundary === "idle") {
        fake.frames(idle);
        await fake.retained(idle.uuid);
      }
      expect(await session.steer(steer)).toEqual(noReceipt);
      if (nextBoundary === "completed" || nextBoundary === "cancelled") {
        await fake.wrote(1);
        const frame = lifecycle(nextBoundary, fake.observed()[0]!.uuid!);
        fake.frames(frame);
        await fake.retained(frame.uuid);
        expect(
          await session.steer({ ...steer, delivery_id: "second" }),
        ).toEqual(noReceipt);
      } else if (nextBoundary === "running") {
        fake.frames({ ...runningFrame, uuid: "next-turn" });
        expect(await next()).toMatchObject({ kind: "turn.started" });
      }
      fake.frames({ ...idle, uuid: "final-idle" });
      await fake.retained("final-idle");
      expect(await session.steer({ ...steer, delivery_id: "next" })).toEqual(
        noReceipt,
      );
    },
  );
}

claudeCase(
  "a cancelled command keeps its result and earlier errors do not override interrupt",
  async (session, fake) => {
    const next = readEvent(session);
    expect(await session.steer(steer)).toEqual(noReceipt);
    await fake.wrote(1);
    const uuid = fake.observed()[0]!.uuid!;
    fake.frames(
      runningFrame,
      lifecycle("cancelled", uuid),
      assistant("error", "rate_limit"),
      result("cancel-result", {
        user_message_uuids: [uuid],
        terminal_reason: "aborted_streaming",
        is_error: true,
      }),
      fake.eventFrame(0),
    );
    expect((await next())?.kind).toBe("turn.started");
    expect(await next()).toMatchObject({
      kind: "message.user",
    });
    expect(await next()).toMatchObject({
      kind: "turn.ended",
      body: { reason: "interrupted" },
    });
    expect((await next())?.kind).toBe("context");
  },
);

for (const [label, child, failed] of [
  ["successful result", false, false],
  ["subagent error", true, true],
] as const) {
  claudeCase(
    `${label} does not inherit a stale assistant error`,
    async (session, fake) => {
      const next = readEvent(session);
      fake.frames(
        assistant("orphan"),
        runningFrame,
        assistant("error", "rate_limit", child ? "parent-tool" : undefined),
        result(
          "result",
          failed
            ? { result: "", errors: ["fixture fallback"], is_error: true }
            : {},
        ),
      );
      expect((await next())?.kind).toBe("turn.started");
      if (failed)
        expect(await next()).toMatchObject({
          kind: "error",
          body: { class: "claude-turn", message: "fixture fallback" },
        });
      expect(await next()).toMatchObject({
        kind: "turn.ended",
        body: { reason: failed ? "failed" : "completed" },
      });
      expect(fake.disposition("orphan")).toBe("replay");
      if (child) expect(fake.disposition("parent-tool")).toBe("replay");
    },
  );
}

claudeCase(
  "long questions preserve wire text and settlement redacts free text",
  async (session, fake) => {
    const question = "Question ".repeat(40);
    const label = "Option ".repeat(50);
    const ask = {
      ...approval,
      request: {
        ...approval.request,
        tool_name: "AskUserQuestion",
        input: { questions: [{ question, options: [{ label }] }] },
      },
    };
    fake.frames(
      runningFrame,
      {
        ...ask,
        request_id: "invalid",
        request: { ...ask.request, input: { questions: "malformed" } },
      },
      ask,
    );
    const next = readEvent(session);
    expect((await next())?.kind).toBe("turn.started");
    expect(await next()).toMatchObject({
      kind: "prompt.opened",
      body: { options: [{ id: "0", label: label.slice(0, 128) }] },
    });
    expect((await next())?.kind).toBe("context");
    expect(fake.disposition("malformed")).toBe("unknown");
    const token = `sk-ant-${"x".repeat(30)}`;
    expect(
      await session.answer({
        ...answer,
        answer: { answers: { "0": { answers: [token] } } },
      }),
    ).toEqual(noAnswerAck);
    await fake.wrote(2);
    expect(fake.observed()[1]?.response?.response).toMatchObject({
      updatedInput: { answers: { [question]: token } },
    });
    const settled = await next();
    expect(settled?.kind).toBe("prompt.settled");
    expect(JSON.stringify(settled)).not.toContain(token);
  },
);

claudeCase(
  "invalid interrupt responses are retained as unknown",
  async (session, fake) =>
    fake.contract.atActiveTurn(async () => {
      const pending = session.interrupt(interrupt);
      await fake.wrote(1);
      const { response, ...frame } = interruptReply(
        fake.observed()[0]!.request_id!,
      );
      fake.frames({
        ...frame,
        response: { ...response, response: "invalid-ack" },
      });
      expect(await pending).toMatchObject({ code: "invalid-interrupt" });
      await fake.retained("invalid-ack");
      expect(fake.disposition("invalid-ack")).toBe("unknown");
    }),
  { FIXTURE_HOLD_INTERRUPTS: "1" },
);

claudeCase(
  "failed prompt writes never settle a prompt",
  async (session, fake) => {
    fake.frames(runningFrame, approval);
    const next = readEvent(session);
    expect((await next())?.kind).toBe("turn.started");
    expect((await next())?.kind).toBe("prompt.opened");
    fake.interceptWrite((data, write) =>
      typeof data === "string" && data.includes('"request_id":"approval"')
        ? Promise.reject(new Error("fixture write failed"))
        : write(data),
    );
    expect(await session.answer(answer)).toMatchObject({
      status: "in-doubt",
      code: "write-failed",
    });
    fake.frames(fake.eventFrame(0));
    expect((await next())?.kind).toBe("context");
  },
);

it.effect("stderr failure settles a control with a full event buffer", () =>
  Effect.promise(async () => {
    const fake = fixture({
      FIXTURE_STDERR_FAILURE: "1",
      FIXTURE_HOLD_INTERRUPTS: "1",
    });
    const { session } = requireOpened(await fake.contract.open(fake.spec));
    await fake.contract.atActiveTurn(async () => {
      const pending = session.interrupt(interrupt);
      await fake.wrote(1);
      fake.send({
        frames: Array.from({ length: 35 }, (_, index) =>
          fake.eventFrame(index),
        ),
      });
      await fake.retained('"model":"model-31"');
      fake.send({ stderr: "fixture stderr fault" });
      expect(await pending).toMatchObject({
        status: "in-doubt",
        code: "stderr-handler",
      });
    });
    expect(await session.interrupt(interrupt)).toEqual({ status: "closed" });
    await expect(Array.fromAsync(session.events)).rejects.toMatchObject({
      code: "stderr-handler",
    });
  }),
);
