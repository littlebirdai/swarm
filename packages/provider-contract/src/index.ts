import type {
  CanonicalEvent,
  EdgeJson,
  Expected,
  MessageDelta,
  Observed,
  PaneInstance,
} from "@codecast/edge-contract";
import type { ProviderCapability, ProviderOffer } from "./capabilities";

export { negotiateCapabilities } from "./capabilities";
export type {
  ProviderCapability,
  ProviderIdentity,
  ProviderOffer,
} from "./capabilities";

export type ProviderEvent = CanonicalEvent | MessageDelta;
export type DeliveryReceipt = Readonly<
  Extract<CanonicalEvent, { kind: "receipt" }>["body"]
>;

export interface DeliveryReceiptRecord extends DeliveryReceipt {
  readonly provider_item_id: string;
  readonly turn: string;
}

export interface DeliveryReceiptJournal {
  read(
    session: SessionScope["session"],
    checkpoint: string,
    signal: AbortSignal,
  ): Promise<readonly DeliveryReceiptRecord[]>;
  find(
    session: SessionScope["session"],
    checkpoint: string,
    deliveryId: string,
    signal: AbortSignal,
  ): Promise<DeliveryReceiptRecord | undefined>;
  record(
    session: SessionScope["session"],
    checkpoint: string,
    receipt: DeliveryReceiptRecord,
    signal: AbortSignal,
  ): Promise<void>;
  forget(
    session: SessionScope["session"],
    checkpoint: string,
    deliveryId: string,
    signal: AbortSignal,
  ): Promise<void>;
}

export interface SessionScope {
  readonly session: CanonicalEvent["session"];
  readonly run: CanonicalEvent["run"];
  readonly afterSeq: number;
}

export type { PaneInstance } from "@codecast/edge-contract";

export interface ObserveSpec extends SessionScope {
  readonly transcript: string;
  readonly paste?: {
    readonly pane_instance: PaneInstance;
    readonly fencing_token: string;
  };
}

export interface StartSpec extends SessionScope {
  readonly cwd: string;
  readonly fencing_token: string;
  readonly options?: EdgeJson;
}

export interface ResumeSpec extends StartSpec {
  readonly checkpoint: string;
  readonly inDoubtDeliveryIds?: readonly DeliveryReceipt["delivery_id"][];
}

type ExpectedPrompt = Extract<Expected, { kind: "prompt" }>;
type ExpectedTerminal = Extract<Expected, { kind: "terminal" }>;

export type RunFence = Readonly<
  Pick<ExpectedPrompt, "run"> & Pick<ExpectedTerminal, "fencing_token">
>;

export interface SessionPosition extends RunFence {
  readonly turn: Extract<Expected, { kind: "turn" }>["turn"];
}

export interface SteerRequest {
  readonly expected: SessionPosition & {
    readonly pane_instance?: PaneInstance;
  };
  readonly delivery_id: DeliveryReceipt["delivery_id"];
  readonly authors: readonly Extract<
    CanonicalEvent,
    { kind: "message.user" }
  >["body"]["authors"][number][];
  readonly input: readonly (
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "local-image"; readonly path: string }
  )[];
}

export interface InterruptRequest {
  readonly expected: SessionPosition & { readonly turn: string };
}

type PromptSettlement = Extract<
  CanonicalEvent,
  { kind: "prompt.settled" }
>["body"];

export interface AnswerRequest {
  readonly expected: RunFence & Readonly<Pick<ExpectedPrompt, "prompt_id">>;
  readonly by: PromptSettlement["by"];
  readonly answer: PromptSettlement["answer"];
}

export type Unsupported = {
  readonly status: "unsupported";
  readonly requires: ProviderCapability | "owned-session" | "paste-target";
};

export type Refused = {
  readonly status: "refused";
  readonly code: string;
  readonly message: string;
};

export type ObservedPosition = Readonly<
  | Extract<Observed, { kind: "turn" | "prompt" }>
  | Omit<Extract<Observed, { kind: "terminal" }>, "fencing_token">
>;

export type Stale<
  Kind extends ObservedPosition["kind"] = ObservedPosition["kind"],
> = {
  readonly status: "stale";
  readonly observed: Extract<ObservedPosition, { kind: Kind }>;
};

export type InDoubt = {
  readonly status: "in-doubt";
  readonly reason: "best-effort" | "unknown";
  readonly code: string;
  readonly message: string;
};

type ActionRefusal = Unsupported | Refused | { readonly status: "closed" };

export type DeliveryOutcome =
  | { readonly status: "accepted"; readonly receipt: DeliveryReceipt }
  | { readonly status: "duplicate"; readonly receipt: DeliveryReceipt }
  | Stale<"turn" | "terminal">
  | ActionRefusal
  | InDoubt;

export type ControlOutcome<
  Kind extends "turn" | "prompt" = "turn" | "prompt",
> = { readonly status: "applied" } | Stale<Kind> | ActionRefusal | InDoubt;
export type CloseOutcome =
  | { readonly status: "closed" }
  | {
      readonly status: "failed";
      readonly code: string;
      readonly message: string;
    };

export interface ProviderEventIterator extends AsyncIterator<
  ProviderEvent,
  undefined,
  undefined
> {
  return(): Promise<IteratorResult<ProviderEvent, undefined>>;
}

interface SessionOperations {
  readonly events: {
    [Symbol.asyncIterator](): ProviderEventIterator;
  };
  steer(request: SteerRequest): Promise<DeliveryOutcome>;
  interrupt(request: InterruptRequest): Promise<ControlOutcome<"turn">>;
  answer(request: AnswerRequest): Promise<ControlOutcome<"prompt">>;
  close(): Promise<CloseOutcome>;
}

export interface ObservedSession extends SessionOperations {
  readonly mode: "observe";
}

export interface OwnedSession extends SessionOperations {
  readonly mode: "own";
  getCheckpoint(): string;
  readonly recoveredReceipts: readonly DeliveryReceipt[];
}

export type OpenOutcome<S extends ObservedSession | OwnedSession> =
  | { readonly status: "opened"; readonly session: S }
  | Unsupported
  | Refused
  | (InDoubt & { readonly reason: "unknown" });

export interface ProviderAdapter {
  readonly provider: ProviderOffer;
  observe(spec: ObserveSpec): Promise<OpenOutcome<ObservedSession>>;
  start(spec: StartSpec): Promise<OpenOutcome<OwnedSession>>;
  resume(spec: ResumeSpec): Promise<OpenOutcome<OwnedSession>>;
}
