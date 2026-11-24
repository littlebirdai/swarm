import { array, oneOf, positiveInteger, responseObject } from "./parse";

export const EDGE_PROTOCOL_VERSION = 1;
export const readV1 = oneOf(EDGE_PROTOCOL_VERSION);

const supportedVersions = { supported_versions: array(positiveInteger) };
export const readUpgradeRequired = responseObject({ status: oneOf("upgrade_required"), ...supportedVersions });
export const readServerBehind = responseObject({ status: oneOf("server_behind"), ...supportedVersions });

export type EdgeVersionNegotiation =
  | { status: "ok"; version: number }
  | ReturnType<typeof readUpgradeRequired>
  | ReturnType<typeof readServerBehind>;

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
  const supported_versions = [...serverVersions].sort((a, b) => b - a);
  const serverBehind = supported_versions.length > 0 && daemonVersions.length > 0 &&
    daemonVersions.every((offered) => offered > supported_versions[0]);
  return serverBehind
    ? { status: "server_behind", supported_versions }
    : { status: "upgrade_required", supported_versions };
}
