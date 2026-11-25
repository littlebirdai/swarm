import type { AttemptId, InboxFact, Input, Scope, TurnId } from "./facts";
import {
  deliveryTransitions,
  nextStatus,
  terminalDelivery,
  type DeliveryStatus,
} from "./transitions";

type Attempt = {
  id: AttemptId;
  run: Scope["run"];
  token: string;
  turn: TurnId | null;
};

export type Delivery = Input & {
  readonly status: DeliveryStatus;
  readonly heldFor: TurnId | null;
  readonly attemptNumber: number;
  readonly attempts: readonly Attempt[];
};

export type Inbox = readonly Delivery[];

const HISTORY_LIMIT = 32;

export type InboxState = {
  readonly inbox: Inbox;
  readonly lastInboxSeq: number;
  readonly recentDeliveryIds: readonly Input["delivery_id"][];
};

export function retainRecent<T>(
  previous: readonly T[],
  value: T,
): readonly T[] {
  return [...previous.slice(1 - HISTORY_LIMIT), value];
}

export function compactInbox(state: InboxState): InboxState {
  const terminal = state.inbox.filter(({ status }) =>
    terminalDelivery.has(status),
  );
  if (terminal.length <= HISTORY_LIMIT) return state;
  const removed = new Set(terminal.slice(0, terminal.length - HISTORY_LIMIT));
  return {
    inbox: state.inbox.filter((entry) => !removed.has(entry)),
    lastInboxSeq: state.lastInboxSeq,
    recentDeliveryIds: [
      ...state.recentDeliveryIds,
      ...Array.from(removed, ({ delivery_id }) => delivery_id),
    ].slice(-HISTORY_LIMIT),
  };
}

function insertDelivery(
  state: InboxState,
  input: Input,
  held: boolean,
  heldFor: TurnId | null,
): InboxState {
  if (
    !Number.isSafeInteger(input.seq) ||
    state.lastInboxSeq >= input.seq ||
    state.recentDeliveryIds.includes(input.delivery_id) ||
    state.inbox.some((message) => message.delivery_id === input.delivery_id)
  )
    return state;
  return {
    ...state,
    lastInboxSeq: input.seq,
    inbox: [
      ...state.inbox,
      {
        delivery_id: input.delivery_id,
        seq: input.seq,
        intent: input.intent,
        expectedTurn: input.expectedTurn,
        status: held ? "held" : "pending",
        heldFor,
        attempts: [],
        attemptNumber: 0,
      },
    ],
  };
}

export function advanceDelivery(
  message: Delivery,
  action: keyof typeof deliveryTransitions,
): Delivery {
  const status = nextStatus(message.status, deliveryTransitions[action]);
  return status
    ? {
        ...message,
        status,
        heldFor: action === "release" ? null : message.heldFor,
      }
    : message;
}

export function deliveryReceipt(inbox: Inbox, id: Input["delivery_id"]): Inbox {
  const message = inbox.find((entry) => entry.delivery_id === id);
  if (!message) return inbox;
  const next = advanceDelivery(message, "receipt");
  return next === message
    ? inbox
    : inbox.map((entry) => (entry === message ? next : entry));
}

type InboxContext = Scope & {
  readonly active: boolean;
  readonly terminal: boolean;
  readonly takeoverRaised: boolean;
  readonly accepting: boolean;
  readonly token: string | null;
  readonly turn: TurnId | null;
  readonly running: boolean;
};

