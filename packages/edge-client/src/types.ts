import type {
  ClaimRequest,
  ClaimResponse,
  EdgeErrorResponse,
  EdgeParseErrorCode,
  HeartbeatRequest,
  HeartbeatResponse,
  HelloRequest,
  HelloResponse,
  ReleaseRequest,
  ReleaseResponse,
  RenewRequest,
  RenewResponse,
} from "@codecast/edge-contract";

export type EdgeRequests = {
  hello: HelloRequest;
  heartbeat: HeartbeatRequest;
  claim: ClaimRequest;
  renew: RenewRequest;
  release: ReleaseRequest;
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
}

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
  withClaim<T>(
    request: ClaimRequest,
    work: (grant: ClaimGrant, signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<EdgeResult<T>>;
  close(): Promise<void>;
}
