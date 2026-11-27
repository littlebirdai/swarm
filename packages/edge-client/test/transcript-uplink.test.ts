import { expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import {
  TRANSCRIPT_APPEND_MAX_BYTES,
  TRANSCRIPT_APPEND_MAX_MESSAGES,
  type TranscriptAppendRequest,
  type TranscriptAppendReceipt,
  type TranscriptAppendWrite,
} from "@codecast/edge-contract";
import { it } from "@codecast/effect-kit/effect/testing";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Metric from "effect/Metric";
import { join } from "effect/Fiber";
import { adjust } from "effect/testing/TestClock";
import {
  fileTranscriptSpool,
  TranscriptUplink,
  TranscriptUplinkError,
  type TranscriptSpool,
  type TranscriptUplinkOptions,
} from "../src/effect";

function write(conversation_id: string): TranscriptAppendWrite {
  return {
    conversation_id,
    messages: [{ role: "assistant", content: conversation_id }],
  };
}

function receipt(batch: TranscriptAppendRequest): TranscriptAppendReceipt {
  return {
    v: 1,
    batch_id: batch.batch_id,
    results: batch.writes.map((entry) => ({
      status: "applied",
      inserted: entry.messages.length,
      ids: [entry.conversation_id],
    })),
  };
}

function memorySpool(): TranscriptSpool {
  let stored: TranscriptAppendRequest | null = null;
  return {
    read: async () => stored,
    save: async (batch) => {
      stored = batch;
    },
    clear: async () => {
      stored = null;
    },
  };
}

function withUplink<A, E, R>(
  options: TranscriptUplinkOptions,
  run: (uplink: TranscriptUplink["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.flatMap(TranscriptUplink, run).pipe(
    Effect.provide(TranscriptUplink.layer(options)),
  );
}

it.effect(
  "batches across sessions and backpressures later writes behind a slow receipt",
  () =>
    Effect.gen(function* () {
      const batches: TranscriptAppendRequest[] = [];
      const firstSent = yield* Deferred.make<void>();
      const slowServer = yield* Deferred.make<void>();
      yield* withUplink(
        {
          spool: memorySpool(),
          async send(batch, signal) {
            batches.push(batch);
            if (batches.length === 1) {
              await Effect.runPromise(Deferred.succeed(firstSent, undefined));
              await Effect.runPromise(Deferred.await(slowServer), { signal });
            }
            return receipt(batch);
          },
        },
        (uplink) =>
          Effect.gen(function* () {
            yield* uplink.ready;
            const first = yield* Effect.forkChild(
              uplink.submit(write("first")),
              { startImmediately: true },
            );
            const second = yield* Effect.forkChild(
              uplink.submit(write("second")),
              { startImmediately: true },
            );
            yield* adjust(250);
            yield* Deferred.await(firstSent);
            expect(
              batches[0]?.writes.map((entry) => entry.conversation_id),
            ).toEqual(["first", "second"]);

            const accepted: number[] = [];
            const later = yield* Effect.forkChild(
              Effect.forEach(
                Array.from({ length: 60 }, (_, index) => index),
                (index) =>
                  uplink.submit(write(String(index))).pipe(
                    Effect.tap(() =>
                      Effect.sync(() => {
                        accepted.push(index);
                      }),
                    ),
                  ),
                { concurrency: "unbounded" },
              ),
            );
            yield* adjust(10_000);
            expect(batches).toHaveLength(1);
            expect(accepted).toEqual([]);
            yield* Deferred.succeed(slowServer, undefined);
            expect(yield* join(first)).toMatchObject({ status: "applied" });
            expect(yield* join(second)).toMatchObject({ status: "applied" });
            yield* adjust(1_000);
            expect(yield* join(later)).toHaveLength(60);
            expect(batches.length).toBeLessThan(10);
            expect(
              batches.every(
                (batch) =>
                  batch.writes.flatMap((entry) => entry.messages).length <=
                  TRANSCRIPT_APPEND_MAX_MESSAGES,
              ),
            ).toBe(true);
            expect(
              batches
                .slice(1)
                .flatMap((batch) =>
                  batch.writes.map((entry) => entry.conversation_id),
                ),
            ).toEqual(Array.from({ length: 60 }, (_, index) => String(index)));
          }),
      );
    }),
);

it.effect(
  "a definitive server rejection retains the packet and releases blocked producers with the error",
  () =>
    Effect.gen(function* () {
      const spool = memorySpool();
      const rejected = new TranscriptUplinkError({
        message: "Transcript request refused",
        retryable: false,
      });
      const batches: TranscriptAppendRequest[] = [];
      yield* withUplink(
        {
          spool,
          async send(batch) {
            batches.push(batch);
            throw rejected;
          },
        },
        (uplink) =>
          Effect.gen(function* () {
            yield* uplink.ready;
            const pending = yield* Effect.forkChild(
              Effect.flip(uplink.submit(write("first"))),
            );
            yield* adjust(250);
            expect(yield* join(pending)).toBe(rejected);
            expect(yield* Effect.flip(uplink.submit(write("second")))).toBe(
              rejected,
            );
            expect(yield* Effect.promise(spool.read)).toEqual(batches[0]);
          }),
      );
      expect(batches).toHaveLength(1);
    }),
);

it.effect(
  "restart replays the disk packet first and the server returns its original receipt",
  () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(joinPath(tmpdir(), "transcript-uplink-"))),
        (path) =>
          Effect.promise(() => rm(path, { recursive: true, force: true })),
      );
      const path = joinPath(directory, "spool.json");
      const applied: string[] = [];
      const attempts: TranscriptAppendRequest[] = [];
      const receipts = new Map<string, TranscriptAppendReceipt>();
      const append = (batch: TranscriptAppendRequest) => {
        attempts.push(batch);
        const prior = receipts.get(batch.batch_id);
        if (prior) return prior;
        applied.push(...batch.writes.map((entry) => entry.conversation_id));
        const result = receipt(batch);
        receipts.set(batch.batch_id, result);
        return result;
      };
      const lost = yield* Deferred.make<void>();
      yield* withUplink(
        {
          spool: fileTranscriptSpool(path),
          async send(batch, signal) {
            append(batch);
            await Effect.runPromise(Deferred.succeed(lost, undefined));
            return Effect.runPromise(Effect.never, { signal });
          },
        },
        (uplink) =>
          Effect.gen(function* () {
            yield* uplink.ready;
            yield* Effect.forkChild(uplink.submit(write("spooled")));
            yield* adjust(250);
            yield* Deferred.await(lost);
          }),
      );
      expect(
        (yield* Effect.promise(fileTranscriptSpool(path).read))?.batch_id,
      ).toBe(attempts[0]?.batch_id);

      yield* withUplink(
        {
          spool: fileTranscriptSpool(path),
          send: async (batch) => append(batch),
        },
        (uplink) =>
          Effect.gen(function* () {
            const next = yield* Effect.forkChild(uplink.submit(write("next")));
            yield* uplink.ready;
            expect(applied).toEqual(["spooled"]);
            expect(attempts[1]).toEqual(attempts[0]);
            expect(
              yield* Effect.promise(fileTranscriptSpool(path).read),
            ).toBeNull();
            yield* adjust(250);
            expect(yield* join(next)).toEqual({
              status: "applied",
              inserted: 1,
              ids: ["next"],
            });
          }),
      );
      expect(applied).toEqual(["spooled", "next"]);
    }),
);

