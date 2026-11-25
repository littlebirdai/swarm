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
) => Promise<{ status: number; body: unknown }>;

export interface EdgeClientOptions {
  transport: EdgeTransport;
  attemptTimeoutMs?: number;
  callTimeoutMs?: number;
}

export interface ClaimTiming {
  maxServerClockLeadMs: number;
}

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
};
export type EdgeResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: EdgeFailure };

export interface EdgeClient {
  hello(
    request: HelloRequest,
    signal?: AbortSignal,
  ): Promise<EdgeResult<Extract<HelloResponse, { status: "ok" }>>>;
  heartbeat(
    request: HeartbeatRequest,
    signal?: AbortSignal,
  ): Promise<EdgeResult<Exclude<HeartbeatResponse, EdgeErrorResponse>>>;
  claim(
    request: ClaimRequest,
    signal?: AbortSignal,
  ): Promise<
    EdgeResult<Exclude<ClaimResponse, EdgeErrorResponse | { status: "busy" }>>
  >;
  renew(
    request: RenewRequest,
    signal?: AbortSignal,
  ): Promise<EdgeResult<Extract<RenewResponse, { status: "renewed" }>>>;
  release(
    request: ReleaseRequest,
    signal?: AbortSignal,
  ): Promise<EdgeResult<Exclude<ReleaseResponse, EdgeErrorResponse>>>;
  withClaim<T>(
    request: ClaimRequest,
    timing: ClaimTiming,
    work: (grant: ClaimGrant, signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<EdgeResult<T>>;
  close(): Promise<void>;
}
