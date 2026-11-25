import { currentTimeMillis, monotonicTimeNanos } from "effect/Clock";
import * as Effect from "effect/Effect";
import type {
  ClaimResponse,
  EdgeErrorResponse,
  ReleaseResponse,
  RenewResponse,
} from "@codecast/edge-contract";
import { ClaimLost, EdgeParseError, type EdgeError } from "./failures";
import type { ClaimGrant, ClaimTiming, EdgeRequests } from "./types";

type ClaimOperations = {
  claim: (
    request: EdgeRequests["claim"],
  ) => Effect.Effect<
    Exclude<ClaimResponse, EdgeErrorResponse | { status: "busy" }>,
    EdgeError
  >;
  renew: (
    request: EdgeRequests["renew"],
  ) => Effect.Effect<Extract<RenewResponse, { status: "renewed" }>, EdgeError>;
  release: (
    request: EdgeRequests["release"],
  ) => Effect.Effect<Exclude<ReleaseResponse, EdgeErrorResponse>, EdgeError>;
};

const monotonicMillis = Effect.map(monotonicTimeNanos, (nanos) =>
  Number(nanos / 1_000_000n),
);

export function makeClaimHolder({ claim, renew, release }: ClaimOperations) {
  const heldSessions = new Set<string>();

  return Effect.fn("edgeClient.withClaim")(function* <A, E, R>(
    request: EdgeRequests["claim"],
    { maxServerClockLeadMs }: ClaimTiming,
    work: (grant: ClaimGrant) => Effect.Effect<A, E, R>,
  ) {
    if (
      !Number.isSafeInteger(maxServerClockLeadMs) ||
      maxServerClockLeadMs < 0
    ) {
      return yield* Effect.die(
        new RangeError("Clock lead must be a non-negative safe integer"),
      );
    }

    const claimRequest = { ...request };
    const session = claimRequest.session;

    return yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            if (heldSessions.has(session)) return false;
            heldSessions.add(session);
            return true;
          }),
          (reserved) =>
            Effect.sync(() => {
              if (reserved) heldSessions.delete(session);
            }),
        ).pipe(
          Effect.flatMap((reserved) =>
            reserved
              ? Effect.void
              : Effect.fail(
                  new ClaimLost({ operation: "claim", reason: "already_held" }),
                ),
          ),
        );

        const start = yield* monotonicMillis;
        const wall = yield* currentTimeMillis;
        const { grant, fence } = yield* Effect.acquireRelease(
          Effect.gen(function* () {
            const grant = yield* claim(claimRequest);
            if (grant.status === "stale") {
              return yield* new ClaimLost({
                operation: "claim",
                reason: "stale",
              });
            }
            if (grant.session !== session) {
              return yield* new EdgeParseError({
                operation: "claim",
                code: "invalid_value",
                path: "$.session",
              });
            }
            const { v, run, fencing_token } = grant;
            return { grant, fence: { v, session, run, fencing_token } };
          }),
          ({ fence }) =>
            release(fence).pipe(
              Effect.catch((error) =>
                Effect.logWarning("edgeClient.release", error),
              ),
            ),
          { interruptible: true },
        );

        const remaining = (expiresAt: number) =>
          Effect.gen(function* () {
            const monotonicNow = yield* monotonicMillis;
            const wallNow = yield* currentTimeMillis;
            return (
              expiresAt -
              Math.max(wallNow, wall + Math.max(0, monotonicNow - start)) -
              maxServerClockLeadMs
            );
          });

        let expiresAt = grant.expires_at;
        if ((yield* remaining(expiresAt)) <= 0) {
          return yield* new ClaimLost({
            operation: "claim",
            reason: "expired",
          });
        }

        const supervise = Effect.fn("edgeClient.renewClaim")(function* () {
          const expired = () =>
            new ClaimLost({ operation: "renew", reason: "expired" });
          while (true) {
            const beforeSleep = yield* remaining(expiresAt);
            if (beforeSleep <= 0) return yield* expired();
            yield* Effect.sleep(Math.max(1, Math.floor(beforeSleep / 2)));
            const budget = yield* remaining(expiresAt);
            if (budget <= 0) return yield* expired();

            const renewed = yield* renew(fence).pipe(
              Effect.catch((error) =>
                Effect.fail(
                  error instanceof ClaimLost
                    ? error
                    : new ClaimLost({
                        operation: "renew",
                        reason: "unconfirmed",
                      }),
                ),
              ),
              Effect.timeoutOrElse({
                duration: budget,
                orElse: () => Effect.fail(expired()),
              }),
            );

            if (
              (yield* remaining(expiresAt)) <= 0 ||
              (yield* remaining(renewed.expires_at)) <= 0
            ) {
              return yield* expired();
            }
            expiresAt = renewed.expires_at;
          }
        });

        return yield* Effect.raceFirst(
          Effect.scoped(Effect.suspend(() => work(grant))).pipe(
            Effect.flatMap((value) =>
              Effect.flatMap(remaining(expiresAt), (timeLeft) =>
                timeLeft > 0
                  ? Effect.succeed(value)
                  : Effect.fail(
                      new ClaimLost({ operation: "claim", reason: "expired" }),
                    ),
              ),
            ),
          ),
          supervise(),
        );
      }),
    );
  });
}
