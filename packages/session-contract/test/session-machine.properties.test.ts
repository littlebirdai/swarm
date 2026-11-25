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
  const first = state.inbox.find(
    (message) => !terminalDeliveries.includes(message.status),
  );
  const head =
    state.inbox.find(({ status }) =>
      ["claimed", "delivery-started", "ambiguous"].includes(status),
    ) ??
    state.inbox.find(
      ({ status, intent }) =>
        status === "pending" &&
        (state.turn.status !== "running" || intent === "steer"),
    ) ??
    first;
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
    seq: state.lastInboxSeq + 1,
    expectedTurn:
      state.turn.status === "running" || state.turn.status === "blocked"
        ? state.turn.id
        : null,
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
      claimNumber: state.claimNumber + 1,
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
      kind: "takeover.fence",
      revision: index + 1,
      raised: index % 4 === 0,
    },
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
    {
      ...headRef,
      kind: "delivery.permitted",
      attemptNumber: (head?.attemptNumber ?? 0) + 1,
      attempt_id: `attempt-${index}`,
    },
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
  let changedSteps = 0;
  const trials = 150;
  const steps = 20;
  for (let trial = 0; trial < trials; trial += 1) {
    let state = random.helpers.arrayElement(anchors);
    const applied: SessionFact[] = [];
    const handed = new Map<string, Set<string>>();
    const delivered = new Set(
      state.inbox
        .filter(
          ({ status }) =>
            status === "delivered" || status === "correlated-delivered",
        )
        .map(({ delivery_id }) => delivery_id),
    );
    for (let step = 0; step < steps; step += 1) {
      const candidates = factsFor(state, trial * 20 + step);
      const changes: SessionFact[] = [];
      for (const fact of candidates) {
        const result = sessionMachine.apply(state, fact);
        expect(
          sessionMachine.apply(structuredClone(state), structuredClone(fact)),
        ).toEqual(result);
        expect(sessionMachine.apply(result.state, fact)).toEqual({
          state: result.state,
          effects: [],
        });
        if (result.state !== state) changes.push(fact);
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
        expect(
          next.inbox.filter(({ status }) =>
            ["claimed", "delivery-started", "ambiguous"].includes(status),
          ).length,
        ).toBeLessThanOrEqual(1);
        expect(next.lastInboxSeq).toBeGreaterThanOrEqual(state.lastInboxSeq);
        expect(next.inbox.map(({ seq }) => seq)).toEqual(
          [...new Set(next.inbox.map(({ seq }) => seq))].sort((a, b) => a - b),
        );
        for (const row of next.inbox) {
          expect([
            "held",
            "pending",
            "claimed",
            "delivery-started",
            "ambiguous",
            ...terminalDeliveries,
          ]).toContain(row.status);
          const previous = state.inbox.find(
            ({ delivery_id }) => delivery_id === row.delivery_id,
          );
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
      for (const old of applied)
        expect(sessionMachine.apply(state, old)).toEqual({
          state,
          effects: [],
        });
      const inFlight = state.inbox.find(({ status }) =>
        ["claimed", "delivery-started", "ambiguous"].includes(status),
      );
      const second = state.inbox.find(
        (row) => row !== inFlight && row.status === "pending",
      );
      const activeFence = {
        ...target,
        fencing_token: state.lease?.fencing_token ?? "missing",
      };
      if (inFlight) {
        for (const invalid of [
          {
            ...activeFence,
            delivery_id: inFlight.delivery_id,
            attempt_id: "stale-attempt",
            kind: "delivery.returned",
          },
          {
            ...activeFence,
            delivery_id: inFlight.delivery_id,
            attempt_id: inFlight.attempts.at(-1)?.id ?? "missing",
            fencing_token: "stale-token",
            kind: "delivery.returned",
          },
          ...(second
            ? [
                {
                  ...activeFence,
                  delivery_id: second.delivery_id,
                  attempt_id: "wrong-head",
                  kind: "delivery.permitted",
                  attemptNumber: second.attemptNumber + 1,
                } as const,
              ]
            : []),
        ] satisfies SessionFact[])
          expect(sessionMachine.apply(state, invalid).state).toBe(state);
      }
      const pool =
        changes.length && random.number.int({ max: 9 }) < 8
          ? changes
          : candidates;
      const choice = random.helpers.arrayElement(pool);
      const result = sessionMachine.apply(state, choice);
      for (const effect of result.effects) {
        if (effect.kind !== "delivery.apply") continue;
        const { delivery_id, attempt_id } = effect.request;
        expect(delivered.has(delivery_id)).toBe(false);
        const attempts = handed.get(delivery_id) ?? new Set<string>();
        expect(attempts.has(attempt_id)).toBe(false);
        attempts.add(attempt_id);
        handed.set(delivery_id, attempts);
      }
      for (const row of result.state.inbox) {
        if (row.status !== "delivered" && row.status !== "correlated-delivered")
          continue;
        const prior = state.inbox.find(
          ({ delivery_id }) => delivery_id === row.delivery_id,
        );
        if (prior === row) continue;
        expect(delivered.has(row.delivery_id)).toBe(false);
        delivered.add(row.delivery_id);
      }
      if (result.state !== state) {
        changedSteps += 1;
        applied.push(choice);
      }
      state = result.state;
    }
  }
  const percent = (100 * changedSteps) / (trials * steps);
  expect(percent).toBeGreaterThan(70);
  console.log(
    `Seeded reducer traces changed state on ${percent.toFixed(1)}% of steps`,
  );
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
  const nextAttempt = applyFacts(returned, {
    ...permit,
    attempt_id: "retry",
    attemptNumber: 2,
  });
  expect(applyFacts(nextAttempt, start, doubt)).toBe(nextAttempt);
});
