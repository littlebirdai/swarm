# Storage benchmark results

**The Electron gate failed.** The SQLite worker reached 386.5 MiB against a 35 MiB limit. All timed Electron targets passed. Both engines preserved the committed rows across the handoff and interrupted write.

The run used 150,000 synthetic rows and 20 trials per engine. Electron 44.3.0 ran on an Apple M6 with 12 logical CPUs. The load averages were 2.55, 4.14, and 4.75 before the run and 2.38, 3.93, and 4.65 afterward. CPU idle was 90% at start. The run held the shared heavy lock. The product baseline was commit `d71c19279`.

## Electron measurements

| Measure                        | Dexie p50 / p95 (ms) | SQLite p50 / p95 (ms) | Electron target         |
| ------------------------------ | -------------------: | --------------------: | ----------------------- |
| Connection or worker ready     |            2.3 / 2.6 |           20.1 / 21.0 | ≤ 200 ms worker p95     |
| Paint read after ready         |           9.7 / 17.1 |             3.1 / 3.3 | ≤ 60 ms and ≤ Dexie p95 |
| Full boot                      |        531.8 / 578.7 |         405.2 / 452.6 | —                       |
| Main-thread time, 20-row write |            0.2 / 0.3 |             0.0 / 0.1 | ≤ 2 ms p95              |
| 20-row write saved             |           1.5 / 15.9 |             5.5 / 7.8 | —                       |
| Retention, 2,000 rows          |          76.3 / 80.1 |           10.6 / 11.1 | ≤ 50 ms p95             |
| Two-window handoff             |            3.4 / 3.8 |           17.7 / 19.5 | ≤ 100 ms p95            |

- **Worker memory.** The p50 and p95 were 371.0 and 386.2 MiB. WASM linear memory was 20.1 MiB. Full boot sends all 150,000 rows to the page.
- **File size.** Dexie used 265.5 MiB in LevelDB files after the trials. SQLite used 214.7 MiB for the database and 214.8 MiB for the OPFS pool after seed.
- **Recovery.** After restart, each engine returned the previous versions of all 20 changed rows and the full row count. SQLite's `quick_check` passed.

## Browser coverage

| Browser  | Result                                                                               |
| -------- | ------------------------------------------------------------------------------------ |
| Chromium | Not run. The cached Chrome for Testing executable failed to launch with `EBADMACHO`. |
| Electron | Fail. Worker memory exceeded the limit.                                              |
| Safari   | Not run. Safari was already open, and this run required an isolated profile.         |
| Firefox  | Not run. The runner found no installed executable.                                   |

See the [run instructions](../apps/web/perf/storage/README.md) and [raw samples](../apps/web/perf/storage/electron-macos-results.json). The gate returned exit code 1.
