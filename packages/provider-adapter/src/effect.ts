import type {
  ObserveSpec,
  ResumeSpec,
  StartSpec,
} from "@codecast/provider-contract";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { openAcp } from "./acp-session";
import { openAppServer } from "./app-server-session";
import {
  inDoubt,
  providerOffer,
  refused,
  unsupported,
  type ProviderAdapterOptions,
} from "./options";

export { AdapterError } from "./provider-process";

const ownedLayer = (
  options: ProviderAdapterOptions,
  open: typeof openAcp | typeof openAppServer,
) =>
  Layer.effect(
    ProviderAdapter,
    Effect.sync(() => {
      const provider = providerOffer(options.provider);
      const own = Effect.fn("provider.own")(function* (
        spec: StartSpec | ResumeSpec,
      ) {
        const capability = "checkpoint" in spec ? "resume" : "own";
        if (!provider.capabilities.includes(capability))
          return unsupported(capability);
        const parent = yield* Scope.Scope;
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const scope = yield* Scope.fork(parent);
            const result = yield* Effect.result(
              restore(open(options, spec, scope)).pipe(
                Effect.onExit((exit) =>
                  exit._tag === "Failure"
                    ? Scope.close(scope, exit)
                    : Effect.void,
                ),
              ),
            );
            if (result._tag === "Success")
              return { status: "opened", session: result.success } as const;
            const { code, message } = result.failure;
            if (
              [
                "spawn-failed",
                "binary-missing",
                "initialize-failed",
                "invalid-options",
                "protocol-version",
                "agent-version",
                "rpc-rejected",
              ].includes(code)
            )
              return refused(code, message);
            if (code === "resume-unsupported") return unsupported("resume");
            return inDoubt("unknown", code, message);
          }),
        );
      });
      return {
        provider,
        observe: Effect.fn("provider.observe")(function* (_spec: ObserveSpec) {
          return yield* Effect.succeed(
            refused(
              "observe-unavailable",
              "Provider adapter opens owned sessions only",
            ),
          );
        }),
        own,
      };
    }),
  );

interface Service {
  readonly provider: ReturnType<typeof providerOffer>;
  readonly observe: (
    spec: ObserveSpec,
  ) => Effect.Effect<ReturnType<typeof refused>>;
  readonly own: (spec: StartSpec | ResumeSpec) => Effect.Effect<
    | {
        readonly status: "opened";
        readonly session: Effect.Success<ReturnType<typeof openAcp>>;
      }
    | ReturnType<typeof refused>
    | ReturnType<typeof unsupported>
    | (ReturnType<typeof inDoubt> & { readonly reason: "unknown" }),
    never,
    Scope.Scope
  >;
}

export class ProviderAdapter extends Context.Service<
  ProviderAdapter,
  Service
>()("@codecast/provider-adapter/ProviderAdapter") {}

export function providerAdapterLayer(
  options: ProviderAdapterOptions,
): Layer.Layer<ProviderAdapter> {
  const offer = providerOffer(options.provider);
  if (offer.capabilities.includes("own"))
    return ownedLayer(
      options,
      offer.agent === "codex" ? openAppServer : openAcp,
    );
  return Layer.effect(
    ProviderAdapter,
    Effect.succeed({
      provider: offer,
      observe: Effect.fn("provider.observe.unsupported")((_spec: ObserveSpec) =>
        Effect.succeed(
          refused(
            "observe-unavailable",
            "Provider adapter opens owned sessions only",
          ),
        ),
      ),
      own: Effect.fn("provider.own.unsupported")(
        (spec: StartSpec | ResumeSpec) =>
          Effect.succeed(unsupported("checkpoint" in spec ? "resume" : "own")),
      ),
    }),
  );
}
