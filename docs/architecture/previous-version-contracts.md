# Previous-version contract checks

The server must continue to serve clients and machines that run the previous
released version of each versioned wire contract.

## Covered boundaries

- Edge contract: `packages/edge-contract/src` and the `/edge/v1/...` routes in
  `apps/server/convex/lib/edge/routes.ts`.
  - Frozen N-1 schema and fixtures: `packages/edge-contract/test/n-1`.
  - Schema and verb guard: `packages/edge-contract/test/n-1-compat.guard.test.ts`.
  - Server route compatibility test: `apps/server/convex/edgePreviousVersion.test.ts`.
- Relay contract: `packages/relay-contract/src` and the WebSocket relay server.
  - Frozen N-1 schema and fixtures: `packages/relay-contract/test/n-1`.
  - Schema and frame guard: `packages/relay-contract/test/n-1-compat.guard.test.ts`.
  - Relay server compatibility test: `apps/relay/src/previous-version.test.ts`.

The `.github/workflows/ci.yml` workflow runs the guards in `test-always` and
`test-shared`. It also runs the relay server test in `test-shared` and the edge
server route test in `test-convex`.

## Three-step rule for breaking changes

Never remove or rename an N-1 field, verb, or frame type in one step. Make the
change in three steps:

1. **Expand**: add the new field, verb, or frame type while continuing to accept
   and emit the N-1 shape.
2. **Migrate**: deploy the server and wait until clients and machines upgrade
   past the previous release.
3. **Contract**: refresh the N-1 baseline when you create the next release, then
   remove the old field, verb, or frame type.

## Refreshing the N-1 baseline at release time

When you create a release from a clean commit `<release-sha>` (the merge base of
the release):

1. Freeze the edge contract release directory when creating an edge release:

   ```bash
   bun --no-env-file scripts/ci/freeze-edge-contract.ts <release-version>
   ```

2. Refresh both N-1 baselines from that release commit. This script also formats
   the frozen files before it computes the manifest hashes:

   ```bash
   bun scripts/ci/refresh-n-1-baselines.ts --rev <release-sha>
   ```

3. Verify formatting, all contract guards, and both server compatibility
   tests:

   ```bash
   bun run format:check
   bun test packages/edge-contract/ packages/relay-contract/
   cd apps/server && bun test convex/edgePreviousVersion.test.ts
   cd apps/relay && bun test src/previous-version.test.ts
   ```

4. Commit the refreshed `packages/edge-contract/test/n-1` and
   `packages/relay-contract/test/n-1` directories with the release change.
