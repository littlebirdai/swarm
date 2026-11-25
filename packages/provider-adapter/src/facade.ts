import { makeFacade } from "@codecast/effect-kit/effect";
import type {
  OpenOutcome,
  OwnedSession,
  ProviderEvent,
  ProviderEventIterator,
  ResumeSpec,
  StartSpec,
} from "@codecast/provider-contract";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { AcpOwnedSession, ProviderAdapterClient } from "./index";
import { ProviderAdapter, providerAdapterLayer } from "./effect";
import {
  closed as closedOutcome,
  providerOffer,
  type ProviderAdapterOptions,
} from "./options";

class FacadeScope extends Context.Service<FacadeScope, Scope.Scope>()(
  "@codecast/provider-adapter/FacadeScope",
) {}

const facadeScopeLayer = Layer.effect(FacadeScope, Effect.scope);

export function createEffectAdapter(
  options: ProviderAdapterOptions,
): ProviderAdapterClient {
  const facade = makeFacade(
    Layer.merge(providerAdapterLayer(options), facadeScopeLayer),
  );

  let disposing: Promise<void> | undefined;

  async function open(
    spec: StartSpec | ResumeSpec,
    signal?: AbortSignal,
  ): Promise<OpenOutcome<AcpOwnedSession>> {
    if (disposing) throw new Error("Provider adapter is disposed");
    return facade.run(
      Effect.gen(function* () {
        const adapter = yield* ProviderAdapter;
        const scope = yield* FacadeScope;
        const result = yield* adapter.own(spec).pipe(Scope.provide(scope));
        if (result.status !== "opened") return result;
        const owned = result.session;
        const iterable = Stream.toAsyncIterable(owned.events);
        let closed = false;
        let claimed = false;
        let closing: ReturnType<OwnedSession["close"]> | undefined;
        const done: IteratorResult<ProviderEvent, undefined> = {
          done: true,
          value: undefined,
        };

        return {
          status: "opened",
          session: {
            mode: owned.mode,
            getCheckpoint: owned.getCheckpoint,
            getUnknownPayloadCount: owned.getUnknownPayloadCount,
            recoveredReceipts: owned.recoveredReceipts,
            events: {
              [Symbol.asyncIterator](): ProviderEventIterator {
                const iterator = iterable[Symbol.asyncIterator]();
                let returned = claimed;
                claimed = true;
                let waiting:
                  | Promise<IteratorResult<ProviderEvent, undefined>>
                  | undefined;
                return {
                  next() {
                    if (closed || returned || disposing)
                      return Promise.resolve(done);
                    const pull = async () => {
                      if (closed || returned || disposing) return done;
                      try {
                        const result = await iterator.next();
                        return result.done || closed || returned || disposing
                          ? done
                          : { done: false as const, value: result.value };
                      } catch (error) {
                        if (closed || returned || disposing) return done;
                        throw error;
                      }
                    };
                    const next = waiting ? waiting.then(pull, pull) : pull();
                    waiting = next;
                    void next.then(
                      () => {
                        if (waiting === next) waiting = undefined;
                      },
                      () => {
                        if (waiting === next) waiting = undefined;
                      },
                    );
                    return next;
                  },
                  async return() {
                    if (!returned) {
                      returned = true;
                      try {
                        await iterator.return?.();
                      } finally {
                        if (!disposing) await facade.run(owned.unsubscribe);
                      }
                    }
                    return done;
                  },
                };
              },
            },
            steer: (request, signal) =>
              closed || disposing
                ? Promise.resolve(closedOutcome)
                : facade.run(owned.steer(request), signal),
            interrupt: (request, signal) =>
              closed || disposing
                ? Promise.resolve(closedOutcome)
                : facade.run(owned.interrupt(request), signal),
            answer: (request, signal) =>
              closed || disposing
                ? Promise.resolve(closedOutcome)
                : facade.run(owned.answer(request), signal),
            close: () => {
              closed = true;
              return (closing ??= disposing
                ? disposing.then(
                    () => Effect.runPromise(owned.close),
                    () => Effect.runPromise(owned.close),
                  )
                : facade.run(owned.close));
            },
          },
        } as const;
      }),
      signal,
    );
  }

  return {
    provider: providerOffer(options.provider),
    observe: (spec, signal) =>
      facade.run(
        Effect.flatMap(ProviderAdapter, (adapter) => adapter.observe(spec)),
        signal,
      ),
    start: ({ session, run, afterSeq, cwd, fencing_token, options }, signal) =>
      open({ session, run, afterSeq, cwd, fencing_token, options }, signal),
    resume: open,
    dispose: () => (disposing ??= facade.dispose()),
  };
}
