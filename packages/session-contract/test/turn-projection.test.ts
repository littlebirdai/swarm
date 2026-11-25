import { expect, test } from "bun:test";
import type { CanonicalEvent } from "@codecast/edge-contract";
import { testFaker } from "@codecast/test-helpers/faker";
import { sessionMachine } from "@codecast/session-contract";
import {
  projectTurn,
  type TurnProjection,
} from "@codecast/session-contract/turn-projection";
import { ready, scope, request } from "./fixtures";

type Payload<K extends CanonicalEvent["kind"] = CanonicalEvent["kind"]> =
  K extends CanonicalEvent["kind"]
    ? Pick<Extract<CanonicalEvent, { kind: K }>, "kind" | "body">
    : never;

const starter: TurnProjection = {
  ...scope,
  status: "active",
  eventSeq: 0,
  turnIds: [],
  openTurn: null,
};
const actor = request.sender;
const payloads = {
  "session.started": {
    kind: "session.started",
    body: { machine: "dev", provider: "agent" },
  },
  "session.moved": {
    kind: "session.moved",
    body: { from_machine: "dev", to_machine: "other" },
  },
  "session.ended": { kind: "session.ended", body: { reason: "closed" } },
  "turn.started": { kind: "turn.started", body: {} },
  "turn.ended": { kind: "turn.ended", body: { reason: "completed" } },
  "message.user": {
    kind: "message.user",
    body: { text: "start", authors: [actor] },
  },
  "message.assistant": {
    kind: "message.assistant",
    body: { message_id: "reply", text: "done" },
  },
  "tool.call": {
    kind: "tool.call",
    body: { call_id: "call", name: "tool", input: {} },
  },
  "tool.result": {
    kind: "tool.result",
    body: { call_id: "call", output: { inline: null }, is_error: false },
  },
  "prompt.opened": {
    kind: "prompt.opened",
    body: { prompt_id: "first", kind: "permission" },
  },
  "prompt.settled": {
    kind: "prompt.settled",
    body: { prompt_id: "second", by: actor, answer: true },
  },
  "terminal.started": {
    kind: "terminal.started",
    body: { pane_instance: 1, actor },
  },
  "terminal.ended": {
    kind: "terminal.ended",
    body: {
      pane_instance: 1,
      started_run: 1,
      outcome: { kind: "exit", code: 0 },
    },
  },
  receipt: { kind: "receipt", body: { delivery_id: "delivery" } },
  context: { kind: "context", body: { data: {} } },
  usage: {
    kind: "usage",
    body: {
      model: "agent",
      input_tokens: 1,
      output_tokens: 1,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    },
  },
  error: {
    kind: "error",
    body: { class: "provider", message: "closed", retryable: false },
  },
} satisfies { [K in CanonicalEvent["kind"]]: Payload<K> };

function event(
  seq: number,
  turn: string | null,
  payload: Payload,
): CanonicalEvent {
  return { ...scope, v: 1, at: 0, source: "provider", seq, turn, ...payload };
}

test("every split matches a direct reducer pass on randomized event streams", () => {
  const random = testFaker("turn-projection-event-streams");
  const kinds = Object.values(payloads);
  const turns = [null, "A", "B", "C"];
  for (let trial = 0; trial < 100; trial++) {
    const shuffled = random.helpers.shuffle(kinds);
    const events = [
      event(1, "A", payloads["turn.started"]),
      event(2, "A", payloads["prompt.opened"]),
      event(3, "A", {
        kind: "prompt.opened",
        body: { prompt_id: "second", kind: "permission" },
      }),
      event(4, "A", payloads["prompt.settled"]),
      ...Array.from({ length: 32 }, (_, i) => {
        const seq = i + 5;
        const payload = shuffled[i % shuffled.length]!;
        const prompt_id = random.helpers.arrayElement([
          "first",
          "second",
          "third",
        ]);
        const content =
          payload.kind === "prompt.opened"
            ? { ...payload, body: { ...payload.body, prompt_id } }
            : payload.kind === "prompt.settled"
              ? { ...payload, body: { ...payload.body, prompt_id } }
              : payload;
        const next = event(
          random.helpers.arrayElement([
            seq,
            seq,
            seq - 1,
            seq + 0.5,
            NaN,
            Infinity,
            Number.MAX_SAFE_INTEGER + 1,
          ]),
          random.helpers.arrayElement(turns),
          content,
        );
        if (random.number.int({ max: 9 }) === 0) return { ...next, run: 2 };
        return next;
      }),
    ];
    const before = structuredClone(events);
    let direct = ready;
    for (const [index, entry] of events.entries()) {
      direct = sessionMachine.apply(direct, {
        kind: "provider.event",
        event: entry,
      }).state;
      const expected = {
        ...scope,
        status: direct.status,
        eventSeq: direct.eventSeq,
        turnIds: direct.turnIds,
        openTurn:
          direct.turn.id !== null &&
          (direct.turn.status === "running" || direct.turn.status === "blocked")
            ? {
                id: direct.turn.id,
                promptIds: direct.turn.prompts.map(({ id }) => id),
              }
            : null,
      };
      const prefix = events.slice(0, index + 1);
      expect(projectTurn(starter, prefix)).toEqual(expected);
      for (let split = 0; split <= prefix.length; split++)
        expect(
          projectTurn(
            projectTurn(starter, prefix.slice(0, split)),
            prefix.slice(split),
          ),
        ).toEqual(expected);
    }
    expect(events).toEqual(before);
  }
});

