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
  const deliveries = new Map<string, string>();
  let lastFinished: string | undefined;
  let trailingIdle = false;
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
    const id = turns.send(
      {
        ...steer,
        delivery_id,
        expected: { ...steer.expected, turn: turns.active() },
      },
      delivery_id,
    );
    deliveries.set(id, delivery_id);
    trace.push(`command ${id} for steer ${delivery_id}`);
    return id;
  }
  function recordFinished(id: string) {
    if (attributed.has(deliveries.get(id)!)) lastFinished = id;
  }
  function status(state: "running" | "idle") {
    frame({ type: "system", subtype: "session_state_changed", state });
    trailingIdle = false;
    if (state === "idle")
      assert.equal(turns.active(), null, "idle left a live turn");
  }
  function lifecycle(
    state: "queued" | "started" | "completed" | "cancelled",
    command_uuid: string,
  ) {
    return frame({ type: "command_lifecycle", state, command_uuid });
  }
  function terminal(id: string) {
    assert(lifecycle(pick(2) ? "completed" : "cancelled", id));
  }
  function start(id: string, running = pick(2) === 1) {
    if (running) status("running");
    assert(lifecycle("started", id), "pending input did not start");
    assert(turns.active(), "started input did not open a turn");
    assert(
      attributed.has(deliveries.get(id)!),
      "started input was not attributed",
    );
    trailingIdle = false;
    if (pick(3) === 0) lifecycle("started", id);

    const replay = lastFinished;
    if (replay) {
      const live = turns.active();
      assert.equal(
        frame({
          type: "result",
          subtype: "success",
          is_error: false,
          user_message_uuids: [replay],
        }),
        false,
        "finished input result was accepted as live",
      );
      assert.equal(turns.active(), live, "replay closed the live turn");
      assert.equal(open, live, "replay emitted a turn end");
    }
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
    for (const id of ids ?? []) recordFinished(id);
    trailingIdle = true;
  }

  try {
    if (pick(2)) {
      status("running");
      result();
      if (pick(2)) status("idle");
    }
    while (submitted < inputCount) {
      const first = submit();
      if (pick(2) || trailingIdle) lifecycle("queued", first);
      if (pick(4) === 0) {
        terminal(first);
        trailingIdle = false;
        if (pick(2)) {
          status("running");
          assert.equal(lifecycle("started", first), false);
          result([first]);
          status("idle");
        }
        continue;
      }
      if (pick(3) === 0) {
        const mustSurviveIdle = trailingIdle;
        status("idle");
        if (mustSurviveIdle) {
          start(first, false);
          result([first]);
          status("idle");
        }
        continue;
      }
      start(first);
      if (submitted < inputCount && pick(2)) {
        const queued = submit();
        lifecycle("queued", queued);
        switch (pick(4)) {
          case 0:
            start(queued);
            result([first, queued]);
            break;
          case 1:
            terminal(first);
            terminal(queued);
            result([first]);
            assert(
              !turns.awaitingTurn(),
              "result left terminal inputs pending",
            );
            break;
          case 2:
            result([first]);
            terminal(queued);
            if (submitted < inputCount) continue;
            break;
          default:
            result(pick(2) ? [first] : undefined);
            if (pick(2)) {
              status("idle");
              status("running");
              assert.equal(lifecycle("started", queued), false);
            } else start(queued);
            result([queued]);
        }
      } else if (pick(3)) result(pick(2) ? [first] : undefined);
      status("idle");
      recordFinished(first);
    }
    assert.equal(open, null, "trace left a turn open");
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
