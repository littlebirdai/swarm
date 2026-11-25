# Storage benchmark

Run the benchmark from the repository root with Bun and the repository dependencies. Use existing browser executables. Pass the checkout's shared heavy lock path in `STORAGE_BENCH_LOCK`.

```sh
(
  : "${STORAGE_BENCH_LOCK:?Set the checkout shared heavy lock path}"
  while ! mkdir "$STORAGE_BENCH_LOCK" 2>/dev/null; do sleep 5; done
  trap 'rmdir "$STORAGE_BENCH_LOCK"' EXIT
  uptime
  bun apps/web/perf/storage/run.ts --out /tmp/storage-results.json
)
bun apps/web/perf/storage/gate.ts /tmp/storage-results.json
bun test apps/web/perf/storage/gate.test.ts
```

Use `--chromium`, `--electron`, or `--firefox` with an explicit executable path when the runner cannot find the browser. Use `--only electron --trials 1` for a smoke run. The gate requires 20 or more trials per browser. It exits 0 when all browsers pass, 1 when any browser fails, or 2 when the result is incomplete.

The runner verifies the tarball of `@sqlite.org/sqlite-wasm@3.54.1-build1` against a pinned SHA-512 digest. It extracts the files into the benchmark's temporary directory. This keeps the dependency outside the app's bundle and lockfile. Bun serves the benchmark on loopback. The fixture uses a synthetic local ownership record. The runner uses temporary browser profiles and removes them at exit. Safari requires separate authorized automation with an isolated profile. This runner reports Safari as `not-run`.

## Fixture and measurements

The 150,000-row fixture includes 148,600 events, 1,200 sessions, and 200 messages for a focused conversation. Events have synthetic plan links so the product retains them across boot trials. A separate retention trial deletes one 2,000-row batch, confirms deletion, then restores those rows.

- **Ready** starts before Dexie opens or before the SQLite worker exists. It ends once the database is ready to read. SQLite uses a dedicated worker, the OPFS sync access handle pool, rowid tables, and a DELETE rollback journal with FULL synchronous mode.
- **Paint read** starts after ready. Dexie uses the product's critical cache loader and focused message loader, which read all 1,200 sessions and the 200 messages. SQLite reads the 134 live sessions and 200 messages and sends them to the page.
- **Full boot** starts before ready. It ends after Dexie loads all critical and deferred rows or after SQLite parses all 150,000 rows and sends them to the page. This measures storage delivery before UI apply and render. The browser process and OS file cache stay warm between trials.
- **Main-thread write** measures the synchronous product patch writer and Dexie's downstream mutation call, or the worker request and message serialization. **Saved** ends at Dexie's transaction complete event or the SQLite commit reply. Both engines change the same 20 event rows.
- **Retention batch** includes the deletion and commit of 2,000 event rows. SQLite timing includes the worker round trip. The restore runs outside this time.
- **Handoff** uses two windows, a Web Lock, and BroadcastChannel. The second window queues for the lock. The timer runs from the old owner's close through the new owner's read of the last 20 committed rows and its reply.
- **Interrupted write** changes ten rows in an open transaction. The runner closes the Dexie writer window or terminates the SQLite worker before commit. It opens the store again to verify the previous committed values and total row count. SQLite also runs `quick_check`.
- **Worker memory** adds the worker's used JavaScript and embedder heaps to its backing storage. DevTools supplies those values. The WASM linear-memory size provides a lower bound for backing storage. It reports the largest of the checkpoints after paint, full boot, and retention in each trial. The 35 MiB gate uses the largest sample. This metric omits native allocations and peaks between checkpoints. Firefox supplies WASM bytes but has no DevTools heap measurement in this runner.
- **File size** reports the Chromium/Electron IndexedDB LevelDB files, the SQLite logical database size, and the total logical file sizes in the OPFS pool.

The JSON contains raw samples and nearest-rank p50 and p95 values. Browser availability and runtime failures appear in the same report.
