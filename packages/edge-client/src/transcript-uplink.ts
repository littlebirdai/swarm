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
import * as Metric from "effect/Metric";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import type { TranscriptSpool } from "./transcript-spool";

const queueCapacity = 32;
const batchInterval = "250 millis";
const recoveryBackoffMs = 30_000;
const maxRetryDelayMs = 60_000;
const terminalBypasses = Metric.counter("transcript_uplink_terminal_bypasses");

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
  credentialRejected?: boolean;
}> {}

const retryDelay = (minimum: number, hint?: number) =>
  Math.max(minimum, Math.min(hint || 0, maxRetryDelayMs));

const spacedRetry = Schedule.spaced("1 second").pipe(
  Schedule.modifyDelay(({ input }) =>
    Effect.succeed(
      retryDelay(
        1_000,
        input instanceof TranscriptUplinkError ? input.retryAfterMs : undefined,
      ),
    ),
  ),
);

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
        const queue = yield* Effect.acquireRelease(
          Queue.bounded<PendingWrite>(queueCapacity),
          Queue.shutdown,
        );
        const fatal = yield* Deferred.make<never, TranscriptUplinkError>();
        const ready = yield* Deferred.make<void, TranscriptUplinkError>();
        const discovered = yield* Deferred.make<
          ReadonlySet<string>,
          TranscriptUplinkError
        >();
        let activeBatch: TranscriptAppendRequest | null = null;
        let heldFailure: TranscriptUplinkError | undefined;
        let terminalFailure: TranscriptUplinkError | undefined;
        const activeConversation = (id: string) =>
          activeBatch?.writes.some(
            ({ conversation_id }) => conversation_id === id,
          );

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
                schedule: spacedRetry,
                while: (error) => error.credentialRejected === true,
              }),
              Effect.retry({
                schedule: spacedRetry.pipe(Schedule.upTo({ times: 5 })),
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

        const sendHeldBatch = Effect.fn("TranscriptUplink.send-held-batch")(
          function* (batch: TranscriptAppendRequest, entries: PendingWrite[]) {
            for (;;) {
              const attempt = yield* Effect.result(transmit(batch));
              if (attempt._tag === "Success") {
                yield* spoolIo(options.spool.clear);
                activeBatch = null;
                heldFailure = undefined;
                for (const [index, entry] of entries.entries())
                  yield* Deferred.succeed(
                    entry.result,
                    attempt.success[index]!,
                  );
                return;
              }
              if (!attempt.failure.retryable) return yield* attempt.failure;
              heldFailure = attempt.failure;
              for (const entry of entries)
                yield* Deferred.fail(entry.result, heldFailure);
              yield* Effect.sleep(
                retryDelay(recoveryBackoffMs, heldFailure.retryAfterMs),
              );
            }
          },
        );

        yield* Effect.gen(function* () {
          activeBatch = yield* spoolIo(options.spool.read);
          yield* Deferred.succeed(
            discovered,
            new Set(
              activeBatch?.writes.map(({ conversation_id }) => conversation_id),
            ),
          );
          if (activeBatch) yield* sendHeldBatch(activeBatch, []);
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
            yield* sendHeldBatch(batch, entries);
          }
        }).pipe(
          Effect.catch(
            Effect.fn("TranscriptUplink.fail")(function* (error) {
              terminalFailure = error;
              heldFailure = undefined;
              yield* Deferred.fail(discovered, error);
              yield* Deferred.fail(ready, error);
              yield* Deferred.fail(fatal, error);
              yield* Queue.shutdown(queue);
            }),
          ),
          Effect.forkScoped,
        );

        return TranscriptUplink.of({
          ready: Deferred.await(ready),
          waitForReplay: Effect.fn("TranscriptUplink.wait-for-replay")(
            function* (conversationId) {
              const sessions = yield* Deferred.await(discovered);
              if (heldFailure && activeConversation(conversationId))
                return yield* heldFailure;
              if (sessions.has(conversationId)) yield* Deferred.await(ready);
              if (terminalFailure && activeConversation(conversationId))
                return yield* terminalFailure;
            },
          ),
          submit: Effect.fn("TranscriptUplink.submit")(function* (write) {
            if (!fitsTranscriptUplink(write)) {
              return yield* new TranscriptUplinkError({
                message: "Transcript write exceeds uplink limits",
                retryable: false,
              });
            }
            const onTerminal = Effect.fn("TranscriptUplink.bypass-terminal")(
              function* (error: TranscriptUplinkError) {
                yield* Deferred.await(discovered);
                if (
                  !options.fallback ||
                  activeConversation(write.conversation_id)
                )
                  return yield* error;
                return { status: "legacy" as const };
              },
            );
            if (terminalFailure) {
              yield* Metric.update(terminalBypasses, 1);
              return yield* onTerminal(terminalFailure);
            }
            if (heldFailure && activeConversation(write.conversation_id))
              return yield* heldFailure;
            const result = yield* Deferred.make<
              TranscriptAppendResult,
              TranscriptUplinkError
            >();
            if (!(yield* Queue.offer(queue, { write, result }))) {
              if (terminalFailure) return yield* onTerminal(terminalFailure);
              return yield* new TranscriptUplinkError({
                message: "Transcript uplink is closed",
                retryable: false,
              });
            }
            return yield* Effect.raceFirst(
              Deferred.await(result),
              Deferred.await(fatal).pipe(Effect.catch(onTerminal)),
            );
          }),
        });
      }),
    );
  }
}
