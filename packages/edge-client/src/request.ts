import type {
  EdgeErrorResponse,
  EdgeParseResult,
} from "@codecast/edge-contract";
import { toMillis } from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { EdgeParseError, EdgeRejected, EdgeUnavailable } from "./failures";
import type { EdgeClientOptions, EdgeOperation, EdgeRequests } from "./types";

export function makeRequest({
  transport,
  attemptTimeoutMs = 2_000,
  callTimeoutMs = 10_000,
}: EdgeClientOptions) {
  for (const timeout of [attemptTimeoutMs, callTimeoutMs]) {
    if (!Number.isSafeInteger(timeout) || timeout <= 0) {
      throw new RangeError("Edge timeouts must be positive safe integers");
    }
  }

  const schedule = Schedule.modifyDelay(
    Schedule.exponential(100),
    ({ duration, input }) =>
      Effect.succeed(
        Math.max(
          toMillis(duration),
          input instanceof EdgeUnavailable ? (input.retry_after_ms ?? 0) : 0,
        ),
      ),
  );

  return Effect.fn("edgeClient.request")(function* <
    K extends EdgeOperation,
    T extends object,
  >(
    operation: K,
    request: EdgeRequests[K],
    parse: (body: unknown) => EdgeParseResult<T | EdgeErrorResponse>,
  ) {
    const timeout = () => new EdgeUnavailable({ operation, code: "timeout" });
    const attempt = Effect.gen(function* () {
      const { status, body } = yield* Effect.tryPromise({
        try: (signal) => transport(operation, request, signal),
        catch: () => new EdgeUnavailable({ operation, code: "network" }),
      });
      const parsed = parse(body);
      if (
        parsed.ok &&
        "status" in parsed.value &&
        parsed.value.status === "error"
      ) {
        const error = parsed.value as EdgeErrorResponse;
        const { code, retry_after_ms } = error;
        return yield* error.retryable
          ? new EdgeUnavailable({ operation, code, retry_after_ms })
          : new EdgeRejected({ operation, code });
      }
      if (status === 429 || status >= 500) {
        return yield* new EdgeUnavailable({
          operation,
          code: `http_${status}`,
        });
      }
      if (!parsed.ok) {
        if (status < 200 || status >= 300) {
          return yield* new EdgeRejected({ operation, code: `http_${status}` });
        }
        return yield* new EdgeParseError({
          operation,
          code: parsed.error.code,
          path: parsed.error.path,
        });
      }
      const value = parsed.value as T;
      if (
        "status" in value &&
        value.status === "busy" &&
        "retry_after_ms" in value &&
        typeof value.retry_after_ms === "number"
      ) {
        return yield* new EdgeUnavailable({
          operation,
          code: "busy",
          retry_after_ms: value.retry_after_ms,
        });
      }
      const refusal =
        "status" in value &&
        (value.status === "stale" ||
          value.status === "upgrade_required" ||
          value.status === "server_behind");
      if ((status < 200 || status >= 300) && !refusal) {
        return yield* new EdgeRejected({ operation, code: `http_${status}` });
      }
      return value as Exclude<T, { status: "busy" }>;
    }).pipe(
      Effect.timeoutOrElse({
        duration: attemptTimeoutMs,
        orElse: () => Effect.fail(timeout()),
      }),
    );

    return yield* attempt.pipe(
      Effect.retry({
        schedule,
        times: 3,
        while: (error) => error instanceof EdgeUnavailable,
      }),
      Effect.timeoutOrElse({
        duration: callTimeoutMs,
        orElse: () => Effect.fail(timeout()),
      }),
    );
  });
}