it.effect(
  "splits batches at the byte limit and resumes sending after a transient rejection",
  () =>
    Effect.gen(function* () {
      const batches: TranscriptAppendRequest[] = [];
      const large = (id: string): TranscriptAppendWrite => ({
        conversation_id: id,
        messages: [{ role: "assistant", content: "x".repeat(300_000) }],
      });
      yield* withUplink(
        {
          spool: memorySpool(),
          async send(batch) {
            batches.push(batch);
            if (batches.length === 1)
              throw new TranscriptUplinkError({
                message: "Slow down",
                retryable: true,
              });
            return receipt(batch);
          },
        },
        (uplink) =>
          Effect.gen(function* () {
            yield* uplink.ready;
            const first = yield* Effect.forkChild(
              uplink.submit(large("first")),
            );
            const second = yield* Effect.forkChild(
              uplink.submit(large("second")),
            );
            yield* adjust(1_750);
            yield* join(first);
            yield* join(second);
          }),
      );
      expect(
        batches.map((batch) =>
          batch.writes.map((entry) => entry.conversation_id),
        ),
      ).toEqual([["first"], ["first"], ["second"]]);
      expect(batches[0]).toEqual(batches[1]);
      expect(
        batches.every(
          (batch) =>
            new TextEncoder().encode(JSON.stringify(batch)).length <=
            TRANSCRIPT_APPEND_MAX_BYTES,
        ),
      ).toBe(true);
    }),
);

