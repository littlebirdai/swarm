# Store slices for inboxStore

`apps/web/store/inboxStore.ts` composes domain slices under `apps/web/store/slices/`. Every slice keeps the store's public API and mutation pipeline unchanged.

## File layout and naming

- Place each new slice in `apps/web/store/slices/<domain>-slice.ts` using kebab-case file names.
- Keep each slice file under 800 lines.
- Add no code comments (`swarm/no-comments`). Explain design rules in architecture docs or clear symbol names.
- Use relative imports, never `@/`, and never `import.meta`. The mobile app bundles `apps/web/store/inboxStore.ts` with Metro, which resolves `@/` to the mobile root and rejects `import.meta`.
- Keep no top-level mutable bindings (`let`, `var`, `new Map`, `new Set`) in a slice so simulated windows stay isolated.

## Slice contract

Each slice module owns one domain's state keys, types, helpers, and mutators:

1. Export `<Domain>SliceState` with the domain's initial state fields and types.
2. Export `<Domain>SliceActions` with the domain's action and selector signatures.
3. Export `<Domain>Slice = <Domain>SliceState & <Domain>SliceActions`.
4. Export `create<Domain>Slice(set, get)` (or omit unused `set`/`get` parameters) returning the domain's initial state and functions.
5. Wrap every store mutation with `action()`, `asyncAction()`, `receiptAsyncAction()`, or `sync()` from `apps/web/store/mutativeMiddleware.ts`. Use raw `set()` only for ephemeral UI or media state that never persists or dispatches.
6. When the domain owns store-level `SyncOpts` entries, export `<DOMAIN>_SYNC_OPTS` and spread it into `STORE_SYNC_OPTS` in `apps/web/store/inboxStore.ts`. All incoming data still flows through `syncTable`, `syncRecord`, and `syncOverlay`.
7. When a `receiptAsyncAction()` needs a rejection rollback in `_handleReceiptRejection`, export a pure draft helper from the slice and call it from `_handleReceiptRejection`.
8. Never import `apps/web/store/inboxStore.ts` from a slice. Define a narrow `<Domain>Draft` type for the draft fields the slice reads or writes.

## Composing into inboxStore

In `apps/web/store/inboxStore.ts`:

1. Import `create<Domain>Slice`, `<Domain>Slice`, and any `<DOMAIN>_SYNC_OPTS` or helpers.
2. Extend `InboxStoreState` with `<Domain>Slice`, and add `keyof <Domain>Slice` to the `Omit<RegisteredCollectionSlots, ...>` clause if the slice narrows any key from `apps/web/store/clientSyncRegistry.ts`.
3. Spread `...create<Domain>Slice(set)` (or `(set, get)`) inside `inboxStoreConfig`, keeping the `storeHmr` markers in `apps/web/plugins/storeHmr.ts` intact.
4. Do not add re-export shims for moved internal helpers. Update any caller or guard test to import from the slice directly.
5. Lower the line pin for `apps/web/store/inboxStore.ts` in `packages/ratchet/max-lines-baseline.txt` to match the new line count.

`apps/web/store/slices/calls-slice.ts` is the reference implementation of this pattern.
