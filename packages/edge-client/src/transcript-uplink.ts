import {
  EDGE_PROTOCOL_VERSION,
  parseTranscriptAppendResponse,
  parseTranscriptAppendRequest,
  fitsTranscriptUplink,
  transcriptBatchFits,
  type TranscriptAppendRequest,
  type TranscriptAppendResult,
  type TranscriptAppendWrite,
} from "@codecast/edge-contract";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import type { TranscriptSpool } from "./transcript-spool";

const queueCapacity = 32;
const batchInterval = "250 millis";

export type TranscriptSubmission =
  | TranscriptAppendResult
  | { status: "legacy" };

type PendingWrite = {
  write: TranscriptAppendWrite;
  result: Deferred.Deferred<TranscriptAppendResult, TranscriptUplinkError>;
};

export class TranscriptUplinkError extends Data.TaggedError(
  "TranscriptUplinkError",
)<{
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  fallbackAllowed?: boolean;
}> {}

export interface TranscriptUplinkOptions {
  spool: TranscriptSpool;
  send(request: TranscriptAppendRequest, signal: AbortSignal): Promise<unknown>;
  fallback?(write: TranscriptAppendWrite): Promise<TranscriptAppendResult>;
}

function spoolIo<A>(operation: () => Promise<A>) {
  return Effect.tryPromise({
    try: operation,
    catch: () =>
      new TranscriptUplinkError({
        message: "Transcript spool I/O failed",
        retryable: false,
      }),
  }).pipe(Effect.uninterruptible);
}

export class TranscriptUplink extends Context.Service<
  TranscriptUplink,
  {
    submit(
      write: TranscriptAppendWrite,
    ): Effect.Effect<TranscriptSubmission, TranscriptUplinkError>;
    waitForReplay(
      conversationId: string,
    ): Effect.Effect<void, TranscriptUplinkError>;
    ready: Effect.Effect<void, TranscriptUplinkError>;
  }
