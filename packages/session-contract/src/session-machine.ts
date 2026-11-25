import type { CanonicalEvent } from "@codecast/edge-contract";
import type {
  Fence,
  InboxFact,
  PromptId,
  RunFact,
  Scope,
  SessionFact,
  TurnId,
} from "./facts";
import {
  advanceDelivery,
  applyInbox,
  deliveryReceipt,
  type Inbox,
} from "./inbox";
import {
  nextStatus,
  runTransitions,
  sessionTransitions,
  terminalDelivery,
  turnTransitions,
  type RunStatus,
  type SessionStatus,
  type TurnStatus,
} from "./transitions";

export type { SessionFact } from "./facts";

type Turn = {
  readonly status: TurnStatus;
  readonly id: TurnId | null;
  readonly prompt: PromptId | null;
  readonly reason: string | null;
  readonly interruptRequested: boolean;
  readonly answerRequested: boolean;
};

type Lease = Pick<Fence, "fencing_token"> & {
  readonly expires_at: number;
  readonly expired: boolean;
};

export type SessionState = Scope & {
  readonly status: SessionStatus;
  readonly runStatus: RunStatus;
  readonly turn: Turn;
  readonly turnIds: readonly TurnId[];
  readonly inbox: Inbox;
  readonly eventSeq: number;
  readonly lease: Lease | null;
  readonly previousTokens: readonly Lease["fencing_token"][];
  readonly launchRetryable: boolean;
};

type ControlFact = Extract<
  SessionFact,
  { kind: "person.interrupt" | "person.answer" }
>;
export type SessionEffect =
  | (Omit<StartDelivery, "kind"> & { kind: "delivery.apply" })
  | (Scope & { kind: "turn.ended"; turn: TurnId; reason: string })
  | (Scope & { kind: "run.stop"; fencing_token: Fence["fencing_token"] })
  | (Fence & { kind: "turn.interrupt"; turn: TurnId })
  | (Fence & {
      kind: "prompt.answer";
      turn: TurnId;
      prompt_id: PromptId;
      answer: Extract<ControlFact, { kind: "person.answer" }>["answer"];
    });

type StartDelivery = Extract<InboxFact, { kind: "delivery.start" }>;

type Result = {
  readonly state: SessionState;
  readonly effects: readonly SessionEffect[];
};

const noTurn: Turn = {
  status: "none",
  id: null,
  prompt: null,
  reason: null,
  interruptRequested: false,
  answerRequested: false,
};

function initial(scope: Scope): SessionState {
  return {
    session: scope.session,
    run: scope.run,
    status: "active",
    runStatus: "requested",
    turn: noTurn,
    turnIds: [],
    inbox: [],
    eventSeq: 0,
    lease: null,
    previousTokens: [],
    launchRetryable: false,
  };
}

function turnOpen(turn: Turn): boolean {
  return turn.status === "running" || turn.status === "blocked";
}

function endTurn(state: SessionState, reason: string): Result {
  const status = nextStatus(state.turn.status, turnTransitions.end);
  const id = state.turn.id;
  if (!status || id === null) return { state, effects: [] };
  const inbox = state.inbox.map((message) =>
    message.heldFor === id ? advanceDelivery(message, "release") : message,
  );
  return {
    state: { ...state, inbox, turn: { ...noTurn, status, id, reason } },
    effects: [
      {
        kind: "turn.ended",
        session: state.session,
        run: state.run,
        turn: id,
        reason,
      },
    ],
  };
}

function endSession(state: SessionState, reason: string): Result {
  const status = nextStatus(state.status, sessionTransitions.end);
  return status
    ? endTurn({ ...state, status }, reason)
    : { state, effects: [] };
}

