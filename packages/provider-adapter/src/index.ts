import type {
  AnswerRequest,
  ControlOutcome,
  DeliveryOutcome,
  InterruptRequest,
  ObservedSession,
  ObserveSpec,
  OpenOutcome,
  OwnedSession,
  ProviderAdapter as ProviderContract,
  ResumeSpec,
  StartSpec,
  SteerRequest,
} from "@codecast/provider-contract";
import { providerOffer, type ProviderAdapterOptions } from "./options";

export type { ProviderAdapterOptions, RawProviderFrame } from "./options";

export interface ProviderOwnedSession extends OwnedSession {
  getUnknownPayloadCount(): number;
  steer(request: SteerRequest, signal?: AbortSignal): Promise<DeliveryOutcome>;
  interrupt(
    request: InterruptRequest,
    signal?: AbortSignal,
  ): Promise<ControlOutcome<"turn">>;
  answer(
    request: AnswerRequest,
    signal?: AbortSignal,
  ): Promise<ControlOutcome<"prompt">>;
}

export type AcpOwnedSession = ProviderOwnedSession;

export interface ProviderAdapterClient extends ProviderContract {
  observe(
    spec: ObserveSpec,
    signal?: AbortSignal,
  ): Promise<OpenOutcome<ObservedSession>>;
  start(
    spec: StartSpec,
    signal?: AbortSignal,
  ): Promise<OpenOutcome<ProviderOwnedSession>>;
  resume(
    spec: ResumeSpec,
    signal?: AbortSignal,
  ): Promise<OpenOutcome<ProviderOwnedSession>>;
  dispose(): Promise<void>;
}

export function createProviderAdapter(
  options: ProviderAdapterOptions,
): ProviderAdapterClient {
  let runtime: Promise<ProviderAdapterClient> | undefined;
  let disposing: Promise<void> | undefined;
  async function run<A>(
    operation: (adapter: ProviderAdapterClient) => Promise<A>,
    signal?: AbortSignal,
  ) {
    try {
      signal?.throwIfAborted();
      if (disposing) throw new Error("Provider adapter is disposed");
      runtime ??= import("./facade")
        .then(({ createEffectAdapter }) => createEffectAdapter(options))
        .catch((error: unknown) => {
          runtime = undefined;
          throw error;
        });
      const loaded = await runtime;
      signal?.throwIfAborted();
      if (disposing) throw new Error("Provider adapter is disposed");
      return await operation(loaded);
    } catch (error) {
      signal?.throwIfAborted();
      throw error;
    }
  }

  return {
    provider: providerOffer(options),
    observe: (spec, signal) =>
      run((adapter) => adapter.observe(spec, signal), signal),
    start: (spec, signal) =>
      run((adapter) => adapter.start(spec, signal), signal),
    resume: (spec, signal) =>
      run((adapter) => adapter.resume(spec, signal), signal),
    dispose: () =>
      (disposing ??=
        runtime?.then(
          (adapter) => adapter.dispose(),
          () => {},
        ) ?? Promise.resolve()),
  };
}
