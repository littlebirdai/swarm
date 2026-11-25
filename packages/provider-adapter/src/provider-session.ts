import { parseCanonicalEvent, type EdgeJson } from "@codecast/edge-contract";
import type {
  AnswerRequest,
  ControlOutcome,
} from "@codecast/provider-contract";
import type {
  RunFence,
  StartSpec,
  SteerRequest,
} from "@codecast/provider-contract";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { closed, inDoubt, refused } from "./options";
import { makeProviderEvents, type DurablePayload } from "./provider-events";
import {
  AdapterError,
  bestEffortReplies,
  processError,
  type spawnProvider,
} from "./provider-process";
import { providerWire, type ProviderFrame } from "./provider-wire";

type Transport = ReturnType<typeof spawnProvider>;
type Packet = {
  work: Effect.Effect<void>;
  acknowledge: Effect.Effect<unknown>;
};
export const project = (work: readonly Effect.Effect<void>[]) =>
  Effect.forEach(work, (step) => step, { discard: true });

export function failedAction(error: AdapterError) {
  if (error.code === "channel-closed") return closed;
  if (error.code === "rpc-rejected" || error.code === "write-queue-timeout")
    return refused(error.code, error.message);
  return inDoubt("unknown", error.code, error.message);
}

export const providerEnvelope = Effect.fn("provider.envelope")(function* (
  spec: StartSpec,
) {
  const clock = yield* Clock.Clock;
  return () => ({
    v: 1 as const,
    source: "provider" as const,
    session: spec.session,
    run: spec.run,
    at: clock.currentTimeMillisUnsafe(),
  });
});

export const closeProvider = (
  scope: Scope.Closeable,
  transport: Transport,
  onClose: () => void,
) =>
  Effect.cached(
    Effect.uninterruptible(
      Effect.sync(() => {
        onClose();
        transport.fence();
      }).pipe(
        Effect.andThen(Effect.exit(Scope.close(scope, Exit.void))),
        Effect.andThen(Effect.promise(transport.releaseOutcome)),
      ),
    ),
  );