it.effect(
  "bounded retry failure retains its spool and blocks only the affected legacy sequence",
  () =>
    Effect.gen(function* () {
      let attempts = 0;
      const spool = memorySpool();
      const error = new TranscriptUplinkError({
        message: "unavailable",
        retryable: true,
      });
      yield* withUplink(
        {
          spool,
          async send() {
            attempts++;
            throw error;
          },
          async fallback() {
            throw new Error("ambiguous transport failure must not fall back");
          },
        },
        (uplink) =>
          Effect.gen(function* () {
            yield* uplink.ready;
            const pending = yield* Effect.forkChild(
              Effect.flip(uplink.submit(write("affected"))),
            );
            yield* adjust(20_000);
            expect(yield* join(pending)).toBe(error);
            expect(attempts).toBe(6);
            expect((yield* Effect.promise(spool.read))?.writes).toEqual([
              write("affected"),
            ]);
            expect(yield* Effect.flip(uplink.waitForReplay("affected"))).toBe(
              error,
            );
            yield* uplink.waitForReplay("unrelated");
          }),
      );
    }),
);

it.effect(
  "the worker retries a held packet after backoff and then sends newer writes",
  () =>
    Effect.gen(function* () {
      const spool = memorySpool();
      const attempts: TranscriptAppendRequest[] = [];
      const error = new TranscriptUplinkError({
        message: "unavailable",
        retryable: true,
      });
      let online = false;
      yield* withUplink(
        {
          spool,
          async send(batch) {
            attempts.push(batch);
            if (!online) throw error;
            return receipt(batch);
          },
        },
        (uplink) =>
          Effect.gen(function* () {
            yield* uplink.ready;
            const first = yield* Effect.forkChild(
              Effect.flip(uplink.submit(write("held"))),
            );
            yield* adjust(10_000);
            expect(yield* join(first)).toBe(error);
            expect(attempts).toHaveLength(6);
            expect(yield* Effect.promise(spool.read)).toEqual(attempts[0]);
            expect(yield* Effect.flip(uplink.waitForReplay("held"))).toBe(
              error,
            );

            online = true;
            yield* adjust(30_000);
            expect(attempts).toHaveLength(7);
            expect(attempts.slice(1)).toEqual(
              Array.from({ length: 6 }, () => attempts[0]),
            );
            expect(yield* Effect.promise(spool.read)).toBeNull();
            yield* uplink.waitForReplay("held");
            const next = yield* Effect.forkChild(uplink.submit(write("held")));
            yield* adjust(250);
            expect(yield* join(next)).toMatchObject({ status: "applied" });
            expect(attempts[7]?.batch_id).not.toBe(attempts[0]?.batch_id);
          }),
      );
    }),
);