test("settles concurrent prompts by ID and stays blocked until the last settlement", () => {
  const events = [
    event(1, "A", payloads["turn.started"]),
    event(2, "A", payloads["prompt.opened"]),
    event(3, "A", {
      kind: "prompt.opened",
      body: { prompt_id: "second", kind: "permission" },
    }),
    event(4, "A", payloads["prompt.settled"]),
    event(5, "A", {
      kind: "prompt.settled",
      body: { ...payloads["prompt.settled"].body, prompt_id: "first" },
    }),
  ];
  const both = projectTurn(starter, events.slice(0, 3));
  expect(both.openTurn).toEqual({ id: "A", promptIds: ["first", "second"] });
  expect(projectTurn(both, [event(4, "A", payloads["prompt.opened"])])).toEqual(
    both,
  );
  const one = projectTurn(both, events.slice(3, 4));
  expect(one.openTurn).toEqual({ id: "A", promptIds: ["first"] });
  expect(projectTurn(one, events.slice(4)).openTurn).toEqual({
    id: "A",
    promptIds: [],
  });
});

test("an equal sequence cannot apply a different transition", () => {
  const open = projectTurn(starter, [event(1, "A", payloads["turn.started"])]);
  expect(projectTurn(open, [event(1, "A", payloads["prompt.opened"])])).toEqual(
    open,
  );
  for (const seq of [1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    expect(
      projectTurn(open, [event(seq, "A", payloads["prompt.opened"])]),
    ).toEqual(open);
});

test("retains the last ended turn across a split for a named session end", () => {
  const ended = projectTurn(starter, [
    event(1, "A", payloads["turn.started"]),
    event(2, "A", payloads["turn.ended"]),
  ]);
  expect(ended.openTurn).toBeNull();
  const completed = projectTurn(ended, [
    event(3, "A", payloads["session.ended"]),
  ]);
  expect(completed).toEqual({ ...ended, eventSeq: 3, status: "completed" });
  const successor = projectTurn(ended, [
    event(3, "B", payloads["turn.started"]),
  ]);
  expect(
    projectTurn(successor, [event(4, "A", payloads["session.ended"])]),
  ).toEqual(successor);
});

test("keeps at most 32 distinct open prompts", () => {
  const open = projectTurn(starter, [event(1, "A", payloads["turn.started"])]);
  const ids = Array.from({ length: 33 }, (_, i) => String(i));
  const projected = projectTurn(
    open,
    ids.map((id, i) =>
      event(i + 2, "A", {
        kind: "prompt.opened",
        body: { prompt_id: id, kind: "permission" },
      }),
    ),
  );
  expect(projected.openTurn?.promptIds).toEqual(ids.slice(0, 32));
  expect(
    projectTurn(projected, [
      event(40, "A", payloads["prompt.opened"]),
      event(41, "A", payloads["turn.ended"]),
    ]).openTurn,
  ).toBeNull();
});

test("answer requests are independent for each open prompt", () => {
  let state = ready;
  for (const entry of [
    event(1, "A", payloads["turn.started"]),
    event(2, "A", payloads["prompt.opened"]),
    event(3, "A", {
      kind: "prompt.opened",
      body: { prompt_id: "second", kind: "permission" },
    }),
  ]) {
    state = sessionMachine.apply(state, {
      kind: "provider.event",
      event: entry,
    }).state;
  }

  const answer = {
    ...scope,
    kind: "person.answer",
    turn: "A",
    prompt_id: "first",
    answer: true,
  } as const;
  const first = sessionMachine.apply(state, answer);
  expect(first.effects).toMatchObject([
    { kind: "prompt.answer", prompt_id: "first" },
  ]);
  expect(sessionMachine.apply(first.state, answer).effects).toEqual([]);
  const second = sessionMachine.apply(first.state, {
    ...answer,
    prompt_id: "second",
  });
  expect(second.effects).toMatchObject([
    { kind: "prompt.answer", prompt_id: "second" },
  ]);
  expect(second.state.turn.status).toBe("blocked");
  expect(
    sessionMachine.apply(second.state, { ...answer, prompt_id: "second" })
      .effects,
  ).toEqual([]);
});
