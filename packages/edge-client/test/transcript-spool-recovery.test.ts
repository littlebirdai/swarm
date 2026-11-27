import { expect } from "bun:test";
import { it } from "@codecast/effect-kit/effect/testing";
import * as Effect from "effect/Effect";
import { join } from "effect/Fiber";
import { adjust } from "effect/testing/TestClock";
import { TranscriptUplink } from "../src/effect";

for (const recovers of [true, false]) {
  it.effect(
    recovers
      ? "transient spool reads recover on spaced retries"
      : "transient startup reads stop after three retries",
    () => {
      const path = "/fixture/spool.json";
      const cause = Object.assign(new Error("device is unavailable"), {
        code: "EIO",
      });
      let reads = 0;
      return Effect.gen(function* () {
        const uplink = yield* TranscriptUplink;
        const ready = yield* Effect.forkChild(Effect.result(uplink.ready));
        yield* adjust(0);
        expect(reads).toBe(1);
        for (const attempt of [2, 3, 4]) {
          yield* adjust(999);
          expect(reads).toBe(attempt - 1);
          yield* adjust(1);
          expect(reads).toBe(attempt);
        }
        yield* adjust(10_000);
        expect(reads).toBe(4);
        const result = yield* join(ready);
        if (recovers) expect(result._tag).toBe("Success");
        else {
          expect(result).toMatchObject({
            _tag: "Failure",
            failure: { cause, spoolPath: path, retryable: false },
          });
          if (result._tag === "Failure") {
            expect(result.failure.message).toContain(path);
            expect(result.failure.message).toContain("EIO");
          }
        }
      }).pipe(
        Effect.provide(
          TranscriptUplink.layer({
            spool: {
              path,
              async read() {
                reads++;
                if (recovers && reads === 4) return null;
                throw cause;
              },
              async save() {
                throw new Error("Unexpected spool save");
              },
              async clear() {
                throw new Error("Unexpected spool clear");
              },
            },
            async send() {
              throw new Error("Unexpected edge request");
            },
          }),
        ),
      );
    },
  );
}
