// The vault index moved to @codecast/vault when the CLI needed the same
// name resolution, backlinks and tag lookups the web index worker builds — an
// agent typing `cast files cat sleep` must land on the file `[[Sleep]]` would.
// This re-export keeps every existing `lib/vault/vaultIndex` import working;
// the implementation lives at packages/vault/src/vaultIndex.ts.
export * from "@codecast/vault";
