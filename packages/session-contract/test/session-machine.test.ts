import { expect, test } from "bun:test";
import {
  sessionMachine,
  type SessionFact,
  type SessionState,
} from "@codecast/session-contract";
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

const launchFailed = {
  ...fence,
  kind: "run.launchFailed",
  retryable: true,
} as const;
const unknown = { ...fence, kind: "run.inspectionUnknown" } as const;
const exited = {
  ...fence,
  kind: "run.processExited",
  pid: 42,
  exitCode: 137,
} as const;
const quarantined = { ...fence, kind: "run.quarantineConfirmed" } as const;
const successor = {
  ...scope,
  kind: "run.successorAuthorized",
  successor: 2,
} as const;
const failed = applyFacts(claimed, launchFailed);
const uncertain = applyFacts(claimed, unknown);

test.each([
  [
    "claim a requested run",
    empty,
    { ...fence, kind: "run.claimed", claimNumber: 1, expires_at: 10 },
    "starting",
  ],
  [
    "publish ready after launch",
    claimed,
    { ...fence, kind: "run.runtimeReady" },
    "ready",
  ],
  [
    "observe a pre-existing runtime",
    empty,
    event(1, null, {
      kind: "session.started",
      body: { machine: "laptop", provider: "agent" },
    }),
    "ready",
  ],
  [
    "fail a launch before effect",
    claimed,
    launchFailed,
    "start-failed-before-effect",
  ],
  [
    "retry a launch with a new fence",
    failed,
    {
      ...fence,
      kind: "run.claimed",
      claimNumber: 2,
      fencing_token: "second",
      expires_at: 20,
    },
    "starting",
  ],
  ["record an unverifiable launch", claimed, unknown, "start-ambiguous"],
  [
    "record uncertainty after a launch failure",
    failed,
    unknown,
    "start-ambiguous",
  ],
  [
    "withdraw an unclaimed run",
    empty,
    { ...scope, kind: "run.unclaimedCancelled" },
    "stopped",
  ],
  [
    "prove absence during launch",
    claimed,
    { ...fence, kind: "run.absenceProven" },
    "stopped",
  ],
  ["observe exit after ready", ready, exited, "stopped"],
  [
    "prove absence after launch failure",
    failed,
    { ...fence, kind: "run.absenceProven" },
    "stopped",
  ],
  [
    "prove absence after uncertainty",
    uncertain,
    { ...fence, kind: "run.absenceProven" },
    "stopped",
  ],
  ["quarantine an unresolved launch", claimed, quarantined, "quarantined"],
  ["quarantine a ready runtime", ready, quarantined, "quarantined"],
  ["quarantine after launch failure", failed, quarantined, "quarantined"],
  ["quarantine after uncertainty", uncertain, quarantined, "quarantined"],
  [
    "open a successor after exit",
    applyFacts(ready, exited),
    successor,
    "requested",
  ],
  [
    "open a successor after quarantine",
    applyFacts(ready, quarantined),
    successor,
    "requested",
  ],
] satisfies [string, SessionState, SessionFact, SessionState["runStatus"]][])(
  "%s",
  (_name, state, fact, expected) =>
    expect(applyFacts(state, fact).runStatus).toBe(expected),
);

test("lease expiry requests stop once and leaves successor blocked until proof of exit", () => {
  const renewed = applyFacts(ready, {
    ...fence,
    kind: "run.renewed",
    expires_at: 20,
  });
  const expired = {
    ...fence,
    kind: "run.leaseExpired",
    expires_at: 20,
  } as const;
  expect(applyFacts(renewed, { ...expired, expires_at: 10 })).toBe(renewed);
  expect(applyFacts(renewed, { ...expired, fencing_token: "wrong" })).toBe(
    renewed,
  );
  const result = sessionMachine.apply(renewed, expired);
  expect(result.state.runStatus).toBe("ready");
  expect(result.effects).toEqual([{ ...fence, kind: "run.stop" }]);
  expect(sessionMachine.apply(result.state, expired)).toEqual({
    state: result.state,
    effects: [],
  });
  expect(applyFacts(result.state, successor)).toBe(result.state);
  const next = applyFacts(result.state, exited, successor);
  expect([next.status, next.run, next.runStatus]).toEqual([
    "active",
    2,
    "requested",
  ]);
  expect(applyFacts(next, exited)).toBe(next);
});

