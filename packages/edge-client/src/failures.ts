import { TaggedError } from "effect/Data";
import type { EdgeFailure, EdgeOperation } from "./types";

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
  Details<"claim_lost">
> {}

export type EdgeError =
  | EdgeUnavailable
  | EdgeRejected
  | EdgeParseError
  | EdgeVersionRejected
  | ClaimLost;

export function plainFailure(error: EdgeError, stack: string): EdgeFailure {
  const { operation } = error;
  switch (error._tag) {
    case "EdgeUnavailable":
      return {
        kind: "unavailable",
        operation,
        stack,
        code: error.code,
        retry_after_ms: error.retry_after_ms,
      };
    case "EdgeRejected":
      return { kind: "rejected", operation, stack, code: error.code };
    case "EdgeParseError":
      return {
        kind: "parse",
        operation,
        stack,
        code: error.code,
        path: error.path,
      };
    case "EdgeVersionRejected":
      return {
        kind: "version_rejected",
        operation,
        stack,
        reason: error.reason,
        supportedVersions: error.supportedVersions,
      };
    case "ClaimLost":
      return { kind: "claim_lost", operation, stack, reason: error.reason };
  }
}

export function interrupted(
  operation: EdgeOperation,
  kind: "aborted" | "closed",
): EdgeFailure {
  return { operation, kind, stack: `edgeClient.${operation}` };
}
