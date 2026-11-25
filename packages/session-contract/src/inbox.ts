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
  readonly attempts: readonly Attempt[];
};

export type Inbox = readonly Delivery[];

export function insertDelivery(
  inbox: Inbox,
  input: Input,
  held: boolean,
  heldFor: TurnId | null,
): Inbox {
  if (
    (inbox[inbox.length - 1]?.seq ?? 0) >= input.seq ||
    inbox.some((message) => message.delivery_id === input.delivery_id)
  ) {
    return inbox;
  }
  return [
    ...inbox,
    {
      delivery_id: input.delivery_id,
      seq: input.seq,
      intent: input.intent,
      status: held ? "held" : "pending",
      heldFor,
      attempts: [],
    },
  ];
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
  readonly ready: boolean;
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
          ? context.turn === null || context.running
          : context.turn === null) &&
        !message.attempts.some(({ id }) => id === fact.attempt_id)
        ? "permit"
        : undefined;
    case "delivery.reconciled":
      return fact.fencing_token === context.token &&
        context.ready &&
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
          fact.turn === context.turn &&
          fact.turn === attempt.turn &&
          (context.turn === null ||
            (context.running && message.intent === "steer"))
          ? "start"
          : undefined;
      }
      if (fact.kind === "delivery.returned") return "return";
      const settlement = fact.request;
      if ("resolution_evidence" in settlement) {
        if (
          message.status !== "ambiguous" ||
          !settlement.resolution_evidence?.trim()
        )
          return undefined;
        if (settlement.outcome === "applied") return "receipt";
      } else if (message.status === "ambiguous") {
        return undefined;
      }
      switch (settlement.outcome) {
        case "applied":
        case "duplicate":
          return "applied";
        case "in_doubt":
          return "doubt";
        case "rejected":
          return "reject";
        case "failed":
          return settlement.retryable ? "retry" : "fail";
      }
    }
  }
}

export function applyInbox(
  inbox: Inbox,
  fact: InboxFact,
  context: InboxContext,
): Inbox {
  if (fact.kind === "inbox.submitted") {
    const heldFor = fact.intent === "queue" ? context.turn : null;
    return context.active
      ? insertDelivery(inbox, fact, !!fact.held || heldFor !== null, heldFor)
      : inbox;
  }
  const id = "request" in fact ? fact.request.delivery_id : fact.delivery_id;
  const message = inbox.find((entry) => entry.delivery_id === id);
  if (!message) return inbox;
  const isHead =
    inbox.find((entry) => !terminalDelivery.has(entry.status)) === message;
  const action = deliveryAction(message, fact, context, isHead);
  if (!action) return inbox;
  let next = advanceDelivery(message, action);
  if (next === message) return inbox;
  if (fact.kind === "delivery.permitted") {
    next = {
      ...next,
      attempts: [
        ...message.attempts,
        {
          id: fact.attempt_id,
          run: fact.run,
          token: fact.fencing_token,
          turn: context.turn,
        },
      ],
    };
  }
  const updated = inbox.map((entry) => (entry === message ? next : entry));
  if (fact.kind !== "inbox.abandoned" || !fact.resend) return updated;
  if (!context.active) return inbox;
  const resent = insertDelivery(
    updated,
    fact.resend,
    fact.resend.intent === "queue" && context.turn !== null,
    fact.resend.intent === "queue" ? context.turn : null,
  );
  return resent === updated ? inbox : resent;
}
