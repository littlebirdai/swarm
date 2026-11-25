import { expect, test } from "bun:test";
import {
  sessionMachine,
  type SessionFact,
  type SessionState,
} from "@codecast/session-contract";
import { testFaker } from "@codecast/test-helpers/faker";
import {
  ambiguous,
  applyFacts,
  blocked,
  claimed,
  doubt,
  empty,
  ended,
  event,
  fence,
  opened,
  pending,
  permit,
  permitted,
  ready,
  request,
  running,
  scope,
  sending,
  start,
  started,
  submit,
} from "./fixtures";

const terminalRuns = ["stopped", "quarantined"];
const terminalDeliveries = [
  "delivered",
  "correlated-delivered",
  "failed",
  "rejected",
  "cancelled-by-supersession",
  "abandoned-ambiguous",
];

function factsFor(state: SessionState, index: number): SessionFact[] {
  const target = { session: state.session, run: state.run };
  const activeFence = {
    ...target,
    fencing_token: state.lease?.fencing_token ?? "unclaimed",
  };
  const last = state.inbox.at(-1);
  const head = state.inbox.find(
    (message) => !terminalDeliveries.includes(message.status),
  );
  const headRef = {
    ...activeFence,
    delivery_id: head?.delivery_id ?? request.delivery_id,
    attempt_id: head?.attempts.at(-1)?.id ?? "unissued",
  };
  const delivery = {
    ...request,
    ...headRef,
    intent: head?.intent ?? "queue",
    seq: head?.seq ?? 1,
  } as const;
  const freshInput = {
    delivery_id: `delivery-${index}`,
    seq: (last?.seq ?? 0) + 1,
    intent: index % 2 ? "queue" : "steer",
  } as const;
  const currentTurn = state.turn.id ?? "missing-turn";
  const liveTurn =
    state.turn.status === "running" || state.turn.status === "blocked"
      ? state.turn.id
      : null;
  const prompt_id = state.turn.prompt ?? "missing-prompt";
  const seq = state.eventSeq + 1;
  return [
    {
      ...target,
      kind: "run.claimed",
      fencing_token: `token-${index}`,
      expires_at: index + 10,
    },
    {
      ...activeFence,
      kind: "run.renewed",
      expires_at: (state.lease?.expires_at ?? 0) + 10,
    },
    {
      ...activeFence,
      kind: "run.leaseExpired",
      expires_at: state.lease?.expires_at ?? 0,
    },
    { ...activeFence, kind: "run.runtimeReady" },
    { ...activeFence, kind: "run.launchFailed", retryable: index % 2 === 0 },
    { ...activeFence, kind: "run.inspectionUnknown" },
    {
      ...activeFence,
      kind: "run.processExited",
      pid: index + 1,
      exitCode: 137,
    },
    { ...activeFence, kind: "run.absenceProven" },
    { ...activeFence, kind: "run.quarantineConfirmed" },
    { ...target, kind: "run.unclaimedCancelled" },
    { ...target, kind: "run.observedGone" },
    { ...target, kind: "run.successorAuthorized", successor: state.run + 1 },
    {
      ...target,
      ...freshInput,
      kind: "inbox.submitted",
      held: index % 3 === 0,
    },
    { ...headRef, kind: "inbox.released" },
    { ...headRef, kind: "inbox.cancelled" },
    { ...headRef, kind: "inbox.headRejected" },
    { ...headRef, kind: "inbox.abandoned", resend: freshInput },
    { ...headRef, kind: "delivery.permitted", attempt_id: `attempt-${index}` },
    { kind: "delivery.start", request: delivery, turn: liveTurn },
    { ...headRef, kind: "delivery.returned" },
    { kind: "delivery.settle", request: { ...delivery, outcome: "applied" } },
    { kind: "delivery.settle", request: { ...delivery, outcome: "rejected" } },
    { kind: "delivery.settle", request: { ...delivery, outcome: "duplicate" } },
    { kind: "delivery.settle", request: { ...delivery, outcome: "in_doubt" } },
    {
      kind: "delivery.settle",
      request: { ...delivery, outcome: "failed", retryable: index % 2 === 0 },
    },
    {
      kind: "delivery.settle",
      request: {
        ...delivery,
        outcome: "failed",
        retryable: true,
        resolution_evidence: "inspection",
      },
    },
    {
      kind: "delivery.settle",
      request: {
        ...delivery,
        outcome: "applied",
        resolution_evidence: "transcript",
      },
    },
    {
      ...headRef,
      kind: "delivery.reconciled",
      evidence: "receipt scan",
      applied: index % 2 === 0,
    },
    { ...target, kind: "person.interrupt", turn: currentTurn },
    {
      ...target,
      kind: "person.answer",
      turn: currentTurn,
      prompt_id,
      answer: true,
    },
    event(
      seq,
      null,
      {
        kind: "session.started",
        body: { machine: "laptop", provider: "agent" },
      },
      target,
    ),
    event(
      seq,
      null,
      { kind: "session.moved", body: { from_machine: "A", to_machine: "B" } },
      target,
    ),
    event(
      seq,
      null,
      { kind: "session.ended", body: { reason: "closed" } },
      target,
    ),
    event(
      seq,
      `turn-${index + 100}`,
      { kind: "turn.started", body: {} },
      target,
    ),
    event(
      seq,
      currentTurn,
      { kind: "turn.ended", body: { reason: "completed" } },
      target,
    ),
    event(
      seq,
      currentTurn,
      {
        kind: "prompt.opened",
        body: { prompt_id: `prompt-${index}`, kind: "permission" },
      },
      target,
    ),
    event(
      seq,
      currentTurn,
      {
        kind: "prompt.settled",
        body: { prompt_id, by: request.sender, answer: true },
      },
      target,
    ),
    event(
      seq,
      null,
      { kind: "receipt", body: { delivery_id: delivery.delivery_id } },
      target,
    ),
    event(seq, null, { kind: "context", body: { data: null } }, target),
  ];
}