test("refuse startup retries after failure without a retry grant or with a reused token", () => {
  const retry = {
    ...fence,
    kind: "run.claimed",
    claimNumber: 2,
    expires_at: 20,
  } as const;
  expect(applyFacts(failed, retry)).toBe(failed);
  const permanent = applyFacts(claimed, { ...launchFailed, retryable: false });
  expect(applyFacts(permanent, { ...retry, fencing_token: "second" })).toBe(
    permanent,
  );
  const retried = applyFacts(failed, { ...retry, fencing_token: "second" });
  expect(applyFacts(retried, launchFailed)).toBe(retried);
  expect(applyFacts(uncertain, successor, retry)).toBe(uncertain);
});

test("an observed session can close without a run lease when inspection proves absence", () => {
  const observed = applyFacts(
    empty,
    event(1, null, {
      kind: "session.started",
      body: { machine: "laptop", provider: "agent" },
    }),
  );
  const gone = { ...scope, kind: "run.observedGone" } as const;
  const closed = applyFacts(observed, gone);
  expect([closed.status, closed.runStatus]).toEqual(["completed", "stopped"]);
  expect(applyFacts(ready, gone)).toBe(ready);
});

test("a provider session end closes its turn but does not prove runtime disposal", () => {
  const result = sessionMachine.apply(
    running,
    event(2, "turn-1", {
      kind: "session.ended",
      body: { reason: "provider disconnected" },
    }),
  );
  expect(result.effects).toEqual([
    {
      ...scope,
      kind: "turn.ended",
      turn: "turn-1",
      reason: "provider disconnected",
    },
  ]);
  expect([
    result.state.status,
    result.state.turn.status,
    result.state.runStatus,
  ]).toEqual(["completed", "ended", "ready"]);
  expect(applyFacts(result.state, successor, submit)).toBe(result.state);
});

test("turns start, wait for a named prompt, resume, and end with the provider reason", () => {
  expect(running.turn.status).toBe("running");
  expect(blocked.turn.status).toBe("blocked");
  const settled = event(3, "turn-1", {
    kind: "prompt.settled",
    body: { prompt_id: "approval", by: request.sender, answer: true },
  });
  const resumed = applyFacts(blocked, settled);
  expect([resumed.turn.status, resumed.turn.prompt]).toEqual(["running", null]);
  const result = sessionMachine.apply(resumed, ended);
  expect(result.effects).toEqual([
    { ...scope, kind: "turn.ended", turn: "turn-1", reason: "completed" },
  ]);
  expect([result.state.turn.status, result.state.turn.reason]).toEqual([
    "ended",
    "completed",
  ]);
  expect(applyFacts(blocked, ended).turn.status).toBe("ended");
  expect(applyFacts(result.state, started)).toBe(result.state);
  const next = applyFacts(
    result.state,
    event(5, "turn-2", { kind: "turn.started", body: {} }),
  );
  expect([next.turn.status, next.turn.id]).toEqual(["running", "turn-2"]);
  expect(
    applyFacts(
      next,
      event(6, "turn-1", { kind: "turn.ended", body: { reason: "late" } }),
    ),
  ).toBe(next);
});

test("interrupt and answer effects carry the run fence, turn, and prompt the person saw", () => {
  const answer = {
    ...scope,
    kind: "person.answer",
    turn: "turn-1",
    prompt_id: "approval",
    answer: true,
  } as const;
  const interrupt = {
    ...scope,
    kind: "person.interrupt",
    turn: "turn-1",
  } as const;
  expect(
    applyFacts(
      blocked,
      { ...answer, prompt_id: "stale" },
      { ...interrupt, turn: "stale" },
    ),
  ).toBe(blocked);
  const result = sessionMachine.apply(blocked, answer);
  expect(result.state.turn.status).toBe("blocked");
  expect(result.effects).toEqual([
    { ...answer, ...fence, kind: "prompt.answer" },
  ]);
  expect(sessionMachine.apply(result.state, answer).effects).toEqual([]);
  const stopping = sessionMachine.apply(result.state, interrupt);
  expect(stopping.state.turn.status).toBe("blocked");
  expect(stopping.effects).toEqual([
    { ...interrupt, ...fence, kind: "turn.interrupt" },
  ]);
  expect(sessionMachine.apply(stopping.state, interrupt).effects).toEqual([]);
});