>()("@codecast/edge-client/TranscriptUplink") {
  static layer(options: TranscriptUplinkOptions) {
    return Layer.effect(
      TranscriptUplink,
      Effect.gen(function* () {
        const queue = yield* Queue.bounded<PendingWrite>(queueCapacity);
        const fatal = yield* Deferred.make<never, TranscriptUplinkError>();
        const ready = yield* Deferred.make<void, TranscriptUplinkError>();
        const discovered = yield* Deferred.make<
          ReadonlySet<string>,
          TranscriptUplinkError
        >();
        let activeBatch: TranscriptAppendRequest | null = null;

        const fallback = Effect.fn("TranscriptUplink.fallback")(function* (
          batch: TranscriptAppendRequest,
        ) {
          const writeLegacy = options.fallback;
          if (!writeLegacy)
            return yield* new TranscriptUplinkError({
              message: "Transcript legacy writer unavailable",
              retryable: false,
            });
          return yield* Effect.forEach(
            batch.writes,
            (write) =>
              Effect.tryPromise({
                try: () =>
                  write.messages.every(
                    ({ message_uuid }) =>
                      typeof message_uuid === "string" && message_uuid.length,
                  )
                    ? writeLegacy(write)
                    : Promise.resolve({ status: "refused" as const }),
                catch: () =>
                  new TranscriptUplinkError({
                    message: "Transcript legacy write did not settle",
                    retryable: false,
                  }),
              }),
            { concurrency: 1 },
          );
        });

        const transmit = Effect.fn("TranscriptUplink.transmit")(function* (
          batch: TranscriptAppendRequest,
        ) {
          if (!parseTranscriptAppendRequest(batch).ok)
            return yield* fallback(batch);
          const response = yield* Effect.result(
            Effect.tryPromise({
              try: (signal) => options.send(batch, signal),
              catch: (error) =>
                error instanceof TranscriptUplinkError
                  ? error
                  : new TranscriptUplinkError({
                      message: "Transcript transport failed",
                      retryable: true,
                    }),
            }).pipe(
              Effect.retry({
                schedule: Schedule.spaced("1 second").pipe(
                  Schedule.modifyDelay(({ input }) =>
                    Effect.succeed(
                      Math.max(
                        1_000,
                        input instanceof TranscriptUplinkError
                          ? Math.min(input.retryAfterMs ?? 0, 60_000)
                          : 0,
                      ),
                    ),
                  ),
                  Schedule.upTo({ times: 5, duration: "1 minute" }),
                ),
                while: (error) => error.retryable,
              }),
            ),
          );
          if (response._tag === "Failure") {
            if (response.failure.fallbackAllowed && options.fallback)
              return yield* fallback(batch);
            return yield* response.failure;
          }
          const receipt = parseTranscriptAppendResponse(response.success);
          if (
            !receipt.ok ||
            receipt.value.batch_id !== batch.batch_id ||
            receipt.value.results.length !== batch.writes.length
          ) {
            return yield* new TranscriptUplinkError({
              message: "Invalid transcript batch receipt",
              retryable: false,
            });
          }
          return receipt.value.results;
        });

        yield* Effect.gen(function* () {
          activeBatch = yield* spoolIo(options.spool.read);
          yield* Deferred.succeed(
            discovered,
            new Set(
              activeBatch?.writes.map(({ conversation_id }) => conversation_id),
            ),
          );
          if (activeBatch) {
            yield* transmit(activeBatch);
            yield* spoolIo(options.spool.clear);
            activeBatch = null;
          }
          yield* Deferred.succeed(ready, undefined);
          let pending: PendingWrite[] = [];
          for (;;) {
            if (!pending.length) pending.push(yield* Queue.take(queue));
            yield* Effect.sleep(batchInterval);
            while (pending.length <= queueCapacity) {
              const entry = yield* Queue.poll(queue);
              if (entry._tag === "None") break;
              pending.push(entry.value);
            }
            const writes: TranscriptAppendWrite[] = [];
            const batchId = crypto.randomUUID();
            for (const entry of pending) {
              if (!transcriptBatchFits([...writes, entry.write], batchId))
                break;
              writes.push(entry.write);
            }
            const entries = pending.splice(0, writes.length);
            const batch: TranscriptAppendRequest = {
              v: EDGE_PROTOCOL_VERSION,
              batch_id: batchId,
              writes,
            };
            activeBatch = batch;
            yield* spoolIo(() => options.spool.save(batch));
            const results = yield* transmit(batch);
            yield* spoolIo(options.spool.clear);
            activeBatch = null;
            for (const [index, entry] of entries.entries()) {
              yield* Deferred.succeed(entry.result, results[index]!);
            }
          }
        }).pipe(
          Effect.catch(
            Effect.fn("TranscriptUplink.fail")(function* (error) {
              yield* Deferred.fail(discovered, error);
              yield* Deferred.fail(ready, error);
              yield* Deferred.fail(fatal, error);
            }),
          ),
          Effect.forkScoped,
        );

        return TranscriptUplink.of({
          ready: Deferred.await(ready),
          waitForReplay: Effect.fn("TranscriptUplink.wait-for-replay")(
            function* (conversationId) {
              const sessions = yield* Deferred.await(discovered);
              if (sessions.has(conversationId)) yield* Deferred.await(ready);
              const failure = yield* Deferred.poll(fatal);
              if (
                failure._tag === "Some" &&
                activeBatch?.writes.some(
                  ({ conversation_id }) => conversation_id === conversationId,
                )
              )
                return yield* failure.value;
            },
          ),
          submit: Effect.fn("TranscriptUplink.submit")(function* (write) {
            if (!fitsTranscriptUplink(write)) {
              return yield* new TranscriptUplinkError({
                message: "Transcript write exceeds uplink limits",
                retryable: false,
              });
            }
            const submit = Effect.gen(function* () {
              const result = yield* Deferred.make<
                TranscriptAppendResult,
                TranscriptUplinkError
              >();
              yield* Queue.offer(queue, { write, result });
              return yield* Deferred.await(result);
            });
            return yield* Effect.raceFirst(submit, Deferred.await(fatal)).pipe(
              Effect.catch((error) =>
                !options.fallback ||
                activeBatch?.writes.some(
                  ({ conversation_id }) =>
                    conversation_id === write.conversation_id,
                )
                  ? Effect.fail(error)
                  : Effect.succeed({ status: "legacy" as const }),
              ),
            );
          }),
        });
      }),
    );
  }
}
