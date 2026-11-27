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
