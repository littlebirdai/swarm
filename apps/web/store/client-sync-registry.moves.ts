import type { ClientSyncRegistryEntry } from "./clientSyncRegistry";

export const MOVE_SYNC_COLLECTIONS = {
  migrationCandidates: {
    persistence: { kind: "meta", key: "migrationCandidates" },
    hydration: { phase: "deferred", merge: "fill" },
    sync: { kind: "list" },
    feeds: ["sessionMigrations.candidates"],
  },
  migrationBatches: {
    persistence: { kind: "meta", key: "migrationBatches" },
    hydration: { phase: "deferred", merge: "fill" },
    sync: { kind: "list", rowKey: "batch_id" },
    localFirst: true,
    unprotectedFields: ["rows", "queued", "cancelled", "state"],
    feeds: ["sessionMigrations.listBatches"],
  },
  forcedMoveOptions: {
    sync: { isDelta: true, deepFields: ["destinations"] },
    feeds: ["edgeRunLease.forcedMoveOptions"],
  },
} satisfies Record<string, ClientSyncRegistryEntry>;
