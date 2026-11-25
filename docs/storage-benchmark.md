# Storage benchmark results

**Chromium and Electron both passed.** The overall verdict is incomplete. Safari was already open and the runner requires an isolated profile. The runner found no Firefox executable.

The run used 150,000 synthetic rows, 20 timing trials per engine, and 20 separate SQLite profiling trials per browser. Chrome for Testing 131.0.6778.204 and Electron 44.3.0 ran on an Apple M6 with 12 logical CPUs. The product baseline was commit `770984a0e`.

The Chromium load averages at start were 4.16, 6.05, 5.93. Electron started at 3.67, 5.62, 5.78. CPU idle was 89% before the run. The run held the shared heavy lock.

## Timing

| Measure                        | Chromium Dexie p50 / p95 (ms) | Chromium SQLite p50 / p95 (ms) | Electron Dexie p50 / p95 (ms) | Electron SQLite p50 / p95 (ms) |
| ------------------------------ | ----------------------------: | -----------------------------: | ----------------------------: | -----------------------------: |
| Connection or worker ready     |                     1.8 / 2.2 |                    20.9 / 22.3 |                     2.6 / 3.0 |                    21.3 / 30.5 |
| Paint read after ready         |                   11.3 / 13.3 |                      3.3 / 3.5 |                   10.3 / 17.4 |                      3.3 / 3.6 |
| Full boot                      |                 634.2 / 681.9 |                  362.0 / 431.4 |                 580.9 / 621.4 |                  307.9 / 336.3 |
| Main-thread time, 20-row write |                     0.2 / 0.3 |                      0.0 / 0.0 |                     0.2 / 0.3 |                      0.0 / 0.1 |
| 20-row write saved             |                    1.3 / 28.9 |                      6.7 / 9.2 |                    1.6 / 16.3 |                      6.6 / 7.9 |
| Retention, 2,000 rows          |                   85.0 / 98.8 |                    13.6 / 20.5 |                  93.3 / 106.7 |                    13.3 / 14.1 |
| Two-window handoff             |                     3.0 / 3.6 |                    23.5 / 27.4 |                     3.5 / 4.2 |                    24.1 / 28.1 |

A 0.0 ms reading means the browser clock did not advance during the sample.

## Memory, file size, and recovery

| Browser  | Worker memory live max (MiB) | Worker memory transient max (MiB) | WASM max (MiB) | Dexie files (MiB) | SQLite database / pool (MiB) | Dirty pages spilled |
| -------- | ---------------------------: | --------------------------------: | -------------: | ----------------: | ---------------------------: | ------------------: |
| Chromium |                         21.6 |                              27.4 |           20.1 |             248.1 |                214.7 / 214.8 |                  86 |
| Electron |                         22.2 |                              32.8 |           20.1 |             250.3 |                214.7 / 214.8 |                  86 |

Both engines preserved the committed rows across handoff and interruption in both browsers. SQLite passed `quick_check` after each interrupted write.

The 35 MiB limit applies to the live maximum after forced garbage collection. The transient maximum uses the same limit for comparison. The separate profiling pass samples after open, paint, critical reads, full boot, and retention. These checkpoints measure the worker heap and WASM. Native process RSS and peaks between checkpoints are outside the measurement.

## Differences between the engines

- Dexie paint includes all 1,200 sessions and the focused transcript. SQLite paint includes 134 live sessions and the same transcript. SQLite full boot reads the remaining rows in 1,000-row keyset batches. This removes the earlier full-result allocation and still delivers 150,000 rows to the page.
- Dexie uses the product's patch and persistence path. SQLite submits the same 20 rows through a worker message and commits with FULL synchronous mode. The latency includes each engine's own transaction path.
- Dexie retention deletes known IDs. SQLite retention finds the same 2,000 rows by index. The SQLite handoff includes creation of a fresh worker and pool, while Dexie reopens its database directly.
- The Dexie interruption closes a window with an open IndexedDB transaction. The SQLite interruption terminates a worker after the pager confirms dirty-page spills. The SQLite test enlarges its ten staged rows to force the spill.
- The Dexie file size comes from the profile after the trials. SQLite reports the logical database and pool sizes after the seed.

See the [run instructions](../apps/web/perf/storage/README.md) and [machine-readable results](../apps/web/perf/storage/macos-results.json).
