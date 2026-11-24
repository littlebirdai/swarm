// The vault search query grammar moved to @codecast/vault when the CLI
// needed the same `tag:` / `path:` / `file:` operators the search pane parses —
// one grammar, so a query typed in the browser means the same thing in
// `cast files search`. This re-export keeps every existing
// `lib/vault/searchQuery` import working; the implementation lives at
// packages/vault/src/searchQuery.ts.
export * from "@codecast/vault";
