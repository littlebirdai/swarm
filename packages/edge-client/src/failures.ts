import { TaggedError } from "effect/Data";
import type { EdgeFailure } from "./types";

type Details<K extends EdgeFailure["kind"]> = Omit<
  Extract<EdgeFailure, { kind: K }>,
  "kind" | "stack"
>;

export class EdgeUnavailable extends TaggedError("EdgeUnavailable")<
  Details<"unavailable">
> {}
export class EdgeRejected extends TaggedError("EdgeRejected")<
  Details<"rejected">
> {}
export class EdgeParseError extends TaggedError("EdgeParseError")<
  Details<"parse">
> {}
export class EdgeVersionRejected extends TaggedError("EdgeVersionRejected")<
  Details<"version_rejected">
> {}
export class ClaimLost extends TaggedError("ClaimLost")<
  Details<"claim_lost"> & {
    cause?: EdgeUnavailable | EdgeRejected | EdgeParseError;
  }
> {}

export type RequestFailure = EdgeUnavailable | EdgeRejected | EdgeParseError;
export type EdgeError = RequestFailure | EdgeVersionRejected | ClaimLost;

export function plainFailure(error: EdgeError, stack: string): EdgeFailure {
  const common = { operation: error.operation, stack, cause: error.cause };
  switch (error._tag) {
    case "EdgeUnavailable":
      return {
        kind: "unavailable",
        ...common,
        code: error.code,
        retry_after_ms: error.retry_after_ms,
      };
    case "EdgeRejected":
      return { kind: "rejected", ...common, code: error.code };
    case "EdgeParseError":
      return {
        kind: "parse",
        ...common,
        code: error.code,
        path: error.path,
      };
    case "EdgeVersionRejected":
      return {
        kind: "version_rejected",
        ...common,
        reason: error.reason,
        supportedVersions: error.supportedVersions,
      };
    case "ClaimLost":
      return {
        kind: "claim_lost",
        ...common,
        reason: error.reason,
        cause: error.cause && plainFailure(error.cause, stack),
      };
  }
}
