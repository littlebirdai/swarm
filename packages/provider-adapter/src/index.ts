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

export interface AcpOwnedSession extends OwnedSession {
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

export interface ProviderAdapterClient extends ProviderContract {
  observe(
    spec: ObserveSpec,
    signal?: AbortSignal,
  ): Promise<OpenOutcome<ObservedSession>>;
  start(
    spec: StartSpec,
    signal?: AbortSignal,
  ): Promise<OpenOutcome<AcpOwnedSession>>;
  resume(
    spec: ResumeSpec,
    signal?: AbortSignal,
  ): Promise<OpenOutcome<AcpOwnedSession>>;
  dispose(): Promise<void>;
}

export function createProviderAdapter(
  options: ProviderAdapterOptions,
): ProviderAdapterClient {
  let runtime: Promise<ProviderAdapterClient> | undefined;
  let disposing: Promise<void> | undefined;
  async function load(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (disposing) throw new Error("Provider adapter is disposed");
    const loaded = await (runtime ??= import("./facade").then(
      ({ createEffectAdapter }) => createEffectAdapter(options),
    ));
    if (disposing) throw new Error("Provider adapter is disposed");
    return loaded;
  }

  return {
    provider: providerOffer(options.provider),
    observe: async (spec, signal) => (await load(signal)).observe(spec, signal),
    start: async (spec, signal) => (await load(signal)).start(spec, signal),
    resume: async (spec, signal) => (await load(signal)).resume(spec, signal),
    dispose: () =>
      (disposing ??=
        runtime?.then((adapter) => adapter.dispose()) ?? Promise.resolve()),
  };
}
