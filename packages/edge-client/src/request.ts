import type {
  ClaimResponse,
  EdgeErrorResponse,
  HeartbeatResponse,
  HelloResponse,
  ReleaseResponse,
  RenewResponse,
  EdgeParseResult,
} from "@codecast/edge-contract";
import { currentTimeMillis, monotonicTimeNanos } from "effect/Clock";
import { toMillis } from "effect/Duration";
import * as Effect from "effect/Effect";
import { next } from "effect/Random";
import * as Schedule from "effect/Schedule";
import { EdgeParseError, EdgeRejected, EdgeUnavailable } from "./failures";
import {
  EdgeTransportError,
  type EdgeClientOptions,
  type EdgeOperation,
  type EdgeRequests,
} from "./types";

const readTime = Effect.gen(function* () {
  const monotonic = Number(yield* monotonicTimeNanos) / 1_000_000;
  const wall = yield* currentTimeMillis;
  return { monotonic, wall };
});

type WireReply =
  | ClaimResponse
  | HeartbeatResponse
  | HelloResponse
  | ReleaseResponse
  | RenewResponse;
type RejectedReply = EdgeErrorResponse | { status: "busy" };

type StartTime = Effect.Success<typeof readTime>;

export type Timed<T> = { value: T; started: StartTime };

export function elapsed(start: StartTime) {
  return Effect.map(readTime, (now) =>
    Math.max(now.monotonic - start.monotonic, now.wall - start.wall),
  );
}

function retryAfter(header: string | null | undefined, now: number) {
  if (header == null) return undefined;
  if (/^\d+$/.test(header.trim())) {
    const ms = Number(header) * 1_000;
    return Number.isSafeInteger(ms) ? ms : undefined;
  }
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

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

  return Effect.fn("edgeClient.request")(function* <
    K extends EdgeOperation,
    T extends WireReply,
  >(
    operation: K,
    request: EdgeRequests[K],
    parse: (body: unknown) => EdgeParseResult<T>,
    budget?: Effect.Effect<number> | "cleanup",
  ) {
    const callStarted = yield* readTime;
    const remaining =
      typeof budget === "object"
        ? budget
        : Effect.map(
            elapsed(callStarted),
            (ms) => (budget === "cleanup" ? 250 : callTimeoutMs) - ms,
          );
    const timeout = () => new EdgeUnavailable({ operation, code: "timeout" });

    const attempt = Effect.gen(function* () {
      const started = yield* readTime;
      const { status, body, retryAfterHeader } = yield* Effect.tryPromise({
        try: (signal) => transport(operation, request, signal),
        catch: (cause) => cause,
      }).pipe(
        Effect.catch((cause) =>
          cause instanceof EdgeTransportError
            ? Effect.fail(
                new EdgeUnavailable({
                  operation,
                  code: "network",
                  cause: cause.cause,
                }),
              )
            : Effect.die(cause),
        ),
      );
      const now = yield* currentTimeMillis;
      const parsed = parse(body);
      const value = parsed.ok ? parsed.value : undefined;
      if (value && "status" in value) {
        if (value.status === "error") {
          if (!value.retryable)
            return yield* new EdgeRejected({ operation, code: value.code });
          return yield* new EdgeUnavailable({
            operation,
            code: value.code,
            retry_after_ms:
              value.retry_after_ms ?? retryAfter(retryAfterHeader, now),
          });
        }
        if (value.status === "busy") {
          return yield* new EdgeUnavailable({
            operation,
            code: "busy",
            retry_after_ms: value.retry_after_ms,
          });
        }
        if (
          value.status === "stale" ||
          value.status === "upgrade_required" ||
          value.status === "server_behind"
        ) {
          return { value: value as Exclude<T, RejectedReply>, started };
        }
      }
      const code = `http_${status}`;
      if (status === 429 || status >= 500) {
        return yield* new EdgeUnavailable({
          operation,
          code,
          retry_after_ms: retryAfter(retryAfterHeader, now),
        });
      }
      if (status < 200 || status >= 300)
        return yield* new EdgeRejected({ operation, code });
      if (!parsed.ok)
        return yield* new EdgeParseError({
          operation,
          code: parsed.error.code,
          path: parsed.error.path,
        });
      return { value: parsed.value as Exclude<T, RejectedReply>, started };
    });

    const attemptWithinBudget = Effect.flatMap(remaining, (left) =>
      left <= 0
        ? Effect.fail(timeout())
        : attempt.pipe(
            Effect.timeoutOrElse({
              duration: Math.min(left, attemptTimeoutMs),
              orElse: () => Effect.fail(timeout()),
            }),
          ),
    );
    if (operation === "heartbeat" || budget === "cleanup")
      return yield* attemptWithinBudget;

    const schedule = Schedule.exponential(100).pipe(
      Schedule.modifyDelay(({ duration, input }) =>
        Effect.gen(function* () {
          if (!(input instanceof EdgeUnavailable)) return duration;
          const base = Math.min(toMillis(duration), 1_000);
          const jitter = yield* next;
          const delay = Math.max(
            Math.round(base * (1 + jitter / 2)),
            input.retry_after_ms ?? 0,
          );
          return delay >= (yield* remaining) ? yield* input : delay;
        }),
      ),
    );
    return yield* attemptWithinBudget.pipe(
      Effect.retry({
        schedule,
        times: budget ? undefined : 3,
        while: (error) => error instanceof EdgeUnavailable,
      }),
    );
  });
}
