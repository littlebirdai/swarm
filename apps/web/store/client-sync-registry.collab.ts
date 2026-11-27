import type { ClientSyncRegistryEntry } from "./clientSyncRegistry";

export const COLLAB_SYNC_COLLECTIONS = {
  collabAccess: {
    localFirst: true,
    sync: { isDelta: true },
    feeds: ["collab.mySendAccess"],
  },
  collabRequests: {
    localFirst: true,
    sync: { isDelta: true },
    feeds: ["collab.collabRequests"],
  },
  fencedSteerClaims: {
    localFirst: true,
    sync: {
      isDelta: true,
      deepFields: ["holder", "turn", "queue"],
      ignoreFields: ["fresh_for_ms"],
    },
    feeds: ["collab.steerClaimState"],
  },
} satisfies Record<string, ClientSyncRegistryEntry>;
