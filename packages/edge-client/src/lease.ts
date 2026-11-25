import * as Effect from "effect/Effect";
import { ClaimLost, EdgeParseError, type RequestFailure } from "./failures";
import { elapsed, type Timed } from "./request";
import type { ClaimGrant, ClaimResult, EdgeRequests, Renewed } from "./types";

type ClaimOperations = {
  claim: (
    request: EdgeRequests["claim"],
  ) => Effect.Effect<Timed<ClaimResult>, RequestFailure>;
  renew: (
    request: EdgeRequests["renew"],
    budget: Effect.Effect<number>,
  ) => Effect.Effect<Timed<Renewed>, RequestFailure | ClaimLost>;
  release: (
    request: EdgeRequests["release"],
  ) => Effect.Effect<unknown, RequestFailure>;
};

function remaining(lease: Timed<{ lease_ms: number }>) {
  const duration = lease.value.lease_ms;
  const margin = Math.min(1_000, Math.ceil(duration / 10));
  return Effect.map(elapsed(lease.started), (ms) => duration - margin - ms);
}

export function makeClaimHolder({ claim, renew, release }: ClaimOperations) {
  const heldSessions = new Set<string>();

  return Effect.fn("edgeClient.withClaim")(function* <A, E, R>(
    request: EdgeRequests["claim"],
    work: (grant: ClaimGrant) => Effect.Effect<A, E, R>,
  ) {
    const session = request.session;
    let stale = false;

    return yield* Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.gen(function* () {
            if (heldSessions.has(session)) {
              return yield* new ClaimLost({
                operation: "claim",
                reason: "already_held",
              });
            }
            heldSessions.add(session);
          }),
          () =>
            Effect.sync(() => {
              heldSessions.delete(session);
            }),
        );

        const acquired = yield* Effect.acquireRelease(
          Effect.gen(function* () {
            const timed = yield* claim(request);
            const grant = timed.value;
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
            return {
              lease: { value: grant, started: timed.started },
              fence: { v, session, run, fencing_token },
            };
          }),
          ({ fence }) =>
            stale
              ? Effect.void
              : release(fence).pipe(
                  Effect.catch((error) =>
                    Effect.logWarning("edgeClient.release", error),
                  ),
                ),
          { interruptible: true },
        );

        let timeLeft = remaining(acquired.lease);
        if ((yield* timeLeft) <= 0) {
          return yield* new ClaimLost({
            operation: "claim",
            reason: "expired",
          });
        }

        const supervise = Effect.fn("edgeClient.renewClaim")(function* () {
          const expired = () =>
            new ClaimLost({ operation: "renew", reason: "expired" });
          while (true) {
            const left = yield* timeLeft;
            if (left <= 0) return yield* expired();
            yield* Effect.sleep(
              Math.min(left, Math.max(25, Math.floor(left / 2))),
            );
            if ((yield* timeLeft) <= 0) return yield* expired();

            const renewal = yield* renew(acquired.fence, timeLeft).pipe(
              Effect.catch((error) =>
                Effect.gen(function* () {
                  if (error instanceof ClaimLost) {
                    stale = true;
                    return yield* error;
                  }
                  if ((yield* timeLeft) <= 0) return yield* expired();
                  return yield* new ClaimLost({
                    operation: "renew",
                    reason: "unconfirmed",
                    cause: error,
                  });
                }),
              ),
            );
            if ((yield* timeLeft) <= 0) return yield* expired();
            const renewed = remaining(renewal);
            if ((yield* renewed) <= 0) return yield* expired();
            timeLeft = renewed;
          }
        });

        return yield* Effect.raceFirst(
          Effect.scoped(Effect.suspend(() => work(acquired.lease.value))).pipe(
            Effect.flatMap((value) =>
              Effect.gen(function* () {
                if ((yield* timeLeft) <= 0) {
                  return yield* new ClaimLost({
                    operation: "claim",
                    reason: "expired",
                  });
                }
                return value;
              }),
            ),
          ),
          supervise(),
        );
      }),
    );
  });
}
