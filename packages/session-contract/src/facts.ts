import type {
  CanonicalEvent,
  ClaimResponse,
  DeliveryResolutionRequest,
  DeliverySettleRequest,
  DeliveryStartRequest,
} from "@codecast/edge-contract";

export type Scope = Pick<CanonicalEvent, "session" | "run">;
export type Fence = Scope & Pick<DeliveryStartRequest, "fencing_token">;
export type AttemptId = DeliveryStartRequest["attempt_id"];
export type TurnId = NonNullable<CanonicalEvent["turn"]>;
export type PromptId = Extract<
  CanonicalEvent,
  { kind: "prompt.opened" }
>["body"]["prompt_id"];

export type Input = Pick<
  DeliveryStartRequest,
  "delivery_id" | "seq" | "intent"
> & { expectedTurn: TurnId | null };

export type RunFact =
  | ({ kind: "run.claimed"; claimNumber: number } & Fence &
      Pick<Extract<ClaimResponse, { status: "granted" }>, "expires_at">)
  | ({ kind: "run.renewed"; expires_at: number } & Fence)
  | ({ kind: "run.leaseExpired"; expires_at: number } & Fence)
  | ({ kind: "run.runtimeReady" } & Fence)
  | ({ kind: "run.launchFailed"; retryable: boolean } & Fence)
  | ({ kind: "run.inspectionUnknown" } & Fence)
  | ({ kind: "run.processExited"; pid: number; exitCode: number } & Fence)
  | ({ kind: "run.absenceProven" } & Fence)
  | ({ kind: "run.quarantineConfirmed" } & Fence)
  | ({ kind: "run.unclaimedCancelled" } & Scope)
  | ({ kind: "run.observedGone" } & Scope)
  | ({ kind: "run.successorAuthorized"; successor: Scope["run"] } & Scope);

type DeliveryRef = Scope & Pick<Input, "delivery_id">;
type AttemptRef = Fence &
  Pick<DeliveryStartRequest, "delivery_id" | "attempt_id">;

export type InboxFact =
  | ({ kind: "inbox.submitted"; held?: boolean } & Scope & Input)
  | ({ kind: "inbox.released" | "inbox.cancelled" } & DeliveryRef)
  | ({ kind: "inbox.headRejected" } & DeliveryRef)
  | ({ kind: "inbox.abandoned"; resend?: Input } & DeliveryRef)
  | ({ kind: "delivery.permitted"; attemptNumber: number } & AttemptRef)
  | {
      kind: "delivery.start";
      request: DeliveryStartRequest;
      turn: TurnId | null;
    }
  | ({ kind: "delivery.returned" } & AttemptRef)
  | {
      kind: "delivery.settle";
      request:
        | (DeliverySettleRequest &
            Partial<Pick<DeliveryResolutionRequest, "resolution_evidence">>)
        | (DeliveryStartRequest & { outcome: "stale" });
    }
  | ({
      kind: "delivery.reconciled";
      evidence: string;
      applied: boolean;
    } & AttemptRef);

export type SessionFact =
  | RunFact
  | InboxFact
  | { kind: "provider.event"; event: CanonicalEvent }
  | ({ kind: "takeover.fence"; raised: boolean; revision: number } & Scope)
  | ({ kind: "person.interrupt"; turn: TurnId } & Scope)
  | ({
      kind: "person.answer";
      turn: TurnId;
      prompt_id: PromptId;
      answer: Extract<
        CanonicalEvent,
        { kind: "prompt.settled" }
      >["body"]["answer"];
    } & Scope);
