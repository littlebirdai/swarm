// Ephemeral store slots — never persisted, so never registry keys — that must
// still agree across windows. The liveness payload's projection slot: its
// stamps, epoch and receipt clock gate every window's placement (the
// overlay-coverage rule, sync-convergence), and only the host subscribes to
// the overlay. A follower without the slot buckets every row by the
// client-only sweep and disagrees with its host on the rows the payload
// vouches for (found by the multi-window simulation, 2026-09-02).
export const REPLICATED_EPHEMERAL_KEYS = [
  "sessionsProjection",
  "scopeRevocations",
] as const;
