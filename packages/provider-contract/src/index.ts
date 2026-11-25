import type {
  CanonicalEvent,
  EdgeJson,
  MessageDelta,
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

export interface SessionScope {
  readonly session: CanonicalEvent["session"];
  readonly run: CanonicalEvent["run"];
  readonly afterSeq: number;
}

export type PaneInstance = number;

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
}

export interface RunFence {
  readonly run: SessionScope["run"];
  readonly fencing_token: string;
}

export interface SessionPosition extends RunFence {
  readonly turn: CanonicalEvent["turn"];
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
  readonly expected: RunFence & {
    readonly prompt_id: PromptSettlement["prompt_id"];
  };
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

export type ObservedPosition =
  | { readonly kind: "turn"; readonly turn: CanonicalEvent["turn"] }
  | {
      readonly kind: "prompt";
      readonly run: SessionScope["run"] | null;
      readonly prompt_id: PromptSettlement["prompt_id"] | null;
    }
  | { readonly kind: "terminal"; readonly pane_instance: PaneInstance | null };

export type Stale = {
  readonly status: "stale";
  readonly observed: ObservedPosition;
};

export type InDoubt = {
  readonly status: "in-doubt";
  readonly reason: "best-effort" | "unknown";
  readonly code: string;
  readonly message: string;
};

type ActionRefusal =
  | Stale
  | Unsupported
  | Refused
  | { readonly status: "closed" };

export type DeliveryOutcome =
  | { readonly status: "accepted"; readonly receipt: DeliveryReceipt }
  | { readonly status: "duplicate"; readonly receipt: DeliveryReceipt }
  | ActionRefusal
  | InDoubt;

export type ControlOutcome =
  | { readonly status: "applied" }
  | ActionRefusal
  | InDoubt;
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
  interrupt(request: InterruptRequest): Promise<ControlOutcome>;
  answer(request: AnswerRequest): Promise<ControlOutcome>;
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
