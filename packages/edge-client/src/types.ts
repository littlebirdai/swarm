import type {
  ClaimRequest,
  ClaimResponse,
  DeliveryResolutionRequest,
  DeliverySettleRequest,
  DeliverySettleResponse,
  DeliveryStartRequest,
  DeliveryStartResponse,
  EdgeErrorResponse,
  EdgeParseErrorCode,
  HeartbeatRequest,
  HeartbeatResponse,
  HelloRequest,
  HelloResponse,
  PermitsNextRequest,
  PermitsNextResponse,
  TakeoverAckRequest,
  TakeoverAckResponse,
  TakeoverFence,
  RelayGrantRequest,
  ReleaseRequest,
  ReleaseResponse,
  RenewRequest,
  RenewResponse,
} from "@codecast/edge-contract";

export type EdgeRequests = {
  hello: HelloRequest;
  heartbeat: HeartbeatRequest;
  "relay-grant": RelayGrantRequest;
  claim: ClaimRequest;
  renew: RenewRequest;
  release: ReleaseRequest;
  "permits.next": PermitsNextRequest;
  "delivery.start": DeliveryStartRequest;
  "delivery.settle": DeliverySettleRequest | DeliveryResolutionRequest;
  "takeover.ack": TakeoverAckRequest;
};

export type EdgeOperation = keyof EdgeRequests;
export type EdgeTransport = <K extends EdgeOperation>(
  operation: K,
  request: EdgeRequests[K],
  signal: AbortSignal,
) => Promise<{
  status: number;
  body: unknown;
  retryAfterHeader?: string | null;
}>;

export class EdgeTransportError extends Error {
  constructor(cause: unknown) {
    super("Edge transport failed", { cause });
    this.name = "EdgeTransportError";
  }
}

export interface EdgeClientOptions {
  transport: EdgeTransport;
  attemptTimeoutMs?: number;
  callTimeoutMs?: number;
  steering?: EdgeSteeringHost;
}

export type EdgeSteerPermit = Extract<
  PermitsNextResponse,
  { status: "permit"; intent: "steer" }
>;

export type EdgeSteerHandover = DeliveryStartRequest & {
  expected: EdgeSteerPermit["expected"];
  baton_token: EdgeSteerPermit["baton_token"];
};

type RunIdentity = Pick<PermitsNextRequest, "session" | "run">;

export type EdgeSteerJournal = {
  readonly fences: readonly (TakeoverFence & {
    readonly acknowledged?: true;
  })[];
  readonly handovers: readonly EdgeSteerHandover[];
};

export type EdgeSteerOutcome =
  | { outcome: "applied" }
  | { outcome: "failed"; retryable: boolean; detail?: string }
  | { outcome: "in_doubt"; detail?: string };

export type EdgeSteerRecovery =
  | { outcome: "applied" | "failed"; resolution_evidence: string }
  | { outcome: "in_doubt"; detail?: string };

export interface EdgeSteeringHost {
  runningTurn(run: PermitsNextRequest): string | null;
  prepare(
    permit: EdgeSteerPermit,
    signal: AbortSignal,
  ): Promise<(signal: AbortSignal) => Promise<EdgeSteerOutcome>>;
  recover(
    handover: EdgeSteerHandover,
    signal: AbortSignal,
  ): Promise<EdgeSteerRecovery>;
  journal: {
    load(
      run: RunIdentity,
      signal: AbortSignal,
    ): Promise<EdgeSteerJournal | undefined>;
    save(
      run: RunIdentity,
      state: EdgeSteerJournal,
      signal: AbortSignal,
    ): Promise<void>;
  };
}

export type EdgeDeliveryStep =
  | Extract<
      PermitsNextResponse,
      { status: "empty" | "stale" } | { status: "permit"; intent: "queue" }
    >
  | Extract<DeliveryStartResponse, { status: "rejected" }>
  | {
      status: "settled";
      outcome: DeliverySettleRequest["outcome"];
      receipt: Exclude<DeliverySettleResponse, EdgeErrorResponse>;
    }
  | { status: "pending" | "fenced" }
  | {
      status: "takeover";
      receipt: Exclude<TakeoverAckResponse, EdgeErrorResponse>;
    };

export type ClaimResult = Exclude<
  ClaimResponse,
  EdgeErrorResponse | { status: "busy" }
>;
export type Renewed = Extract<RenewResponse, { status: "renewed" }>;
export type ClaimGrant = Extract<ClaimResponse, { status: "granted" }>;
export type ClaimLoss = "stale" | "expired" | "unconfirmed" | "already_held";

type FailureDetails =
  | { kind: "unavailable"; code: string; retry_after_ms?: number }
  | { kind: "rejected"; code: string }
  | { kind: "parse"; code: EdgeParseErrorCode; path: string }
  | {
      kind: "version_rejected";
      reason: "upgrade_required" | "server_behind" | "unexpected_version";
      supportedVersions: readonly number[];
    }
  | { kind: "claim_lost"; reason: ClaimLoss }
  | { kind: "aborted" | "closed" };

export type EdgeFailure = FailureDetails & {
  operation: EdgeOperation;
  stack: string;
  cause?: unknown;
};
export type EdgeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: EdgeFailure };

type Call<Request, Value> = (
  request: Request,
  signal?: AbortSignal,
) => Promise<EdgeResult<Value>>;

export interface EdgeClient {
  hello: Call<HelloRequest, Extract<HelloResponse, { status: "ok" }>>;
  heartbeat: Call<
    HeartbeatRequest,
    Exclude<HeartbeatResponse, EdgeErrorResponse>
  >;
  claim: Call<ClaimRequest, ClaimResult>;
  renew: Call<RenewRequest, Renewed>;
  release: Call<ReleaseRequest, Exclude<ReleaseResponse, EdgeErrorResponse>>;
  deliverNext: Call<PermitsNextRequest, EdgeDeliveryStep>;
  withClaim<T>(
    request: ClaimRequest,
    work: (grant: ClaimGrant, signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<EdgeResult<T>>;
  close(): Promise<void>;
}
