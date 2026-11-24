// The vault markdown indexing parser moved to @codecast/vault when the
// daemon's Convex mirror needed the same note metadata the index worker builds.
// This re-export keeps every existing `lib/vault/parseNote` import working; the
// implementation (and its doc comment explaining why it isn't remark) lives at
// packages/vault/src/parseNote.ts.
export * from "@codecast/vault";
