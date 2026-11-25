# apps/server

Swarm production deploys are paused. The manual GitHub Actions workflow and the dev watcher are described in the root `CLAUDE.md`, which also covers workspace access rules. This file covers tests and the typecheck failures specific to Convex code.

## Tests

**Run tests from this directory.** `bun test convex/<file>.test.ts`, or `bun run test` for what CI runs (`bun test convex/ scripts/`).

**Use the server test helpers.** Start function tests with `serverTest()` from `test-helpers/database.testkit.ts`. It enables schema validation and loads all Convex function modules. Call functions through `api` or `internal`. Use `asUser` for account calls.

**Insert fixtures with `fixtureRows(db, seed)`.** Set the fields the test checks or uses to select rows. The seeded faker supplies the other values. Use a distinct seed for each fixture builder in a database. Keep fixtures in `test-helpers/*.testkit.ts` outside the Convex module tree. A name with two dots keeps the Convex bundler from deploying a testkit, which matters because testkits use Bun APIs the Convex runtime lacks.

**Check persisted results.** Read the rows or scheduled jobs that the function writes. Use transaction limits for function read budgets. Use `countDatabaseReads` for a helper that receives a database reader.

**Every entry module must load on its own.** `convex/moduleLoad.test.ts` loads each of the ~200 entry modules in its own process. Run it after adding an import between Convex modules. Two rules it enforces:
- Never use `import()` in `convex/`. The runtime refuses it at call time (`dynamic module import unsupported`), and typecheck and the pusher stay green; a day of shares failed in prod this way on 2026-09-22.
- Nothing reachable from `convex/functions.ts` may import a module that defines functions at load. A static import on that cycle throws `Cannot access 'mutation' before initialization` in every entry that loads it. Break a cycle by moving the pure part into a leaf, as `lib/accessKeys.ts` does for `lib/access.ts`.

**An action that runs a query from its own module needs explicit return types.** Without them inference loops through the generated `api` types and `cast check cli` and `cast check web` fail with TS7022 on the action, then with implicit-any errors in files nobody touched, while `cast check convex` may pass. Give both handlers explicit `Promise<T>` return types and annotate the `ctx.runQuery` result. When implicit-any errors appear in untouched files, look for a new action/query pair first.

**Build credential-shaped test strings at runtime.** GitHub push protection rejects a push containing a Stripe-shaped literal such as `"sk_live_..."`, fake ones included (it blocked `secrets.test.ts` and `passkeys.test.ts`). Split the prefix (`"sk_" + "live_..."`), as `convex/secrets.test.ts` does, or generate the body as `apps/cli/src/secretPatterns.test.ts` does.