export const providerSession = Effect.fn("provider.session")(function* (
  spec: StartSpec,
  transport: Transport,
  scope: Scope.Closeable,
  name: string,
  readName = name,
) {
  const events = yield* makeProviderEvents(name);
  events.open();
  const incoming = yield* providerWire(transport, scope, name, readName);
  const replies = yield* bestEffortReplies(transport, scope);
  const envelope = yield* providerEnvelope(spec);
  let opening = true;
  let ended = false;
  let current: Deferred.Deferred<void> | undefined;
  let seq = spec.afterSeq;
  const projectEvent = (emit: () => void) =>
    events.awaitSpace().pipe(Effect.andThen(Effect.sync(emit)));
  function durable(payload: DurablePayload, turn: string | null) {
    const stamp = envelope();
    return projectEvent(() =>
      events.emit({ ...payload, ...stamp, turn, seq: ++seq }),
    );
  }
  const isClosed = () => ended || incoming.error() !== undefined;
  const validFence = ({ run, fencing_token }: RunFence) =>
    run === spec.run && fencing_token === spec.fencing_token;

  function checkTurn(expected: SteerRequest["expected"], turn: string | null) {
    if (isClosed()) return closed;
    if (!validFence(expected) || expected.turn !== turn)
      return { status: "stale", observed: { kind: "turn", turn } } as const;
  }

  const close = yield* closeProvider(scope, transport, () => {
    ended = true;
  });

  const start = Effect.fn("provider.start-reader")(function* (
    receive: (frame: ProviderFrame) => Effect.Effect<Packet | undefined>,
    finish: (reason: string) => Effect.Effect<void>,
  ) {
    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => {
        ended = true;
        transport.fence();
      }).pipe(Effect.andThen(events.unsubscribe)),
    );
    yield* incoming.read(
      Effect.fn("provider.track-handshake")(function* (frame) {
        if (!frame.base64Fragment && !frame.line.trim()) return;
        const packet = yield* receive(frame);
        if (!packet || !opening) return packet;
        const projected = Deferred.makeUnsafe<void>();
        return {
          work: packet.work.pipe(
            Effect.tap(() => Deferred.succeed(projected, undefined)),
          ),
          acknowledge: Effect.sync(() => {
            current = projected;
          }).pipe(Effect.andThen(packet.acknowledge)),
        };
      }),
    );
    yield* Effect.forkIn(
      incoming.stopped.pipe(
        Effect.catch((error) =>
          error.code === "channel-ended"
            ? Effect.void
            : Effect.sync(transport.terminate),
        ),
      ),
      scope,
    );
    return yield* Effect.forkIn(
      incoming.projections.pipe(
        Stream.runForEach((work) => work),
        Effect.andThen(Effect.promise(() => transport.exit)),
        Effect.flatMap((reason) =>
          finish(reason).pipe(
            Effect.andThen(
              durable({ kind: "session.ended", body: { reason } }, null),
            ),
            Effect.andThen(events.end),
          ),
        ),
        Effect.onExit((exit) => {
          ended = true;
          return exit._tag === "Failure"
            ? incoming
                .stop(processError("channel-ended", `${name} output ended`))
                .pipe(
                  Effect.andThen(events.fail(exit.cause)),
                  Effect.tap(() => Effect.sync(transport.terminate)),
                )
            : Effect.void;
        }),
        Effect.ignoreCause,
      ),
      scope,
    );
  });

  const establish = Effect.fn("provider.establish")(function* <T>(
    projector: Fiber.Fiber<void>,
    handshake: Effect.Effect<T, AdapterError>,
  ) {
    const opened = yield* Effect.result(
      handshake.pipe(
        Effect.flatMap((value) => {
          const failure = incoming.error();
          return failure ? Effect.fail(failure) : Effect.succeed(value);
        }),
      ),
    );
    if (opened._tag === "Success") {
      opening = false;
      return opened.success;
    }
    yield* events.unsubscribe;
    yield* Effect.gen(function* () {
      let waited: typeof current;
      while (current && current !== waited) {
        waited = current;
        yield* Deferred.await(current).pipe(
          Effect.raceFirst(Fiber.await(projector)),
        );
      }
    }).pipe(Effect.timeoutOption("30 seconds"));
    const cleanup = yield* close;
    return yield* cleanup.status === "failed"
      ? processError("cleanup-uncertain", cleanup.message, opened.failure)
      : opened.failure;
  });

  function awaitReply<E = never>(
    rpc: Effect.Success<ReturnType<Transport["request"]>>,
    method: string,
    prepare?: () => Result.Result<void, E>,
  ) {
    return rpc
      .send<E | AdapterError>(() => {
        const failure = incoming.error();
        return failure
          ? Result.fail(failure)
          : (prepare?.() ?? Result.succeed(undefined));
      })
      .pipe(
        Effect.andThen(
          rpc.awaitResponse.pipe(
            Effect.timeoutOrElse({
              duration: "30 seconds",
              orElse: () =>
                Effect.fail(
                  processError("timeout", `${name} ${method} timed out`),
                ),
            }),
          ),
        ),
        Effect.raceFirst(incoming.stopped),
        Effect.ensuring(rpc.forget),
      );
  }

  function answer<Prompt extends { turn: string }>(
    prompts: Map<string, Prompt>,
    prepare: (
      prompt: Prompt,
      answer: EdgeJson,
    ) => Effect.Effect<{ wire: object; publicAnswer: EdgeJson } | undefined>,
  ) {
    return Effect.fn("provider.answer")(function* (
      request: AnswerRequest,
    ): Effect.fn.Return<ControlOutcome<"prompt">> {
      if (isClosed()) return closed;
      const { prompt_id } = request.expected;
      const prompt = prompts.get(prompt_id);
      const planned =
        prompt && validFence(request.expected)
          ? yield* prepare(prompt, request.answer)
          : undefined;
      const sent = yield* Deferred.make<boolean>();
      const written = yield* Effect.result(
        transport
          .write<ControlOutcome<"prompt">>(() => {
            if (isClosed()) return Result.fail(closed);
            if (
              !prompt ||
              prompts.get(prompt_id) !== prompt ||
              !validFence(request.expected)
            )
              return Result.fail({
                status: "stale",
                observed: {
                  kind: "prompt",
                  run: spec.run,
                  prompt_id: [...prompts.keys()].at(-1) ?? null,
                },
              });
            if (!planned)
              return Result.fail(
                refused(
                  "invalid-answer",
                  `Answer does not match the ${name} prompt`,
                ),
              );
            const settlement = {
              kind: "prompt.settled",
              body: { prompt_id, by: request.by, answer: planned.publicAnswer },
            } as const;
            if (
              !parseCanonicalEvent({
                ...envelope(),
                ...settlement,
                turn: prompt.turn,
                seq: 1,
              }).ok
            )
              return Result.fail(
                refused(
                  "invalid-answer",
                  "Answer is not a canonical prompt settlement",
                ),
              );
            if (
              !incoming.offer(
                Deferred.await(sent).pipe(
                  Effect.flatMap((wrote) =>
                    wrote ? durable(settlement, prompt.turn) : Effect.void,
                  ),
                ),
              )
            )
              return Result.fail(
                refused("output-overflow", `${name} event backlog is full`),
              );
            prompts.delete(prompt_id);
            return Result.succeed([planned.wire]);
          })
          .pipe(
            Effect.raceFirst(incoming.stopped),
            Effect.tap(() => Deferred.succeed(sent, true)),
            Effect.ensuring(Deferred.succeed(sent, false)),
          ),
      );
      return written._tag === "Success"
        ? inDoubt(
            "best-effort",
            "no-control-ack",
            `${name} does not acknowledge the prompt reply`,
          )
        : written.failure instanceof AdapterError
          ? failedAction(written.failure)
          : written.failure;
    });
  }

  return {
    events,
    incoming,
    start,
    establish,
    awaitReply,
    durable,
    envelope,
    projectEvent,
    checkTurn,
    close,
    answer,
    respond: (reply: object) =>
      Effect.sync(() => Queue.offerUnsafe(replies, reply)),
  };
});