test("queue waits through an open prompt and releases only for the named turn", () => {
  const held = applyFacts(blocked, { ...submit, intent: "queue" });
  expect(held.inbox[0]?.status).toBe("held");
  expect(applyFacts(held, permit)).toBe(held);
  expect(
    applyFacts(
      held,
      event(3, "other", { kind: "turn.ended", body: { reason: "late" } }),
    ),
  ).toBe(held);
  expect(applyFacts(held, ended).inbox[0]?.status).toBe("pending");
  const deferred = applyFacts(ready, { ...submit, held: true });
  expect(
    applyFacts(deferred, {
      ...scope,
      kind: "inbox.released",
      delivery_id: request.delivery_id,
    }).inbox[0]?.status,
  ).toBe("pending");
});

test("inbox enforces order and persists start before it emits the delivery effect", () => {
  const second = { ...submit, delivery_id: "second", seq: 2 };
  const queued = applyFacts(pending, second);
  expect(applyFacts(queued, { ...permit, delivery_id: "second" }, start)).toBe(
    queued,
  );
  const result = sessionMachine.apply(applyFacts(queued, permit), start);
  expect(result.state.inbox.map((message) => message.status)).toEqual([
    "delivery-started",
    "pending",
  ]);
  expect(result.effects).toEqual([
    { kind: "delivery.apply", request, turn: null },
  ]);
  expect(sessionMachine.apply(result.state, start).effects).toEqual([]);
  expect(applyFacts(result.state, { ...permit, delivery_id: "second" })).toBe(
    result.state,
  );
});

test("start refuses a permit from another turn, attempt, fence, or queue position", () => {
  const nowRunning = applyFacts(permitted, started);
  const steer = { ...start, turn: "turn-1" };
  expect(applyFacts(nowRunning, start, steer)).toBe(nowRunning);
  const permittedForTurn = applyFacts(
    running,
    { ...submit, expectedTurn: "turn-1" },
    permit,
  );
  expect(applyFacts(permittedForTurn, steer).inbox[0]?.status).toBe(
    "delivery-started",
  );
  for (const wrong of [
    { ...request, seq: 2 },
    { ...request, intent: "queue" as const },
    { ...request, attempt_id: "different" },
    { ...request, fencing_token: "different" },
  ]) {
    expect(applyFacts(permittedForTurn, { ...steer, request: wrong })).toBe(
      permittedForTurn,
    );
  }
});

