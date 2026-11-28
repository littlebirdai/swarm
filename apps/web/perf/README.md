# Web perf benches

Benchmarks of the web app's hot paths, each with two halves:

- **Counts that must be exact** (`scripts/perf-budgets.sh`, run in CI). What an action may cost, independent of machine speed: requests asked, subscriptions opened, store writes, React commits, DOM changes, forced layouts.
- **A/B timing** (`scripts/perf-bench.sh`), with [strobe](https://github.com/Hona/strobe) 0.17 at a pinned version. It compares two builds in pairs of fresh processes (A B, B A, ...), decides one primary metric per case with a confidence interval, and compares every count exactly between base and head.

Both drive `harness.tsx`: the real components mounted in jsdom over a synthetic cache, with a Convex client that answers nothing and counts what it is asked. The harness runs under plain `bun` (strobe's script host), so it uses no `mock.module` and no test preload. The diff case therefore draws with the real `@pierre/diffs` viewer.

| Case                                                                                     | Workload                                                                                                                                                                                                                                                  | Exact counts (budgets.ts)                                                                    |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| switch conversation (warm)                                                               | Two conversations with 200 distinct cached messages each, both visited, over 2,000 sessions; switch until the last answer is on screen                                                                                                                    | 0 one-shot fetches, 14 subscriptions opened, 0 store writes, 81 DOM mutation records         |
| a message arrives in an open conversation                                                | One conversation of 200 cached messages on screen, over 2,000 sessions; one more row appended through `mergeMessages` (the path a streamed answer takes) until its text is drawn                                                                          | 1 store write, 0 fetches, 0 subscriptions opened                                             |
| load an inbox of 5000 sessions                                                           | `SessionListPanel` mounting over 5,000 sessions                                                                                                                                                                                                           | 51 cards drawn, 2 subscriptions, 0 fetches                                                   |
| heartbeat in an inbox of 5000 sessions                                                   | A liveness overlay payload (`applyMineLivenessPayload`) shaped like the server's: the viewer's 600 newest sessions, each with its facts and placement stamps, plus the projection envelope, all freshly decoded; only one drawn session's heartbeat moved | 0 commits, 0 DOM mutations, 0 layout reads                                                   |
| the same two, Modern style (`inbox-load-modern`, `inbox-heartbeat-modern`; budgets only) | The panel under the Modern theme context, drawing `ModernSessionCardView` and its section header                                                                                                                                                          | the same counts: 51 cards, 2 subscriptions; 0 commits, 0 DOM mutations, 0 layout reads       |
| open a long diff                                                                         | A 1,560-line TypeScript file with 52 changed lines, shown whole and highlighted, in a warm app, mounted at the top of a scroller a viewport (800px) tall                                                                                                  | 2 commits, 18 DOM mutation records, 32 layout reads, 0 store writes, 150 of 1,612 rows drawn |

The warm-switch fixture leaves server authentication unconfirmed. The collaboration request feeder waits for confirmation, so the switch opens one fewer subscription than the former direct query.

The budgets also check that a rename arriving through the feed reaches its card.

DOM mutations are counted under the mounted tree and inside every shadow root from the moment it is attached (the harness wraps `attachShadow`). The diff viewer draws its lines in a shadow root outside React, so the diff's 18 records are its host going in plus the viewer's own draw; a redraw would add to them. A diff over 200 rows draws windowed (`components/diff/virtualizer.ts`): the harness gives that diff's scroller (`data-perf-viewport`) the viewport's height and reports each element the Virtualizer observes as on screen, as a browser's IntersectionObserver does on observe. The 32 layout reads are the windowing's own: finding the scroller and measuring it and the file's offset in it.

## Store budgets

The CI budget job runs these checks in fresh processes. Run only the store
checks with `bun perf/budgets.ts store`, the first paint checks with
`bun perf/budgets.ts boot`, and the memory/replay/desktop-panel checks with
`bun perf/budgets.ts memory`, from `apps/web`.

| Budget                                 |   Measured |      Limit | Fixture                                                                                                                           | Deliberate regression and failing value        |
| -------------------------------------- | ---------: | ---------: | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Task list bytes                        | 14,661,183 | 14,807,795 | 7,919 tasks with synthetic comment threads from `detail-rows-size.ts`                                                             | Keep comment threads on task rows → 32,019,997 |
| Task comment detail bytes              |  2,161,087 |  2,182,698 | 756 problem threads held in `taskComments` from `detail-rows-size.ts`                                                             | Hold all 4,467 threads or drop detail split    |
| Pull request list bytes                |    227,623 |    229,900 | 253 pull requests with synthetic patches, commits and checks from the same fixture                                                | Keep details on pull request rows → 34,354,946 |
| Pull request detail bytes              |  1,411,989 |  1,426,109 | First 12 opened pull requests held at `MAX_CACHED_PULL_REQUEST_DETAILS` from `detail-rows-size.ts`                                | Raise `DETAIL_ROW_CAPS.pullRequestDetails`     |
| Doc list bytes                         |    470,671 |    475,378 | 1,000 calibrated docs with legacy `content`, `entries` and `embedding` hydrated through `loadCache`                               | Skip `docs.hydrateRow` → 9,042,561             |
| Doc detail bytes                       |  1,639,891 |  1,656,290 | 220 doc details carrying `embedding` hydrated through `loadCache` (capped at 200)                                                 | Keep `embedding` or skip retention             |
| Session list bytes                     |    188,491 |    190,376 | 1,200 calibrated sessions carrying `INBOX_PROJECTION_FIELDS` synced via `syncTable`                                               | Remove `stripFields` on `sessions` → 345,691   |
| Conversation meta bytes                |    380,491 |    384,296 | 1,200 calibrated conversation meta rows synced via `syncTable`                                                                    | Add an unstripped diff or heavy field          |
| External event list bytes              |    818,001 |    826,182 | 2,000 calibrated `externalEvents` rows synced via `syncTable`                                                                     | Add an unstripped heavy field                  |
| My sends list bytes                    |  3,410,001 |  3,444,102 | 10,000 calibrated `mySends` rows synced via `syncTable`                                                                           | Keep full message payload on rows              |
| Deploy reach bytes                     |     70,501 |     71,207 | 320 calibrated `deployReach` rows synced via `syncTable` (evicted to `DETAIL_ROW_CAPS.deployReach`, 300)                          | Skip detail cap eviction                       |
| Run graph bytes                        |     20,921 |     21,131 | 60 calibrated `runGraphs` rows synced via `syncTable` (evicted to `DETAIL_ROW_CAPS.runGraphs`, 40)                                | Skip detail cap eviction                       |
| Deploy detail bytes                    |     30,401 |     30,706 | 70 calibrated `deploys.get` answers fed through `deployDetailRows` (stripped and evicted to 50)                                   | Keep `commits` or skip cap eviction            |
| Settings data bytes                    |        915 |        925 | Calibrated `settingsData` payloads synced via `syncTable`                                                                         | Keep oversized payload or heavy field          |
| Cached conversation message rows       |     22,750 |     22,750 | Load 400 conversations with 250 messages each                                                                                     | Skip eviction → 100,000                        |
| Cached conversation message bytes      | 27,910,610 | 33,554,432 | Load the same messages with one 128 KiB inline image per conversation                                                             | Skip eviction → more than 33,554,432           |
| Cached conversation message JSON bytes | 13,488,375 | 16,777,216 | Measure UTF-8 JSON for the transcript and navigator maps                                                                          | Undercount strings and admit all rows          |
| Retained sessions                      |      1,200 |      1,200 | 1,300 recent rows                                                                                                                 | Skip session retention → 1,300                 |
| Retained conversations                 |      1,200 |      1,200 | 1,300 recent rows                                                                                                                 | Skip conversation retention → 1,300            |
| Retained docDetails                    |        200 |        200 | 220 recent rows                                                                                                                   | Raise the cap by one → 201                     |
| Retained taskComments                  |      1,500 |      1,500 | 1,600 recent rows                                                                                                                 | Raise the cap by one → 1,501                   |
| Retained pullRequestDetails            |         12 |         12 | 24 recent rows                                                                                                                    | Raise the cap by one → 13                      |
| Retained deployReach                   |        300 |        300 | 320 recent rows                                                                                                                   | Raise the cap by one → 301                     |
| Retained runGraphs                     |         40 |         40 | 60 recent rows                                                                                                                    | Raise the cap by one → 41                      |
| Retained deployDetails                 |         50 |         50 | 70 recent rows                                                                                                                    | Raise the cap by one → 51                      |
| Retained externalEvents                |      2,000 |      2,000 | 2,100 recent rows for one team                                                                                                    | Raise the cap by one → 2,001                   |
| Retained settingsData                  |          1 |          1 | One current row and one retired row                                                                                               | Keep the retired row → 2                       |
| Retained mySends                       |     10,000 |     10,000 | 10,100 recent rows                                                                                                                | Raise the cap by one → 10,001                  |
| First paint read groups                |         21 |         21 | Signed-in boot with a cached conversation in focus                                                                                | Move tasks to the critical phase → 22          |
| First paint IndexedDB tables           |         20 |         20 | Same boot                                                                                                                         | Read deferred tasks without timing → 21        |
| First paint IndexedDB rows             |      2,822 |      2,822 | 1,300 sessions and their twins, a 200-message focused transcript, one row per other collection and system metadata                | Read sessions twice → 4,122                    |
| Streamed batch row writes              |          4 |          4 | Edit the newest message and append one to a full 200-row tail, with one eviction and one metadata write                           | Rewrite all 200 messages → 202                 |
| Rename action row writes               |          4 |          4 | Rename one of 500 sessions with matching conversation rows. Save both rows, the pending lock map and the outbox entry             | Rewrite all 500 conversation rows → 503        |
| Follower populated collections         |        138 |        138 | Receive a host snapshot with a synthetic row in every registered collection and in conversations                                  | Share the local repoBrowse map → 139           |
| Main window populated collections      |        138 |        138 | Unscoped replication follower on the same 138-collection snapshot                                                                 | Share a local-only key → 139                   |
| Palette populated collections          |         39 |         39 | Scoped palette follower on the same snapshot, required below main window                                                          | Disable panel scoping → 138                    |
| People populated collections           |         16 |         16 | Scoped people follower on the same snapshot, required below main window                                                           | Disable panel scoping → 138                    |
| Call panel populated collections       |         49 |         49 | Scoped call-panel follower on the same snapshot, required below main window                                                       | Disable panel scoping → 138                    |
| Agent dock populated collections       |         14 |         14 | Scoped agent-dock follower on the same snapshot, required below main window                                                       | Disable panel scoping → 138                    |
| Persisted IndexedDB rows after replay  |     18,186 |     18,186 | Hydrate over-cap cache, replay deltas, detail splits, liveness ticks, rename + echo, meta write, and five 250-message transcripts | Skip `persistedMessageTail` cap → 18,436       |

The byte limits for synced collections add 1% for small changes to the
row shape. The count limits (retained rows, populated collections per window,
and persisted IndexedDB rows after replay) add zero rows, collections, or tables. The retention fixture
omits exceptions such as pinned sessions that can exceed a cap.

The message cache uses 32 MiB per desktop window to leave room for other
windows. The phone uses 16 MiB to leave room for the native app and decoded
images. Above the cap, eviction targets 75% of the budget. The estimate
includes strings, row objects, and navigator pages. After the first byte-budget eviction,
background warming stops loading older history and only cold-loads the top 10
inbox rows that it has never cold-loaded for the current account.
Open transcripts, active streams, and conversations with unsent messages can
exceed the limit. The fixture has no protected conversations. Three quarters
of its images also have a storage ID. The store keeps inline-only images for
offline use and includes their bytes in the estimate.

Byte counts for task and pull request rows measure UTF-8 JSON. IndexedDB counts
come from fake IndexedDB through Dexie. Boot counts row values that reach
Dexie before the store marks client state ready. The logical names come from
the critical storage timing sample. Pending input and metadata use separate
names and share a table. Writes count individual inserts, updates and deletes
before a server acknowledgment. These checks use no elapsed time or heap
measurements.

## What the timing measures

The primary is `cpu.work`: CPU time of the bench process during the action. That covers React, the store and the app's own code, plus jsdom's DOM work. It leaves out style, layout and paint, which jsdom does not do, so it is not the browser's main-thread time. Because jsdom's DOM operations are slower than a browser's, DOM-heavy cases are dominated by jsdom: opening the long diff costs about 6 s of CPU here and much less in Chrome. A/B differences still point the right way because both sides pay the same jsdom cost. React also runs its development build here (plain bun leaves `NODE_ENV` unset, and `act()` and `<Profiler onRender>` need the development build), so `cpu.work` includes development-only work such as owner stacks and warnings that production never pays. Page-level cases (strobe `web()` targets in a real Chromium, measuring `main.work`, layout shift and frames) would need the app to boot offline against a mocked backend, which it cannot do today.

Commits and layout reads in the switch case depend on wall time, because the transcript's interval timers (the 1 s size reconciler, the 350 ms scroll hold) tick while it settles. They are compared between base and head but not asserted.

The append case is the re-render memoization exists for: one row is new and nothing else on the page has anything new to show. Its commits (6 or 7), DOM mutation records and layout reads follow the transcript's timers like the switch's, so they are compared, not asserted.

## Sync delivery budgets

Run `bun perf/budgets.ts sync` from `apps/web`. The CI budget job runs this check in a fresh process.

The save-to-screen fixture edits a short title on a cached personal document. Every measured edit must use one `syncLog:getHeads` query and one `syncLog:getRange` query. The fixture allows zero refetch queries and verifies that the client applies the edit.

| Response           | Measured bytes | Limit in bytes |
| ------------------ | -------------: | -------------: |
| `syncLog:getHeads` |             88 |             96 |
| `syncLog:getRange` |            446 |            480 |

The test measures Convex JSON response bytes. The count excludes socket framing. The Convex outbox test limits the scheduled delay to 25 ms. The probe reports elapsed time separately because the machine load changes the latency.

## Nightly window JS heap check

Real JS heap size depends on Bun/JSC GC layout and varies slightly across runs, so it stays outside CI's exact-count budgets and runs through the nightly check script from `apps/web`:

```sh
scripts/heap-budgets.sh          # human-readable table; exits non-zero past any threshold
bun perf/heap-budgets.ts --json  # machine-readable JSON report
```

Each window runs in a fresh subprocess, triggers a full GC (`Bun.gc(true)`), and measures `heapStats().heapSize` delta (`heapBytes`) after populating its store. Small desktop windows (`palette`, `people`, `call-panel`, `agent-dock`) run on the same 80-row-per-collection replication fixture as `main` and must stay both under their own threshold and below `main`. `main-account` loads the calibrated fixture account (`detail-rows-size.ts`, 1,000 thin docs, retained collections from `store-budget-fixture.ts`, and 400 conversations bounded by the 32 MiB message cache budget).

| Window         | Keys | Typical heap | Threshold | Deliberate regression and failing value |
| -------------- | ---: | -----------: | --------: | --------------------------------------- |
| `main`         |  138 |      9.2 MiB |  12.0 MiB | Unbounded replication payload           |
| `palette`      |   39 |      3.1 MiB |   4.5 MiB | Disable panel scoping → ~9.2 MiB        |
| `people`       |   16 |      1.8 MiB |   3.0 MiB | Disable panel scoping → ~9.2 MiB        |
| `call-panel`   |   49 |      3.9 MiB |   5.5 MiB | Disable panel scoping → ~9.2 MiB        |
| `agent-dock`   |   14 |      1.6 MiB |   3.0 MiB | Disable panel scoping → ~9.1 MiB        |
| `main-account` |   14 |     54.0 MiB |  72.0 MiB | Skip message eviction → ~102.7 MiB      |

## React Compiler

The Vite build compiles the files on the allowlist in `plugins/reactCompiler.ts`; plain bun compiles nothing. `REACT_COMPILER=1` makes the harness load those files compiled (`test-helpers/reactCompiler.ts`, the same list and options), so every command below can be run with the compiler on, and `perf/compilerAB.ts` compares the two directly:

```sh
REACT_COMPILER=1 scripts/perf-budgets.sh                  # the exact counts, compiled
bun perf/compilerAB.ts --workload append                  # on against off: CPU, React render time, every count
bun perf/compilerAB.ts --workload switch --pairs 8 --runs 6
REACT_COMPILER_SOURCES=components/inbox/ bun perf/compilerAB.ts --workload inbox-load   # a candidate, before it joins the list
```

`compilerAB.ts` runs fresh processes in pairs with the order alternating and reports the median difference with a 95% interval, for CPU (what strobe calls `cpu.work`) and for the time React spent rendering (`detail.renderMs`, the harness Profiler's `actualDuration`). Measured on 2026-11-18 with the list as it was first written, 8 pairs:

| Case                                      | React render, off → on                              | CPU, off → on                                          |
| ----------------------------------------- | --------------------------------------------------- | ------------------------------------------------------ |
| a message arrives in an open conversation | 37.9 → 32.9 ms, -13.8% (95% -8.6 to -3.7 ms)        | 133.5 → 111.3 ms, -19.5% (95% -35.7 to -12.7 ms)       |
| switch conversation (warm)                | 42.3 → 40.8 ms, no difference (95% -5.4 to +5.7 ms) | 145.9 → 133.1 ms, no difference (95% -28.6 to +7.7 ms) |

Measured again the same day, 6 pairs, after `useRelativeTime` was changed to hand compiled rows a callback that moves with the clock: a message arriving renders in 39.6 → 34.5 ms, -12.3% (95% -5.7 to -3.4 ms); CPU 131.4 → 117.6 ms with an interval that reaches zero (-27.6 to +0.1 ms, taken at a load of 24).

The switch does not move, with this list or with every directory compiled (40.4 → 44.0 ms, no difference): a switch gives every row new content, so there is nothing for a cache to return, and the components that hold most of its render time (`ConversationView`, `MessageInput`, `MessageReviewImpl`, `UserPromptImpl`, `InboxConversation`) are ones the compiler leaves as written. `bun scripts/react-compiler-report.ts <files>` names the reason for each. Add a file to the list only after that report is clean for it and an A/B on a case that renders it shows a difference.

## Run

```sh
cd apps/web
scripts/perf-budgets.sh                                    # the exact counts, about 1.5 min
scripts/perf-bench.sh --check                              # each case once: does it still run?
scripts/perf-bench.sh                                      # origin/main vs this tree, every case
scripts/perf-bench.sh --base <ref> --filter "open a long diff"
scripts/perf-bench.sh --aa                                 # this tree on both sides: is the method sound here?
bunx @hona/strobe@0.17.0 report experiment <exp_…> --open  # the report of a run
```

`perf-bench.sh` refuses a timed run when the 1-minute load is above the CPU count, because the intervals would only widen until nothing decides. `PERF_ALLOW_BUSY=1` runs anyway, and strobe reports the load beside the verdict. A git ref base gets its own worktree with `bun install --frozen-lockfile`; strobe places this checkout's `harness.tsx` in it, so the harness stays one file that imports only app code that exists on both sides.

## Add a case

Add a workload to `harness.tsx` (a `setup` that builds the world once and returns `run` and `reset`), a case in `web.bench.ts`, and its exact counts in `budgets.ts`. Seed the store through the producers the app uses (`syncTable`, `setMessages`): a raw `setState` skips what the first sync does at boot (view adoption, the conversations mirror), and that work then lands in the first measured run. A count is exact only if it holds in a fresh process at any machine speed. Run the budget a few times under load before you assert it, and leave counts that follow timers to the A/B comparison.
