export type SessionStatus = "active" | "completed";
export type RunStatus =
  | "requested"
  | "starting"
  | "ready"
  | "start-failed-before-effect"
  | "start-ambiguous"
  | "stopped"
  | "quarantined";
export type TurnStatus = "none" | "running" | "blocked" | "ended";
export type DeliveryStatus =
  | "held"
  | "pending"
  | "claimed"
  | "delivery-started"
  | "ambiguous"
  | "delivered"
  | "correlated-delivered"
  | "rejected"
  | "failed"
  | "cancelled-by-supersession"
  | "abandoned-ambiguous";

type Edges<S extends string> = Partial<Record<S, S>>;
type Table<S extends string, K extends string = string> = Record<K, Edges<S>>;

export const sessionTransitions: Table<SessionStatus, "end" | "successor"> = {
  end: { active: "completed" },
  successor: { completed: "active" },
};

export const runTransitions = {
  claim: { requested: "starting", "start-failed-before-effect": "starting" },
  ready: { starting: "ready" },
  observed: { requested: "ready" },
  failure: { starting: "start-failed-before-effect" },
  uncertain: {
    starting: "start-ambiguous",
    "start-failed-before-effect": "start-ambiguous",
  },
  exit: {
    requested: "stopped",
    starting: "stopped",
    ready: "stopped",
    "start-failed-before-effect": "stopped",
    "start-ambiguous": "stopped",
  },
  quarantine: {
    starting: "quarantined",
    ready: "quarantined",
    "start-failed-before-effect": "quarantined",
    "start-ambiguous": "quarantined",
  },
  successor: { stopped: "requested", quarantined: "requested" },
} satisfies Table<RunStatus>;

export const turnTransitions = {
  start: { none: "running", ended: "running" },
  prompt: { running: "blocked", blocked: "blocked" },
  answer: { blocked: "running" },
  end: { running: "ended", blocked: "ended" },
} satisfies Table<TurnStatus>;

export const deliveryTransitions = {
  release: { held: "pending" },
  permit: { pending: "claimed" },
  start: { claimed: "delivery-started" },
  return: { claimed: "pending" },
  retry: { "delivery-started": "pending", ambiguous: "pending" },
  fail: { "delivery-started": "failed", ambiguous: "failed" },
  doubt: { "delivery-started": "ambiguous" },
  applied: { "delivery-started": "delivered" },
  receipt: {
    "delivery-started": "delivered",
    ambiguous: "correlated-delivered",
  },
  reject: {
    pending: "rejected",
    claimed: "rejected",
    "delivery-started": "rejected",
  },
  cancel: {
    held: "cancelled-by-supersession",
    pending: "cancelled-by-supersession",
    claimed: "cancelled-by-supersession",
  },
  abandon: { ambiguous: "abandoned-ambiguous" },
  successor: { claimed: "pending", "delivery-started": "ambiguous" },
} satisfies Table<DeliveryStatus>;

export const terminalDelivery: ReadonlySet<DeliveryStatus> = new Set([
  "delivered",
  "correlated-delivered",
  "rejected",
  "failed",
  "cancelled-by-supersession",
  "abandoned-ambiguous",
]);

export function nextStatus<S extends string>(
  status: S,
  edges: Edges<NoInfer<S>>,
): S | undefined {
  return edges[status];
}