test.each([
  [
    "return an unstarted permit",
    permitted,
    { ...permit, kind: "delivery.returned" },
    "pending",
  ],
  [
    "reject an ineligible head",
    pending,
    { ...submit, kind: "inbox.headRejected" },
    "rejected",
  ],
  [
    "record a rejected claim",
    permitted,
    { kind: "delivery.settle", request: { ...request, outcome: "rejected" } },
    "rejected",
  ],
  [
    "record applied input",
    sending,
    { kind: "delivery.settle", request: { ...request, outcome: "applied" } },
    "delivered",
  ],
  [
    "record duplicate input as delivered",
    sending,
    { kind: "delivery.settle", request: { ...request, outcome: "duplicate" } },
    "delivered",
  ],
  [
    "acknowledge a started attempt by receipt",
    sending,
    event(1, null, {
      kind: "receipt",
      body: { delivery_id: request.delivery_id },
    }),
    "delivered",
  ],
  ["hold uncertain input", sending, doubt, "ambiguous"],
  [
    "retry an attempt proven to have had no effect",
    sending,
    {
      kind: "delivery.settle",
      request: { ...request, outcome: "failed", retryable: true },
    },
    "pending",
  ],
  [
    "end retries on permanent failure",
    sending,
    {
      kind: "delivery.settle",
      request: { ...request, outcome: "failed", retryable: false },
    },
    "failed",
  ],
  [
    "correlate uncertain input by receipt",
    ambiguous,
    event(1, null, {
      kind: "receipt",
      body: { delivery_id: request.delivery_id },
    }),
    "correlated-delivered",
  ],
  [
    "correlate uncertain input by settlement",
    ambiguous,
    {
      kind: "delivery.settle",
      request: {
        ...request,
        outcome: "applied",
        resolution_evidence: "transcript",
      },
    },
    "correlated-delivered",
  ],
  [
    "retry uncertain input after proof of absence",
    ambiguous,
    {
      kind: "delivery.settle",
      request: {
        ...request,
        outcome: "failed",
        retryable: true,
        resolution_evidence: "inspection",
      },
    },
    "pending",
  ],
  [
    "end retry for uncertain input with proof of absence and permanent failure",
    ambiguous,
    {
      kind: "delivery.settle",
      request: {
        ...request,
        outcome: "failed",
        retryable: false,
        resolution_evidence: "inspection",
      },
    },
    "failed",
  ],
  [
    "cancel held input",
    applyFacts(ready, { ...submit, held: true }),
    { ...submit, kind: "inbox.cancelled" },
    "cancelled-by-supersession",
  ],
  [
    "cancel pending input",
    pending,
    { ...submit, kind: "inbox.cancelled" },
    "cancelled-by-supersession",
  ],
  [
    "cancel a claim before start",
    permitted,
    { ...submit, kind: "inbox.cancelled" },
    "cancelled-by-supersession",
  ],
  [
    "abandon uncertain input",
    ambiguous,
    { ...submit, kind: "inbox.abandoned" },
    "abandoned-ambiguous",
  ],
] satisfies [
  string,
  SessionState,
  SessionFact,
  SessionState["inbox"][number]["status"],
][])("%s", (_name, state, fact, expected) =>
  expect(applyFacts(state, fact).inbox[0]?.status).toBe(expected),
);

test("an unstarted permit can return without allowing a replay of the original attempt", () => {
  const waiting = applyFacts(permitted, {
    ...permit,
    kind: "delivery.returned",
  });
  expect(applyFacts(waiting, permit, start)).toBe(waiting);
  expect(
    applyFacts(waiting, { ...permit, attempt_id: "retry", attemptNumber: 2 })
      .inbox[0]?.status,
  ).toBe("claimed");
});

test("an ambiguous start requires evidence or a new delivery ID after explicit abandonment", () => {
  expect(
    applyFacts(
      ambiguous,
      start,
      { ...submit, kind: "inbox.cancelled" },
      {
        kind: "delivery.settle",
        request: { ...request, outcome: "applied" },
      },
    ),
  ).toBe(ambiguous);
  const abandon = {
    ...submit,
    kind: "inbox.abandoned",
    resend: { ...request, seq: 2, expectedTurn: null },
  } as const;
  expect(applyFacts(ambiguous, abandon)).toBe(ambiguous);
  const resent = applyFacts(ambiguous, {
    ...abandon,
    resend: { ...abandon.resend, delivery_id: "resend" },
  });
  expect(
    resent.inbox.map(({ delivery_id, status }) => [delivery_id, status]),
  ).toEqual([
    ["delivery", "abandoned-ambiguous"],
    ["resend", "pending"],
  ]);
});

test("successor returns an unstarted permit and holds an unaccounted start until reconciliation", () => {
  expect(applyFacts(permitted, exited, successor).inbox[0]?.status).toBe(
    "pending",
  );
  const waiting = applyFacts(sending, exited, successor);
  expect(waiting.inbox[0]?.status).toBe("ambiguous");
  expect(applyFacts(waiting, doubt)).toBe(waiting);
  const nextFence = { ...fence, run: 2, fencing_token: "next" };
  const online = applyFacts(
    waiting,
    { ...nextFence, kind: "run.claimed", claimNumber: 1, expires_at: 10 },
    { ...nextFence, kind: "run.runtimeReady" },
  );
  const reconciled = {
    ...request,
    ...nextFence,
    kind: "delivery.reconciled",
    evidence: "receipt scan",
    applied: false,
  } as const;
  expect(applyFacts(online, { ...reconciled, evidence: "" })).toBe(online);
  expect(
    applyFacts(online, { ...reconciled, applied: true }).inbox[0]?.status,
  ).toBe("correlated-delivered");
  expect(applyFacts(online, reconciled).inbox[0]?.status).toBe("pending");
});