it.effect(
  "credential rejections leave all five transport retries available",
  () =>
    Effect.gen(function* () {
      let credentialRejections = 0;
      let transportAttempts = 0;
      const attempts: TranscriptAppendRequest[] = [];
      const credentialFailure = new TranscriptUplinkError({
        message: "credential expired",
        retryable: false,
        credentialRejected: true,
      });
      yield* withUplink(
        {
          spool: memorySpool(),
          async send(batch) {
            attempts.push(batch);
            if (credentialRejections < 8) {
              credentialRejections++;
              throw credentialFailure;
            }
            if (++transportAttempts <= 5)
              throw new TranscriptUplinkError({
                message: "unavailable",
                retryable: true,
              });
            return receipt(batch);
          },
        },
        (uplink) =>
          Effect.gen(function* () {
            yield* uplink.ready;
            const pending = yield* Effect.forkChild(
              uplink.submit(write("credentials")),
            );
            yield* adjust(13_500);
            expect(credentialRejections).toBe(8);
            expect(transportAttempts).toBe(6);
            expect(yield* join(pending)).toMatchObject({ status: "applied" });
            expect(new Set(attempts.map((batch) => batch.batch_id)).size).toBe(
              1,
            );
          }),
      );
    }),
);

it.effect(
  "new submissions after a permanent worker failure bypass the dead queue",
  () =>
    Effect.gen(function* () {
      const skipped = Metric.counter("transcript_uplink_terminal_bypasses");
      const before = (yield* Metric.value(skipped)).count;
      const spool = memorySpool();
      const rejected = new TranscriptUplinkError({
        message: "permanent",
        retryable: false,
      });
      let sends = 0;
      yield* withUplink(
        {
          spool,
          async send() {
            sends++;
            throw rejected;
          },
        },
        (uplink) =>
          Effect.gen(function* () {
            yield* uplink.ready;
            const first = yield* Effect.forkChild(
              Effect.flip(uplink.submit(write("first"))),
            );
            yield* adjust(250);
            expect(yield* join(first)).toBe(rejected);
            for (let i = 0; i < 40; i++)
              expect(yield* Effect.flip(uplink.submit(write("later")))).toBe(
                rejected,
              );
            expect((yield* Metric.value(skipped)).count - before).toBe(40);
            expect(sends).toBe(1);
          }),
      );
    }),
);

it.effect(
  "rotating rejected credentials wait for the minimum and bounded Retry-After",
  () =>
    Effect.gen(function* () {
      const bearers: string[] = [];
      const hints = [undefined, 3_500, 120_000];
      yield* withUplink(
        {
          spool: memorySpool(),
          async send(batch) {
            const index = bearers.length;
            const bearer = `fixture-bearer-${index}`;
            bearers.push(bearer);
            if (index < hints.length)
              throw new TranscriptUplinkError({
                message: `Rejected ${bearer}`,
                credentialRejected: true,
                retryable: false,
                retryAfterMs: hints[index],
              });
            return receipt(batch);
          },
        },
        (uplink) =>
          Effect.gen(function* () {
            yield* uplink.ready;
            const pending = yield* Effect.forkChild(
              uplink.submit(write("rotating")),
            );
            yield* adjust(250);
            for (const [index, delay] of [1_000, 3_500, 60_000].entries()) {
              expect(bearers).toHaveLength(index + 1);
              yield* adjust(delay - 1);
              expect(bearers).toHaveLength(index + 1);
              yield* adjust(1);
            }
            expect(new Set(bearers).size).toBe(4);
            expect(yield* join(pending)).toMatchObject({ status: "applied" });
          }),
      );
    }),
);

it.effect(
  "a held conversation reports the permanent failure after backoff",
  () =>
    Effect.gen(function* () {
      const transient = new TranscriptUplinkError({
        message: "unavailable",
        retryable: true,
      });
      const permanent = new TranscriptUplinkError({
        message: "invalid receipt",
        retryable: false,
      });
      let failure = transient;
      yield* withUplink(
        {
          spool: memorySpool(),
          async send() {
            throw failure;
          },
        },
        (uplink) =>
          Effect.gen(function* () {
            yield* uplink.ready;
            const pending = yield* Effect.forkChild(
              Effect.flip(uplink.submit(write("held"))),
            );
            yield* adjust(10_000);
            expect(yield* join(pending)).toBe(transient);
            expect(yield* Effect.flip(uplink.waitForReplay("held"))).toBe(
              transient,
            );
            failure = permanent;
            yield* adjust(30_000);
            expect(yield* Effect.flip(uplink.waitForReplay("held"))).toBe(
              permanent,
            );
            expect(yield* Effect.flip(uplink.submit(write("held")))).toBe(
              permanent,
            );
          }),
      );
    }),
);

