import assert from "node:assert/strict";
import { it } from "@codecast/effect-kit/effect/testing";
import * as Effect from "effect/Effect";
import { claudeTurns } from "../src/claude-sdk-turns";
import type { DurablePayload } from "../src/provider-events";
import { steer } from "./claude-sdk-fixture";

const checkpoint = "00000000-0000-4000-8000-000000000001";
type Frame = Parameters<ReturnType<typeof claudeTurns>["receive"]>[0];
type Body<F = Frame> = F extends Frame ? Omit<F, "session_id" | "uuid"> : never;

function exercise(seed: number) {
  let state = seed;
  function pick(limit: number) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % limit;
  }
  const inputCount = 2 + pick(2);
  const trace: string[] = [];
  const attributed = new Set<string>();
  let submitted = 0;
  let frameIndex = 0;
  let open: string | null = null;
  let completions = 0;
  const turns = claudeTurns(
    1,
    checkpoint,
    (payload: DurablePayload, turn) =>
      Effect.sync(() => {
        switch (payload.kind) {
          case "turn.started":
            assert.equal(open, null, "two turns open");
            assert(turn);
            open = turn;
            break;
          case "turn.ended":
            assert(open && turn === open, "turn ended out of order");
            open = null;
            if (
              payload.body.reason === "completed" ||
              payload.body.reason === "failed"
            )
              completions++;
            break;
          case "message.user": {
            const id = payload.body.delivery_id;
            assert(
              id && open && turn === open,
              "input attributed outside a turn",
            );
            assert(!attributed.has(id), "input attributed twice");
            attributed.add(id);
            break;
          }
        }
      }),
    () => {},
  );

  function frame(body: Body) {
    trace.push(JSON.stringify(body));
    const work: Effect.Effect<void>[] = [];
    const accepted = Effect.runSync(
      turns.receive(
        { ...body, session_id: checkpoint, uuid: String(++frameIndex) },
        work,
      ),
    );
    for (const step of work) Effect.runSync(step);
    return accepted;
  }
  function submit() {
    const delivery_id = String(++submitted);
    trace.push(`steer ${delivery_id}`);
    assert(!turns.awaitingTurn(), "new steer is blocked");
    return turns.send(
      {
        ...steer,
        delivery_id,
        expected: { ...steer.expected, turn: turns.active() },
      },
      delivery_id,
    );
  }
  function status(state: "running" | "idle") {
    frame({ type: "system", subtype: "session_state_changed", state });
    if (state === "idle")
      assert.equal(turns.active(), null, "idle left a live turn");
  }
  function lifecycle(
    state: "queued" | "started" | "completed" | "cancelled",
    command_uuid: string,
  ) {
    frame({ type: "command_lifecycle", state, command_uuid });
  }
  function start(id: string) {
    if (pick(2)) status("running");
    lifecycle("started", id);
    if (pick(3) === 0) lifecycle("started", id);
  }
  function result(ids?: string[]) {
    const before = completions;
    assert(open, "generated result has no active turn");
    assert(
      frame({
        type: "result",
        subtype: "success",
        is_error: pick(2) === 1,
        ...(ids ? { user_message_uuids: ids } : {}),
      }),
      "live result was dropped",
    );
    assert.equal(completions, before + 1, "live result did not end its turn");
    assert.equal(turns.active(), null);
  }

  try {
    if (pick(2)) {
      status("running");
      result();
      if (pick(2)) status("idle");
    }
    while (submitted < inputCount) {
      const first = submit();
      if (pick(2)) lifecycle("queued", first);
      if (pick(4) === 0) {
        lifecycle(pick(2) ? "completed" : "cancelled", first);
        if (pick(2)) {
          status("running");
          lifecycle("started", first);
          result([first]);
          status("idle");
        }
        continue;
      }
      if (pick(3) === 0) {
        status("idle");
        status("running");
        lifecycle("started", first);
        result([first]);
        status("idle");
        continue;
      }
      start(first);
      if (submitted < inputCount && pick(2)) {
        const queued = submit();
        lifecycle("queued", queued);
        if (pick(3) === 0) {
          lifecycle("started", queued);
          result([first, queued]);
        } else {
          if (pick(3) === 0)
            lifecycle(pick(2) ? "completed" : "cancelled", queued);
          result(pick(2) ? [first] : undefined);
          if (pick(2)) status("idle");
          status("running");
          lifecycle("started", queued);
          result([queued]);
        }
      } else if (pick(3)) result(pick(2) ? [first] : undefined);
      status("idle");
    }
    status("idle");
    submit();
  } catch (cause) {
    throw new Error(`Claude ordering seed ${seed}\n${trace.join("\n")}`, {
      cause,
    });
  }
}

const caseCount = process.env.CLAUDE_TURN_EXTENDED === "1" ? 100_000 : 384;

it.effect(
  `generated Claude turns preserve results and release idle input (${caseCount} cases)`,
  () =>
    Effect.sync(() => {
      for (let seed = 1; seed <= caseCount; seed++) exercise(seed);
    }),
  120_000,
);
