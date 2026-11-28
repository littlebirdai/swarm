export const RELAY_PROTOCOL_VERSION = 1;
export const RELAY_SUPPORTED_VERSIONS: readonly number[] = [
  RELAY_PROTOCOL_VERSION,
];

export function negotiateRelayVersion(
  offered: readonly number[],
  supported: readonly number[] = RELAY_SUPPORTED_VERSIONS,
): number | null {
  let selected: number | null = null;
  for (const version of supported) {
    if (
      Number.isSafeInteger(version) &&
      version > (selected ?? 0) &&
      offered.includes(version)
    ) {
      selected = version;
    }
  }
  return selected;
}
