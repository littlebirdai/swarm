import { expect, test } from "bun:test";
import { sessionMachine, type SessionFact } from "@codecast/session-contract";
import {
  ambiguous,
  applyFacts,
  claimed,
  empty,
  ended,
  event,
  fence,
  pending,
  permit,
  permitted,
  ready,
  request,
  running,
  scope,
  sending,
  start,
  submit,
} from "./fixtures";

const exited = {
  ...fence,
  kind: "run.processExited",
  pid: 42,
  exitCode: 1,
} as const;
const successor = {
  ...scope,
  kind: "run.successorAuthorized",
  successor: 2,
} as const;
const released = { ...permit, kind: "delivery.returned" } as const;

test("a held queue entry leaves room for the first steer without issuing a second permit", () => {
  const steer = {
    ...submit,
    expectedTurn: "turn-1",
    delivery_id: "steer",
    seq: 2,
  };
  const steerPermit = { ...permit, delivery_id: steer.delivery_id };
  const steerStart = {
    ...start,
    request: { ...request, delivery_id: steer.delivery_id, seq: 2 },
    turn: "turn-1",
  };
  const queued = applyFacts(running, { ...submit, intent: "queue" }, steer, {
    ...steer,
    delivery_id: "later",
    seq: 3,
  });
  const latePermit = { ...permit, delivery_id: "later", attempt_id: "late" };
  expect(applyFacts(queued, latePermit)).toBe(queued);
  const started = applyFacts(queued, steerPermit, steerStart);
  expect(started.inbox.map(({ status }) => status)).toEqual([
    "held",
    "delivery-started",
    "pending",
  ]);
  expect(
    applyFacts(started, latePermit, ended, latePermit).inbox.map(
      ({ status }) => status,
    ),
  ).toEqual(["pending", "delivery-started", "pending"]);
});

test("admission rejection cannot bypass an earlier eligible input", () => {
  const later = { ...submit, delivery_id: "later", seq: 2 };
  const queued = applyFacts(pending, later);
  expect(applyFacts(queued, { ...later, kind: "inbox.headRejected" })).toBe(
    queued,
  );
});

test("steer cannot get a permit for a turn different from the one the sender saw", () => {
  const queued = applyFacts(running, { ...submit, expectedTurn: "earlier" });
  expect(applyFacts(queued, permit)).toBe(queued);
  const submitted = applyFacts(
    running,
    { ...submit, expectedTurn: "turn-1" },
    permit,
  );
  const nextTurn = applyFacts(
    submitted,
    ended,
    event(5, "turn-2", { kind: "turn.started", body: {} }),
  );
  expect(applyFacts(nextTurn, { ...start, turn: "turn-2" })).toBe(nextTurn);
});

test("takeover blocks start until a newer clear fact arrives", () => {
  const raise = {
    ...scope,
    kind: "takeover.fence",
    raised: true,
    revision: 1,
  } as const;
  const clear = { ...raise, raised: false, revision: 2 } as const;
  const fenced = applyFacts(permitted, raise);
  expect(sessionMachine.apply(fenced, start)).toEqual({
    state: fenced,
    effects: [],
  });
  const cleared = applyFacts(fenced, clear);
  expect(applyFacts(cleared, raise)).toBe(cleared);
  expect(sessionMachine.apply(cleared, start).effects[0]?.kind).toBe(
    "delivery.apply",
  );
});

test.each([
  { outcome: "rejected" },
  { outcome: "stale", observed: { kind: "turn", turn: null } },
] as const)(
  "a started delivery settles as $outcome without automatic retry",
  (result) => {
    const settlement = {
      kind: "delivery.settle",
      request: { ...request, ...result },
    } as const;
    const settled = applyFacts(sending, settlement);
    expect(settled.inbox[0]?.status).toBe("rejected");
    expect(
      applyFacts(settled, { ...permit, attempt_id: "new", attemptNumber: 2 }),
    ).toBe(settled);
    const returned = applyFacts(permitted, released);
    expect(applyFacts(returned, settlement)).toBe(returned);
  },
);

test("expired leases refuse start and reconciliation, even when ready", () => {
  const expiry = {
    ...fence,
    kind: "run.leaseExpired",
    expires_at: 10,
  } as const;
  const expiredPermit = applyFacts(permitted, expiry);
  expect(applyFacts(expiredPermit, start)).toBe(expiredPermit);
  const expiredAttempt = applyFacts(ambiguous, expiry);
  const reconciled = {
    ...permit,
    kind: "delivery.reconciled",
    evidence: "receipt scan",
    applied: true,
  } as const;
  expect(applyFacts(expiredAttempt, reconciled)).toBe(expiredAttempt);
  expect(applyFacts(ambiguous, reconciled).inbox[0]?.status).toBe(
    "correlated-delivered",
  );
});

