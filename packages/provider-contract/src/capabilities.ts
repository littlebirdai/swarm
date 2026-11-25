const PROVIDER_CAPABILITIES = [
  "own",
  "receipts",
  "steer-mid-turn",
  "interrupt",
  "prompts",
  "resume",
] as const;

export type ProviderCapability = (typeof PROVIDER_CAPABILITIES)[number];

export interface ProviderIdentity {
  readonly agent: string;
  readonly version: string;
}

export interface ProviderOffer extends ProviderIdentity {
  readonly capabilities: readonly ProviderCapability[];
}

export function negotiateCapabilities(
  identity: ProviderIdentity,
  offers: readonly ProviderOffer[],
  allowed: readonly ProviderCapability[],
): ProviderOffer {
  const matching = offers.filter(
    (offer) =>
      offer.agent === identity.agent && offer.version === identity.version,
  );
  const shared = PROVIDER_CAPABILITIES.filter(
    (capability) =>
      matching.length > 0 &&
      allowed.includes(capability) &&
      matching.every((offer) => offer.capabilities.includes(capability)),
  );
  return {
    agent: identity.agent,
    version: identity.version,
    capabilities: shared.includes("own") ? shared : [],
  };
}
