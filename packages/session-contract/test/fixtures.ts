import type {
  CanonicalEvent,
  DeliveryStartRequest,
} from "@codecast/edge-contract";
import {
  sessionMachine,
  type SessionFact,
  type SessionState,
} from "@codecast/session-contract";

type EventKind = CanonicalEvent["kind"];
type EventBody = {
  [Kind in EventKind]: Pick<
    Extract<CanonicalEvent, { kind: Kind }>,
    "kind" | "body"
  >;
}[EventKind];

export const scope = { session: "session", run: 1 };
export const fence = { ...scope, fencing_token: "first-token" };
export const empty = sessionMachine.initial(scope);
export const claimed = applyFacts(empty, {
  ...fence,
  kind: "run.claimed",
  expires_at: 10,
});
export const ready = applyFacts(claimed, {
  ...fence,
  kind: "run.runtimeReady",
});

export function event(
  seq: number,
  turn: string | null,
  content: EventBody,
  target = scope,
): SessionFact {
  return {
    kind: "provider.event",
    event: {
      ...target,
      ...content,
      v: 1,
      at: seq,
      seq,
      turn,
      source: "provider",
    },
  };
}

export const started = event(1, "turn-1", { kind: "turn.started", body: {} });
export const opened = event(2, "turn-1", {
  kind: "prompt.opened",
  body: { prompt_id: "approval", kind: "permission" },
});
export const ended = event(4, "turn-1", {
  kind: "turn.ended",
  body: { reason: "completed" },
});
export const running = applyFacts(ready, started);
export const blocked = applyFacts(running, opened);

export const request: DeliveryStartRequest = {
  ...fence,
  v: 1,
  delivery_id: "delivery",
  attempt_id: "attempt",
  seq: 1,
  intent: "steer",
  sender: { kind: "person", id: "sender" },
};

export const submit = { ...request, kind: "inbox.submitted" } as const;
export const permit = { ...request, kind: "delivery.permitted" } as const;
export const start = { kind: "delivery.start", request, turn: null } as const;
export const doubt = {
  kind: "delivery.settle",
  request: { ...request, outcome: "in_doubt" },
} as const;
export const pending = applyFacts(ready, submit);
export const permitted = applyFacts(pending, permit);
export const sending = applyFacts(permitted, start);
export const ambiguous = applyFacts(sending, doubt);

export function applyFacts(
  state: SessionState,
  ...facts: SessionFact[]
): SessionState {
  return facts.reduce(
    (current, fact) => sessionMachine.apply(current, fact).state,
    state,
  );
}
