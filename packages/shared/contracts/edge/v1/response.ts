import { boolean, count, oneOf, optional, owns, parser, responseObject, type Reader } from "./parse";
import { readV1 } from "./version";

const error = responseObject({
  v: readV1,
  status: oneOf("error"),
  code: oneOf("rate_limited", "too_large", "unauthorized", "unavailable", "invalid"),
  retryable: boolean,
  retry_after_ms: optional(count),
});

export type EdgeErrorResponse = ReturnType<typeof error>;
export const parseEdgeErrorResponse = parser(error);

export function response<T>(read: Reader<T>): Reader<T | EdgeErrorResponse> {
  return (value, path) => (
    typeof value === "object" && value !== null && owns(value, "status") &&
    (value as { status: unknown }).status === "error"
      ? error(value, path)
      : read(value, path)
  );
}
