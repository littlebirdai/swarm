export const effectZone =
  /^(?:apps\/relay|packages\/(?:effect-kit|edge-client|provider-adapter|delivery|edge-supervisor|relay|ext-host|ext-runner))(?:\/|$)/;

export const isEffectModule = (name) => name.startsWith("effect/");
export const isEffectEntry = (name) =>
  /^@codecast\/[^/]+\/effect(?:\/|$)/.test(name);