function applyRun(state: SessionState, fact: RunFact): Result {
  const unchanged = { state, effects: [] };
  const lease = state.lease;
  if (fact.kind === "run.successorAuthorized") {
    const runStatus = nextStatus(state.runStatus, runTransitions.successor);
    const status = nextStatus(state.status, sessionTransitions.successor);
    if (
      !runStatus ||
      !status ||
      fact.successor !== state.run + 1 ||
      !Number.isSafeInteger(fact.successor)
    )
      return unchanged;
    return {
      state: {
        ...initial({ session: state.session, run: fact.successor }),
        status,
        runStatus,
        inbox: state.inbox.map((message) =>
          advanceDelivery(message, "successor"),
        ),
        eventSeq: state.eventSeq,
      },
      effects: [],
    };
  }
  if (fact.kind === "run.claimed") {
    const runStatus = nextStatus(state.runStatus, runTransitions.claim);
    if (
      !runStatus ||
      state.status !== "active" ||
      state.previousTokens.includes(fact.fencing_token) ||
      (state.runStatus === "start-failed-before-effect" &&
        !state.launchRetryable)
    )
      return unchanged;
    return {
      state: {
        ...state,
        runStatus,
        lease: {
          fencing_token: fact.fencing_token,
          expires_at: fact.expires_at,
          expired: false,
        },
        previousTokens: [...state.previousTokens, fact.fencing_token],
        launchRetryable: false,
      },
      effects: [],
    };
  }
  if (
    fact.kind === "run.unclaimedCancelled" ||
    fact.kind === "run.observedGone"
  ) {
    const runStatus = nextStatus(state.runStatus, runTransitions.exit);
    const expected =
      fact.kind === "run.unclaimedCancelled" ? "requested" : "ready";
    return !lease && state.runStatus === expected && runStatus
      ? endSession(
          { ...state, runStatus },
          fact.kind === "run.unclaimedCancelled" ? "cancelled" : "lost",
        )
      : unchanged;
  }
  if (!lease || fact.fencing_token !== lease.fencing_token) return unchanged;
  const terminal =
    state.runStatus === "stopped" || state.runStatus === "quarantined";
  if (terminal) return unchanged;
  switch (fact.kind) {
    case "run.renewed":
      return !lease.expired && fact.expires_at > lease.expires_at
        ? {
            state: {
              ...state,
              lease: { ...lease, expires_at: fact.expires_at },
            },
            effects: [],
          }
        : unchanged;
    case "run.leaseExpired":
      return !lease.expired && fact.expires_at === lease.expires_at
        ? {
            state: { ...state, lease: { ...lease, expired: true } },
            effects: [
              {
                kind: "run.stop",
                session: state.session,
                run: state.run,
                fencing_token: lease.fencing_token,
              },
            ],
          }
        : unchanged;
    case "run.runtimeReady":
    case "run.launchFailed":
    case "run.inspectionUnknown": {
      const action =
        fact.kind === "run.runtimeReady"
          ? "ready"
          : fact.kind === "run.launchFailed"
            ? "failure"
            : "uncertain";
      const runStatus = nextStatus<RunStatus>(
        state.runStatus,
        runTransitions[action],
      );
      if (
        !runStatus ||
        (action === "ready" && (lease.expired || state.status !== "active"))
      )
        return unchanged;
      return {
        state: {
          ...state,
          runStatus,
          launchRetryable: fact.kind === "run.launchFailed" && fact.retryable,
        },
        effects: [],
      };
    }
    case "run.processExited":
    case "run.absenceProven":
    case "run.quarantineConfirmed": {
      const action =
        fact.kind === "run.quarantineConfirmed" ? "quarantine" : "exit";
      const runStatus = nextStatus<RunStatus>(
        state.runStatus,
        runTransitions[action],
      );
      return runStatus
        ? endSession({ ...state, runStatus }, "lost")
        : unchanged;
    }
  }
}

function applyEvent(state: SessionState, event: CanonicalEvent): Result {
  const unchanged = { state, effects: [] };
  if (event.seq <= state.eventSeq) return unchanged;
  const { turn } = state;
  const stamped = { ...state, eventSeq: event.seq };
  if (event.kind === "receipt") {
    if (event.turn !== null && event.turn !== turn.id) return unchanged;
    const inbox = deliveryReceipt(state.inbox, event.body.delivery_id);
    return inbox === state.inbox
      ? unchanged
      : { state: { ...stamped, inbox }, effects: [] };
  }
  if (state.status !== "active") return unchanged;
  if (event.kind === "turn.started") {
    const status = nextStatus(turn.status, turnTransitions.start);
    if (
      state.runStatus !== "ready" ||
      state.lease?.expired ||
      !status ||
      event.turn === null ||
      state.turnIds.includes(event.turn)
    )
      return unchanged;
    return {
      state: {
        ...stamped,
        turn: { ...noTurn, status, id: event.turn },
        turnIds: [...state.turnIds, event.turn],
      },
      effects: [],
    };
  }
  if (event.turn !== null && event.turn !== turn.id) return unchanged;
  if (event.kind === "session.started") {
    const action = state.lease ? "ready" : "observed";
    const runStatus = nextStatus<RunStatus>(
      state.runStatus,
      runTransitions[action],
    );
    return runStatus && !state.lease?.expired
      ? { state: { ...stamped, runStatus }, effects: [] }
      : unchanged;
  }
  if (event.kind === "session.ended")
    return endSession(stamped, event.body.reason);
  if (event.turn === null) return unchanged;
  switch (event.kind) {
    case "turn.ended":
      return turnOpen(turn) ? endTurn(stamped, event.body.reason) : unchanged;
    case "prompt.opened": {
      const status = nextStatus(turn.status, turnTransitions.prompt);
      return status
        ? {
            state: {
              ...stamped,
              turn: { ...turn, status, prompt: event.body.prompt_id },
            },
            effects: [],
          }
        : unchanged;
    }
    case "prompt.settled": {
      const status = nextStatus(turn.status, turnTransitions.answer);
      return status && turn.prompt === event.body.prompt_id
        ? {
            state: {
              ...stamped,
              turn: { ...turn, status, prompt: null, answerRequested: false },
            },
            effects: [],
          }
        : unchanged;
    }
    default:
      return unchanged;
  }
}