test("who acts next follows the turn, inbox, run, and thread pin", () => {
  expect(sessionMachine.whoActsNext(empty)).toBe("idle");
  expect(sessionMachine.whoActsNext(claimed)).toBe("working");
  expect(sessionMachine.whoActsNext(running)).toBe("working");
  expect(sessionMachine.whoActsNext(blocked)).toBe("needs_input");
  expect(sessionMachine.whoActsNext(ambiguous)).toBe("needs_input");
  expect(sessionMachine.whoActsNext(ready, "blocked")).toBe("needs_input");
  expect(sessionMachine.whoActsNext(ready, "dormant")).toBe("dormant");
  expect(sessionMachine.whoActsNext(applyFacts(running, ended))).toBe(
    "needs_input",
  );
});

test("a fact from a different epoch cannot end the current turn", () => {
  expect(
    applyFacts(
      running,
      event(
        3,
        "turn-1",
        {
          kind: "turn.ended",
          body: { reason: "completed" },
        },
        { ...scope, run: scope.run + 1 },
      ),
    ),
  ).toBe(running);
});

test("older start sequence cannot create a turn after a later turn ends", () => {
  const finished = applyFacts(running, ended);
  const oldStart = event(3, "unknown-old-turn", {
    kind: "turn.started",
    body: {},
  });
  expect(applyFacts(finished, oldStart)).toBe(finished);
});

test("a receipt can settle an earlier turn after a later turn starts", () => {
  const working = applyFacts(
    sending,
    started,
    ended,
    event(5, "turn-2", {
      kind: "turn.started",
      body: {},
    }),
  );
  const receipt = event(6, "turn-1", {
    kind: "receipt",
    body: { delivery_id: request.delivery_id },
  });
  const delivered = applyFacts(working, receipt);
  expect(delivered.inbox[0]?.status).toBe("delivered");
  expect(delivered.turn.id).toBe("turn-2");
  expect(applyFacts(delivered, receipt)).toBe(delivered);
  expect(
    applyFacts(
      working,
      event(3, "turn-1", {
        kind: "receipt",
        body: { delivery_id: request.delivery_id },
      }),
    ),
  ).toBe(working);
});

test("an in-doubt settlement refuses blank resolution evidence", () => {
  expect(
    applyFacts(ambiguous, {
      kind: "delivery.settle",
      request: { ...request, outcome: "applied", resolution_evidence: " " },
    }),
  ).toBe(ambiguous);
});

test("an ended turn ID cannot start again after a later turn ends", () => {
  const current = applyFacts(
    running,
    ended,
    event(5, "turn-2", { kind: "turn.started", body: {} }),
    event(6, "turn-2", { kind: "turn.ended", body: { reason: "completed" } }),
  );
  expect(
    applyFacts(current, event(7, "turn-1", { kind: "turn.started", body: {} })),
  ).toBe(current);
});

test("a timeout or unrelated provider activity cannot retry or acknowledge started input", () => {
  const elapsed = applyFacts(sending, {
    ...fence,
    kind: "run.leaseExpired",
    expires_at: 10,
  });
  expect(elapsed.inbox[0]?.status).toBe("delivery-started");
  expect(
    applyFacts(
      elapsed,
      event(1, null, {
        kind: "message.assistant",
        body: { message_id: "unrelated", text: "working" },
      }),
    ),
  ).toBe(elapsed);
  expect(applyFacts(elapsed, { ...permit, kind: "delivery.returned" })).toBe(
    elapsed,
  );
});

test("the admission decision cannot reject a claim issued in the meantime", () => {
  expect(applyFacts(permitted, { ...submit, kind: "inbox.headRejected" })).toBe(
    permitted,
  );
});
