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
  readonly afterSeq: CanonicalEvent["seq"];
}

export interface ObserveSpec extends SessionScope {
  readonly transcript: string;
  readonly paste?: {
    readonly pane_instance: string;
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

export interface SessionPosition {
  readonly run: SessionScope["run"];
  readonly turn: CanonicalEvent["turn"];
  readonly fencing_token: string;
}

export interface SteerRequest {
  readonly expected: SessionPosition & { readonly pane_instance?: string };
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
  readonly expected: InterruptRequest["expected"] & {
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

export type Stale = {
  readonly status: "stale";
  readonly observed: {
    readonly run: SessionScope["run"];
    readonly turn: CanonicalEvent["turn"];
    readonly prompt_id?: PromptSettlement["prompt_id"];
    readonly pane_instance?: string;
  };
};

export type InDoubt = {
  readonly status: "in-doubt";
  readonly reason: "best-effort" | "unknown";
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

interface SessionOperations {
  readonly events: AsyncIterable<ProviderEvent>;
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
  readonly checkpoint: string;
  readonly recoveredReceipts: readonly DeliveryReceipt[];
}

export type OpenOutcome<S extends ObservedSession | OwnedSession> =
  | { readonly status: "opened"; readonly session: S }
  | Unsupported
  | Refused
  | { readonly status: "in-doubt"; readonly reason: "unknown" };

export interface ProviderAdapter {
  readonly provider: ProviderOffer;
  observe(spec: ObserveSpec): Promise<OpenOutcome<ObservedSession>>;
  start(spec: StartSpec): Promise<OpenOutcome<OwnedSession>>;
  resume(spec: ResumeSpec): Promise<OpenOutcome<OwnedSession>>;
}