function applyControl(state: SessionState, fact: ControlFact): Result {
  const unchanged = { state, effects: [] };
  const { turn, lease } = state;
  if (
    state.status !== "active" ||
    state.runStatus !== "ready" ||
    !lease ||
    lease.expired ||
    fact.turn !== turn.id ||
    !turnOpen(turn)
  )
    return unchanged;
  const fence = {
    session: state.session,
    run: state.run,
    fencing_token: lease.fencing_token,
  };
  if (fact.kind === "person.interrupt") {
    return turn.interruptRequested
      ? unchanged
      : {
          state: { ...state, turn: { ...turn, interruptRequested: true } },
          effects: [{ ...fence, kind: "turn.interrupt", turn: fact.turn }],
        };
  }
  return turn.prompt !== fact.prompt_id || turn.answerRequested
    ? unchanged
    : {
        state: { ...state, turn: { ...turn, answerRequested: true } },
        effects: [
          {
            ...fence,
            kind: "prompt.answer",
            turn: fact.turn,
            prompt_id: fact.prompt_id,
            answer: fact.answer,
          },
        ],
      };
}

function apply(state: SessionState, fact: SessionFact): Result {
  const scope =
    fact.kind === "provider.event"
      ? fact.event
      : "request" in fact
        ? fact.request
        : fact;
  if (scope.session !== state.session || scope.run !== state.run)
    return { state, effects: [] };
  switch (fact.kind) {
    case "provider.event":
      return applyEvent(state, fact.event);
    case "person.answer":
    case "person.interrupt":
      return applyControl(state, fact);
    case "run.claimed":
    case "run.renewed":
    case "run.leaseExpired":
    case "run.runtimeReady":
    case "run.launchFailed":
    case "run.inspectionUnknown":
    case "run.processExited":
    case "run.absenceProven":
    case "run.quarantineConfirmed":
    case "run.unclaimedCancelled":
    case "run.observedGone":
    case "run.successorAuthorized":
      return applyRun(state, fact);
    default: {
      const active = state.status === "active";
      const ready = state.runStatus === "ready";
      const token = state.lease?.fencing_token ?? null;
      const inbox = applyInbox(state.inbox, fact satisfies InboxFact, {
        session: state.session,
        run: state.run,
        active,
        ready,
        token,
        accepting: active && ready && token !== null && !state.lease?.expired,
        turn: turnOpen(state.turn) ? state.turn.id : null,
        running: state.turn.status === "running",
      });
      return {
        state: inbox === state.inbox ? state : { ...state, inbox },
        effects:
          inbox !== state.inbox && fact.kind === "delivery.start"
            ? [
                {
                  kind: "delivery.apply",
                  request: fact.request,
                  turn: fact.turn,
                },
              ]
            : [],
      };
    }
  }
}

type ThreadPin = "working" | "blocked" | "done" | "dormant" | null;
type WhoActsNext = "needs-input" | "working" | "dormant" | "done" | "idle";

function whoActsNext(state: SessionState, pin: ThreadPin = null): WhoActsNext {
  const head = state.inbox.find(
    (message) => !terminalDelivery.has(message.status),
  );
  if (
    state.turn.status === "blocked" ||
    head?.status === "ambiguous" ||
    pin === "blocked"
  )
    return "needs-input";
  if (state.turn.status === "running" || head?.status === "delivery-started")
    return "working";
  if (state.status === "completed") return "done";
  if (pin) return pin;
  if (
    state.runStatus === "start-ambiguous" ||
    state.runStatus === "start-failed-before-effect"
  )
    return "needs-input";
  if (
    state.runStatus === "starting" ||
    head?.status === "pending" ||
    head?.status === "claimed"
  )
    return "working";
  if (head?.status === "held") return "dormant";
  return state.turn.status === "ended" ? "done" : "idle";
}

export const sessionMachine = { initial, apply, whoActsNext };
