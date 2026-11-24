import {
  boolean,
  count,
  nonEmptyString,
  oneOf,
  optional,
  owns,
  parser,
  responseObject,
  type Reader,
} from "./parse";
import { readV1 } from "./version";

export const EDGE_ERROR_CODES = {
  RATE_LIMITED: "rate_limited",
  TOO_LARGE: "too_large",
  UNAUTHORIZED: "unauthorized",
  UNAVAILABLE: "unavailable",
  INVALID: "invalid",
} as const;

const error = responseObject({
  v: readV1,
  status: oneOf("error"),
  code: nonEmptyString,
  retryable: boolean,
  retry_after_ms: optional(count),
});

export type EdgeErrorResponse = ReturnType<typeof error>;
export const parseEdgeErrorResponse = parser(error);

export function response<T>(read: Reader<T>): Reader<T | EdgeErrorResponse> {
  return (value, path) =>
    typeof value === "object" &&
    value !== null &&
    owns(value, "status") &&
    (value as { status: unknown }).status === "error"
      ? error(value, path)
      : read(value, path);
}