test("seeded fact sequences are total, deterministic, replay-safe, and fenced", () => {
  const random = testFaker("session-contract:2026-11-25");
  const anchors = [
    empty,
    claimed,
    ready,
    running,
    blocked,
    pending,
    permitted,
    sending,
    ambiguous,
    applyFacts(running, ended),
    applyFacts(claimed, {
      ...fence,
      kind: "run.launchFailed",
      retryable: true,
    }),
    applyFacts(claimed, { ...fence, kind: "run.inspectionUnknown" }),
    applyFacts(ready, {
      ...fence,
      kind: "run.processExited",
      pid: 42,
      exitCode: 0,
    }),
    applyFacts(ready, { ...fence, kind: "run.quarantineConfirmed" }),
  ];
  for (let trial = 0; trial < 150; trial += 1) {
    let state = random.helpers.arrayElement(anchors);
    for (let step = 0; step < 20; step += 1) {
      const candidates = factsFor(state, trial * 20 + step);
      for (const fact of candidates) {
        const result = sessionMachine.apply(state, fact);
        expect(
          sessionMachine.apply(structuredClone(state), structuredClone(fact)),
        ).toEqual(result);
        expect(sessionMachine.apply(result.state, fact)).toEqual({
          state: result.state,
          effects: [],
        });
        if (result.effects.length) expect(result.state).not.toEqual(state);
        const next = result.state;
        expect(["active", "completed"]).toContain(next.status);
        expect([
          "requested",
          "starting",
          "ready",
          "start-failed-before-effect",
          "start-ambiguous",
          ...terminalRuns,
        ]).toContain(next.runStatus);
        expect(["none", "running", "blocked", "ended"]).toContain(
          next.turn.status,
        );
        if (state.run === next.run) {
          if (state.status === "completed")
            expect(next.status).toBe(state.status);
          if (terminalRuns.includes(state.runStatus))
            expect(next.runStatus).toBe(state.runStatus);
          if (state.turn.status === "ended" && state.turn.id === next.turn.id)
            expect(next.turn.status).toBe("ended");
        }
        for (const [index, row] of next.inbox.entries()) {
          expect([
            "held",
            "pending",
            "claimed",
            "delivery-started",
            "ambiguous",
            ...terminalDeliveries,
          ]).toContain(row.status);
          const previous = state.inbox[index];
          if (previous && terminalDeliveries.includes(previous.status))
            expect(row).toBe(previous);
        }
        const older = { run: state.run === 1 ? 2 : state.run - 1 };
        const stale =
          fact.kind === "provider.event"
            ? { ...fact, event: { ...fact.event, ...older } }
            : "request" in fact
              ? ({
                  ...fact,
                  request: { ...fact.request, ...older },
                } as SessionFact)
              : { ...fact, ...older };
        expect(sessionMachine.apply(state, stale)).toEqual({
          state,
          effects: [],
        });
      }
      const target = { session: state.session, run: state.run };
      for (const fact of [
        event(
          state.eventSeq + 1,
          "stale-turn",
          { kind: "turn.ended", body: { reason: "late" } },
          target,
        ),
        event(
          state.eventSeq + 1,
          "stale-turn",
          {
            kind: "prompt.opened",
            body: { prompt_id: "stale", kind: "permission" },
          },
          target,
        ),
        { ...target, kind: "person.interrupt", turn: "stale-turn" },
        {
          ...target,
          kind: "person.answer",
          turn: "stale-turn",
          prompt_id: "stale",
          answer: true,
        },
      ] satisfies SessionFact[]) {
        expect(sessionMachine.apply(state, fact)).toEqual({
          state,
          effects: [],
        });
      }
      state = applyFacts(state, random.helpers.arrayElement(candidates));
    }
  }
});

test("replays of earlier events and attempts stay inert after an intervening transition", () => {
  const next = applyFacts(
    blocked,
    ended,
    event(5, "turn-2", { kind: "turn.started", body: {} }),
  );
  expect(applyFacts(next, started, opened, ended)).toBe(next);
  const returned = applyFacts(permitted, {
    ...permit,
    kind: "delivery.returned",
  });
  const nextAttempt = applyFacts(returned, { ...permit, attempt_id: "retry" });
  expect(applyFacts(nextAttempt, start, doubt)).toBe(nextAttempt);
});