function deliveryAction(
  message: Delivery,
  fact: Exclude<InboxFact, { kind: "inbox.submitted" }>,
  context: InboxContext,
  isHead: boolean,
): keyof typeof deliveryTransitions | undefined {
  switch (fact.kind) {
    case "inbox.released":
      return "release";
    case "inbox.cancelled":
      return "cancel";
    case "inbox.headRejected":
      return isHead && message.status === "pending" ? "reject" : undefined;
    case "inbox.abandoned":
      return "abandon";
    case "delivery.permitted":
      return isHead &&
        context.accepting &&
        fact.fencing_token === context.token &&
        (message.intent === "steer"
          ? message.expectedTurn === context.turn &&
            (context.turn === null || context.running)
          : context.turn === null) &&
        Number.isSafeInteger(fact.attemptNumber) &&
        fact.attemptNumber > message.attemptNumber &&
        !message.attempts.some(({ id }) => id === fact.attempt_id)
        ? "permit"
        : undefined;
    case "delivery.reconciled":
      return fact.fencing_token === context.token &&
        context.accepting &&
        message.status === "ambiguous" &&
        message.attempts[message.attempts.length - 1]?.id === fact.attempt_id &&
        fact.evidence.trim()
        ? fact.applied
          ? "receipt"
          : "retry"
        : undefined;
    case "delivery.start":
    case "delivery.settle":
    case "delivery.returned": {
      const request = fact.kind === "delivery.returned" ? fact : fact.request;
      const attempt = message.attempts[message.attempts.length - 1];
      if (
        request.session !== context.session ||
        request.run !== context.run ||
        request.fencing_token !== context.token ||
        attempt?.id !== request.attempt_id ||
        attempt.run !== context.run ||
        attempt.token !== context.token
      ) {
        return undefined;
      }
      if (
        "seq" in request &&
        (request.seq !== message.seq || request.intent !== message.intent)
      ) {
        return undefined;
      }
      if (fact.kind === "delivery.start") {
        return context.accepting &&
          !context.takeoverRaised &&
          fact.turn === context.turn &&
          fact.turn ===
            (message.intent === "steer"
              ? message.expectedTurn
              : attempt.turn) &&
          (context.turn === null ||
            (context.running && message.intent === "steer"))
          ? "start"
          : undefined;
      }
      if (fact.kind === "delivery.returned") return "return";
      const settlement = fact.request;
      if ("resolution_evidence" in settlement) {
        if (
          !settlement.resolution_evidence?.trim() ||
          (message.status !== "ambiguous" &&
            !(context.terminal && message.status === "delivery-started"))
        )
          return undefined;
        if (settlement.outcome === "applied") return "receipt";
        return settlement.outcome === "failed"
          ? settlement.retryable
            ? "retry"
            : "fail"
          : undefined;
      }
      if (
        context.terminal ||
        (message.status !== "claimed" && message.status !== "delivery-started")
      ) {
        return undefined;
      }
      switch (settlement.outcome) {
        case "applied":
        case "duplicate":
          return "applied";
        case "in_doubt":
          return "doubt";
        case "rejected":
        case "stale":
          return "reject";
        case "failed":
          return settlement.retryable ? "retry" : "fail";
      }
    }
  }
}

export function applyInbox(
  state: InboxState,
  fact: InboxFact,
  context: InboxContext,
): InboxState {
  const { inbox } = state;
  if (fact.kind === "inbox.submitted") {
    const heldFor = fact.intent === "queue" ? context.turn : null;
    return context.active
      ? insertDelivery(state, fact, !!fact.held || heldFor !== null, heldFor)
      : state;
  }
  const id = "request" in fact ? fact.request.delivery_id : fact.delivery_id;
  const message = inbox.find((entry) => entry.delivery_id === id);
  if (!message) return state;
  const inFlight = inbox.some(
    ({ status }) =>
      status === "claimed" ||
      status === "delivery-started" ||
      status === "ambiguous",
  );
  const isHead =
    !inFlight &&
    inbox.find(
      (entry) =>
        entry.status === "pending" &&
        (!context.running || entry.intent === "steer"),
    ) === message;
  const action = deliveryAction(message, fact, context, isHead);
  if (!action) return state;
  let next = advanceDelivery(message, action);
  if (next === message) return state;
  if (fact.kind === "delivery.permitted") {
    next = {
      ...next,
      attemptNumber: fact.attemptNumber,
      attempts: retainRecent(message.attempts, {
        id: fact.attempt_id,
        run: fact.run,
        token: fact.fencing_token,
        turn: context.turn,
      }),
    };
  }
  const updated = {
    ...state,
    inbox: inbox.map((entry) => (entry === message ? next : entry)),
  };
  if (fact.kind !== "inbox.abandoned" || !fact.resend) return updated;
  if (!context.active) return state;
  const heldFor = fact.resend.intent === "queue" ? context.turn : null;
  const resent = insertDelivery(
    updated,
    fact.resend,
    heldFor !== null,
    heldFor,
  );
  return resent === updated ? state : resent;
}