it.effect(
  "a known failed batch allows legacy only for unrelated conversations",
  () =>
    Effect.gen(function* () {
      const spool = memorySpool();
      const failure = new TranscriptUplinkError({
        message: "permanent",
        retryable: false,
      });
      yield* withUplink(
        {
          spool,
          async send() {
            throw failure;
          },
          async fallback() {
            throw new Error("the caller owns the legacy write");
          },
        },
        (uplink) =>
          Effect.gen(function* () {
            yield* uplink.ready;
            const pending = yield* Effect.forkChild(
              Effect.flip(uplink.submit(write("held"))),
            );
            yield* adjust(250);
            expect(yield* join(pending)).toBe(failure);
            expect(yield* Effect.flip(uplink.submit(write("held")))).toBe(
              failure,
            );
            expect(yield* uplink.submit(write("unrelated"))).toEqual({
              status: "legacy",
            });
            expect((yield* Effect.promise(spool.read))?.writes).toEqual([
              write("held"),
            ]);
          }),
      );
    }),
);

it.effect(
  "queue shutdown releases submissions blocked behind a permanently failed batch",
  () =>
    Effect.gen(function* () {
      const failSend = yield* Deferred.make<void>();
      const failure = new TranscriptUplinkError({
        message: "permanent",
        retryable: false,
      });
      let sends = 0;
      const settled: unknown[] = [];
      yield* withUplink(
        {
          spool: memorySpool(),
          async send(_batch, signal) {
            sends++;
            await Effect.runPromise(Deferred.await(failSend), { signal });
            throw failure;
          },
        },
        (uplink) =>
          Effect.gen(function* () {
            yield* uplink.ready;
            const pending = yield* Effect.forkChild(
              Effect.flip(uplink.submit(write("head"))),
            );
            yield* adjust(250);
            expect(sends).toBe(1);
            const followers = yield* Effect.forkChild(
              Effect.forEach(
                Array.from({ length: 40 }, (_, n) => n),
                (n) =>
                  Effect.flip(uplink.submit(write(`follower-${n}`))).pipe(
                    Effect.tap((error) =>
                      Effect.sync(() => settled.push(error)),
                    ),
                  ),
                { concurrency: "unbounded" },
              ),
            );
            yield* adjust(0);
            expect(settled).toEqual([]);
            yield* Deferred.succeed(failSend, undefined);
            expect(yield* join(pending)).toBe(failure);
            yield* adjust(0);
            expect(settled).toHaveLength(40);
            expect(settled.every((error) => error === failure)).toBe(true);
            yield* join(followers);
            expect(sends).toBe(1);
          }),
      );
    }),
);