test("a successor must become ready before it reconciles an earlier attempt", () => {
  const newFence = { ...fence, run: 2, fencing_token: "new" };
  const starting = applyFacts(sending, exited, successor, {
    ...newFence,
    kind: "run.claimed",
    expires_at: 20,
    claimNumber: 1,
  });
  const reconcile = {
    ...permit,
    ...newFence,
    kind: "delivery.reconciled",
    evidence: "receipt scan",
    applied: true,
  } as const;
  expect(applyFacts(starting, reconcile)).toBe(starting);
  expect(
    applyFacts(starting, { ...newFence, kind: "run.runtimeReady" }, reconcile)
      .inbox[0]?.status,
  ).toBe("correlated-delivered");
});

test("a terminal run needs evidence to settle an outstanding attempt", () => {
  const stopped = applyFacts(sending, exited);
  const applied = {
    kind: "delivery.settle",
    request: { ...request, outcome: "applied" },
  } as const;
  expect(applyFacts(stopped, applied)).toBe(stopped);
  expect(
    applyFacts(stopped, {
      ...applied,
      request: {
        ...applied.request,
        outcome: "rejected",
        resolution_evidence: "invalid outcome",
      },
    }),
  ).toBe(stopped);
  expect(
    applyFacts(stopped, {
      ...applied,
      request: { ...applied.request, resolution_evidence: "tool receipt" },
    }).inbox[0]?.status,
  ).toBe("delivered");
  expect(applyFacts(stopped, successor, applied).inbox[0]?.status).toBe(
    "ambiguous",
  );
});

test("terminal history stays bounded and inbox sequence survives pruning and a new epoch", () => {
  let state = ready;
  for (let seq = 1; seq <= 100; seq += 1) {
    const send = { ...submit, delivery_id: `id-${seq}`, seq };
    state = applyFacts(state, send, { ...send, kind: "inbox.cancelled" });
  }
  expect(state.inbox).toHaveLength(32);
  expect(state.recentDeliveryIds).toHaveLength(32);
  expect(state.lastInboxSeq).toBe(100);
  expect(applyFacts(state, { ...submit, delivery_id: "id-67", seq: 101 })).toBe(
    state,
  );
  const next = applyFacts(state, exited, successor);
  expect(applyFacts(next, { ...submit, run: 2, delivery_id: "id-1" })).toBe(
    next,
  );
  expect(
    applyFacts(next, { ...submit, run: 2, seq: 101 }).inbox.at(-1)?.seq,
  ).toBe(101);
});

test("turn, run-token, and attempt history stay bounded without accepting old facts", () => {
  let turns = ready;
  let inbox = pending;
  let run = empty;
  const firstClaim = {
    ...fence,
    kind: "run.claimed",
    claimNumber: 1,
    expires_at: 10,
  } as const;
  for (let number = 1; number <= 40; number += 1) {
    const attempt = {
      ...permit,
      attempt_id: `attempt-${number}`,
      attemptNumber: number,
    };
    inbox = applyFacts(inbox, attempt, {
      ...attempt,
      kind: "delivery.returned",
    });
    const turn = `turn-${number}`;
    turns = applyFacts(
      turns,
      event(number * 2 - 1, turn, { kind: "turn.started", body: {} }),
      event(number * 2, turn, {
        kind: "turn.ended",
        body: { reason: "complete" },
      }),
    );
    const claim = {
      ...firstClaim,
      claimNumber: number,
      fencing_token: `token-${number}`,
    };
    run = applyFacts(run, claim, {
      ...claim,
      kind: "run.launchFailed",
      retryable: true,
    });
  }
  expect(turns.turnIds).toHaveLength(32);
  expect(inbox.inbox[0]?.attempts).toHaveLength(32);
  expect(run.previousTokens).toHaveLength(32);
  expect(
    applyFacts(turns, event(1, "turn-1", { kind: "turn.started", body: {} })),
  ).toBe(turns);
  expect(applyFacts(inbox, { ...permit, attempt_id: "attempt-1" })).toBe(inbox);
  expect(applyFacts(run, { ...firstClaim, fencing_token: "token-1" })).toBe(
    run,
  );
});

test("unknown input kinds and non-object requests leave state unchanged", () => {
  for (const input of [
    { ...scope, kind: "inbox.unrecognized", delivery_id: request.delivery_id },
    { kind: "delivery.start", request: null },
    { ...scope, kind: "delivery.start", delivery_id: request.delivery_id },
    { kind: "delivery.settle", request: 10 },
    null,
  ]) {
    expect(sessionMachine.apply(permitted, input as SessionFact)).toEqual({
      state: permitted,
      effects: [],
    });
  }
});

test("provider errors retain the reported reason until a new turn starts", () => {
  const error = { class: "auth", message: "log in", retryable: false };
  const reported = applyFacts(
    ready,
    event(1, null, { kind: "error", body: error }),
  );
  expect(reported.providerError).toEqual(error);
  expect(sessionMachine.whoActsNext(reported)).toBe("needs_input");
  expect(sessionMachine.whoActsNext(claimed)).toBe("working");
  expect(
    applyFacts(reported, event(2, "turn-1", { kind: "turn.started", body: {} }))
      .providerError,
  ).toBeNull();
});
