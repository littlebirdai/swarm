import { oneOf } from "./parse";

export const EDGE_PROTOCOL_VERSION = 1;
export const readV1 = oneOf(EDGE_PROTOCOL_VERSION);

export type EdgeVersionNegotiation =
  | { status: "ok"; version: number }
  | { status: "upgrade_required"; supported_versions: number[] };

export function negotiateEdgeVersion(
  daemonVersions: readonly number[],
  serverVersions: ReadonlySet<number>,
): EdgeVersionNegotiation {
  let version = 0;
  for (const candidate of daemonVersions) {
    if (Number.isSafeInteger(candidate) && candidate > version && serverVersions.has(candidate)) {
      version = candidate;
    }
  }
  if (version > 0) return { status: "ok", version };
  return { status: "upgrade_required", supported_versions: [...serverVersions].sort((a, b) => b - a) };
}