for (const mode of ["receipt", "clear"] as const) {
  it.effect(
    `persistent ${mode} error during replay settles startup, logs on state change, moves metrics, and recovers`,
    () =>
      Effect.gen(function* () {
        const warnings: string[] = [];
        const logger = Logger.make(({ logLevel, message }) => {
          if (logLevel === "Warn")
            warnings.push(
              Array.isArray(message)
                ? message.map(String).join(" ")
                : String(message),
            );
        });
        const heldGauge = Metric.gauge(
          "transcript_uplink_replay_held_conversations",
        );
        const retriesCounter = Metric.counter(
          "transcript_uplink_replay_retries",
        );
        const bypassesCounter = Metric.counter(
          "transcript_uplink_replay_bypasses",
        );
        const spooled: TranscriptAppendRequest = {
          v: 1,
          batch_id: `replay-${mode}`,
          writes: [write("held-a"), write("held-b")],
        };
        let cleared = false;
        let sends = 0;
        let clears = 0;
        let allowSuccess = false;
        let alternateFailure = false;
        yield* withUplink(
          {
            spool: {
              path: "/fixture/replay-spool.json",
              read: async () => (cleared ? null : spooled),
              save: async () => {},
              async clear() {
                clears++;
                if (mode === "clear" && !allowSuccess)
                  throw Object.assign(
                    new Error(
                      alternateFailure ? "EIO io error" : "EACCES denied",
                    ),
                    { code: alternateFailure ? "EIO" : "EACCES" },
                  );
                cleared = true;
              },
            },
            async send(batch) {
              sends++;
              if (mode === "receipt" && !allowSuccess) {
                if (alternateFailure)
                  throw new TranscriptUplinkError({
                    message: "Replay endpoint rejected batch",
                    retryable: false,
                  });
                return receipt({ ...batch, batch_id: "mismatched" });
              }
              return receipt(batch);
            },
            async fallback() {
              throw new Error("The caller owns legacy writes");
            },
          },
          (uplink) =>
            Effect.gen(function* () {
              yield* adjust(0);
              const startupError = yield* Effect.flip(uplink.ready);
              expect(startupError.message).toContain(
                mode === "clear"
                  ? "EACCES"
                  : "Invalid transcript batch receipt",
              );
              expect(startupError.message).toContain("held-a");
              expect(startupError.message).toContain("held-b");
              expect((yield* Metric.value(heldGauge)).value).toBe(2);
              expect((yield* Metric.value(retriesCounter)).count).toBe(0);
              expect(warnings).toHaveLength(1);
              expect(warnings[0]).toContain("held-a, held-b");
              expect(warnings[0]).toContain("attempt 1");
              expect(
                yield* Effect.flip(uplink.waitForReplay("held-a")),
              ).toBeInstanceOf(TranscriptUplinkError);
              expect(
                yield* Effect.flip(uplink.submit(write("held-a"))),
              ).toBeInstanceOf(TranscriptUplinkError);
              expect((yield* Metric.value(bypassesCounter)).count).toBe(0);
              expect(yield* uplink.submit(write("unrelated"))).toEqual({
                status: "legacy",
              });
              expect((yield* Metric.value(bypassesCounter)).count).toBe(1);
              yield* adjust(30_000);
              expect((yield* Metric.value(retriesCounter)).count).toBe(1);
              expect(warnings).toHaveLength(1);
              expect(sends).toBe(mode === "clear" ? 1 : 2);
              expect(clears).toBe(mode === "clear" ? 2 : 0);
              alternateFailure = true;
              yield* adjust(30_000);
              expect((yield* Metric.value(retriesCounter)).count).toBe(2);
              expect(warnings).toHaveLength(2);
              expect(warnings[1]).toContain("attempt 3");
              expect(sends).toBe(mode === "clear" ? 1 : 3);
              yield* adjust(30_000);
              expect((yield* Metric.value(retriesCounter)).count).toBe(3);
              expect(warnings).toHaveLength(2);
              allowSuccess = true;
              yield* adjust(30_000);
              expect((yield* Metric.value(retriesCounter)).count).toBe(4);
              expect((yield* Metric.value(heldGauge)).value).toBe(0);
              expect(sends).toBe(mode === "clear" ? 1 : 5);
              expect(cleared).toBe(true);
              yield* uplink.waitForReplay("held-a");
              yield* uplink.waitForReplay("held-b");
              const next = yield* Effect.forkChild(
                uplink.submit(write("held-a")),
              );
              yield* adjust(250);
              expect(yield* join(next)).toMatchObject({ status: "applied" });
            }),
        ).pipe(
          Effect.provide(Logger.layer([logger])),
          Effect.provideService(Metric.MetricRegistry, new Map()),
        );
      }),
  );
}
