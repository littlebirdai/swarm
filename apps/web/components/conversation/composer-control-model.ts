export type TurnExpectation = { kind: "turn"; turn: string | null };

type Driver = { id: string; name: string };

export type SendState =
  | { kind: "submitting" | "saved" | "waiting-for-machine" | "with-agent" }
  | { kind: "waiting-for-driver"; driver: string }
  | { kind: "in-doubt" | "stale" | "refused" | "suggested" };

export type ComposerControlFacts = {
  viewerId: string;
  role: "viewer" | "suggester" | "sender" | "owner";
  driver: Driver | null;
  turn: string | null;
  takeoverPending: boolean;
  driveRequested: boolean;
  sendState: SendState | null;
};

export type ComposerPayload = {
  text: string;
  imageIds?: string[];
  quoteIds?: string[];
  typedWords?: string;
};

export type ComposerControlCommand =
  | ({ kind: "send"; expected: TurnExpectation } & ComposerPayload)
  | ({ kind: "queue" | "suggest" } & ComposerPayload)
  | { kind: "ask" | "cancel-takeover" }
  | { kind: "takeover"; driverId: string; expected: TurnExpectation }
  | { kind: "interrupt"; expected: TurnExpectation };

export type ComposerCommandOutcome =
  | "accepted"
  | "retained"
  | "stale"
  | "refused";

export type ComposerBaton = {
  run(command: ComposerControlCommand): Promise<ComposerCommandOutcome>;
};

export type SharedComposerControl = {
  facts: ComposerControlFacts;
  baton: ComposerBaton;
};

export type ComposerControlFlag =
  | { enabled: false }
  | {
      enabled: true;
      conversationId: string;
      shared: SharedComposerControl | null;
    };

export function selectComposerControl(
  control: ComposerControlFlag | undefined,
  conversationId: string,
) {
  return control?.enabled && control.conversationId === conversationId
    ? control.shared
    : null;
}

function sendStatus(state: SendState | null): string | null {
  switch (state?.kind) {
    case "submitting":
      return "Saving";
    case "saved":
      return "Saved";
    case "waiting-for-driver":
      return `Waiting for ${state.driver}`;
    case "waiting-for-machine":
      return "Waiting for the machine";
    case "with-agent":
      return "With the agent";
    case "in-doubt":
      return "Delivery in doubt";
    case "stale":
      return "Turn ended";
    case "refused":
      return "Send refused";
    case "suggested":
      return "Suggested";
    case undefined:
      return null;
  }
}

export function composerControlModel(facts: ComposerControlFacts) {
  const mine = facts.driver?.id === facts.viewerId;
  const otherDrives = !!facts.driver && !mine;
  const owner = facts.role === "owner";
  const canQueue = owner || facts.role === "sender";
  const retryWithQueue =
    facts.sendState?.kind === "stale" || facts.sendState?.kind === "refused";
  const takingOver = facts.takeoverPending && owner;
  return {
    driver: mine ? "You" : (facts.driver?.name ?? null),
    send: !canQueue
      ? facts.role === "suggester"
        ? "suggest"
        : null
      : retryWithQueue || facts.takeoverPending || otherDrives
        ? "queue"
        : "send",
    request: !canQueue ? (facts.driveRequested ? "requested" : "ask") : null,
    canQueue,
    interrupt: facts.turn !== null && (owner || (canQueue && mine)),
    takeover: takingOver ? "cancel" : owner && otherDrives ? "takeover" : null,
    takeoverStatus: facts.takeoverPending
      ? "Taking over · Waiting for the machine"
      : null,
    sendStatus: sendStatus(facts.sendState),
    submitting: facts.sendState?.kind === "submitting",
  } as const;
}
