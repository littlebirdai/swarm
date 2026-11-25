# Offline daemon worker load

## Rollout criteria

Run three pairs per workload, alternating which mode runs first. Every
workers-on run must have a loop-delay p99 at most 100 ms and maximum below
1 second. Each event must arrive once, in transcript order. Every round must
finish within its time limit, and worker PIDs must stay constant after warmup.

For each workload, compare the median workers-on minus workers-off difference.
Allow the greater of 10% of the workers-off median or the absolute tolerance.

| Measure                                                        | Absolute tolerance |
| -------------------------------------------------------------- | -----------------: |
| Loop delay p50, p95, p99                                       |               5 ms |
| Loop delay maximum                                             |              20 ms |
| Event latency p50, p95, p99                                    |              10 ms |
| Event latency maximum                                          |              25 ms |
| Daemon and combined physical memory peaks, idle and under load |             16 MiB |
| Daemon and combined CPU, idle and under load                   |          0.05 core |

The memory gate uses physical footprint on macOS and PSS on Linux. RSS remains
in the report for comparison.

## Method

Run `bun apps/cli/src/bench/worker-load.ts > worker-load.jsonl` on macOS or
Linux. Each trial and workload gate produces a JSON record. Exit 1 means a
criterion failed or a trial did not finish. Use `--case=large --pairs=1` for
a short paired check.

| Case    | Fleet | Active sessions per round | Rows per active session | Content per row | Concurrency | Project directories | Window   |
| ------- | ----: | ------------------------: | ----------------------: | --------------: | ----------: | ------------------: | -------- |
| Small   |     5 |                         3 |                       1 |           4 KiB |           4 |                   1 | 12 × 2 s |
| Normal  |    20 |                        10 |                       1 |           4 KiB |           4 |                   1 | 12 × 2 s |
| Fleet   |   200 |                        17 |                       1 |           4 KiB |           4 |                   1 | 12 × 2 s |
| Large   |   200 |                       200 |                       1 |           1 MiB |          30 |                   8 | 1 × 25 s |
| Backlog |   200 |                        30 |                     240 |           256 B |          30 |                   8 | 1 × 35 s |

A fresh child process runs the production transcript path, stale-file scan,
and process probe in a private home. The workers-on child launches the three
production worker entry points. The real `SyncService` and Convex HTTP client
prepare each mutation. An in-process handler verifies the message ID, order,
and wire content, then returns a synthetic acknowledgment. The benchmark
checks each position and sync ledger at the end of its pass. The trial needs
no account, live daemon boot, watcher scheduling, or network service.

The light cases append a record from the round scheduler. The heavy cases
prepare the files before the sample window and release the backlog at its
start. This excludes JSONL fixture construction from heavy loop delays.
The heavy cases run full `ps aux` probes and scan the project directories
every two seconds while ingestion proceeds. A transcript pass can send
several batches. Each record's latency runs from its scheduled round to
the position commit for its pass.

After warmup, the child gives the workers one second to settle, forces GC
in the daemon process, then waits 250 ms before the idle window. Workers
use their normal runtime GC. The child measures lateness relative to a
10 ms timer. The parent samples resources every 500 ms and at both ends
of each phase. On macOS it reads RSS and cumulative process CPU time from
`ps` and current physical footprint from `footprint`. On Linux it reads
RSS and PSS from `smaps_rollup` and converts the CPU ticks in `stat` using
`CLK_TCK`. The report sums simultaneous samples for combined peaks. CPU
covers the daemon and persistent workers.

## Results

Workers remain opt-in. All 30 trials completed and delivered 46,560 events in
order. All 15 workers-on trials passed the absolute loop budget. The highest
workers-on loop p99 was 8.8 ms, and the longest delay was 481.1 ms. One
workers-on fleet round missed its two-second deadline in pair three, round nine.

The 200-record, 1 MiB case reduced median loop p99 by 28% and the median
maximum by 91%. Median p95 increased from 4.6 to 5.9 ms and stayed within
its paired tolerance. The review's earlier run reported a 21–42% decrease
in p95, p99, and maximum. This run reproduced a tail improvement, with a
different p95 result. The backlog reduced the median maximum from 13.7 to
7.5 ms.

Combined physical footprint failed at idle and under load in every case.
The paired median increase was 77–79 MiB at idle and 80–123 MiB under load.
The heavy large-record case also exceeded the combined CPU tolerance. Its
paired increase was 0.057 core, with a 0.05-core allowance. Daemon-only
memory, daemon-only CPU, and event latency stayed within their paired
tolerances. The large-record and backlog trials completed 10 and 15 full
process probes per trial, respectively.

The full run used daemon source revision `f74eee2616cd`, build
`0863d41a21a9`, Bun 1.4.4, and a 16 GiB Apple silicon Mac with macOS 27.0.
One-minute machine load at trial ends ranged from 1.05 to 5.57. Each trial
recorded 1,978 to 3,047 loop samples. A separate offline Linux container
check reported valid RSS and PSS and 1.00 CPU core for a 200 ms busy loop.

After rebase, build `916bf4c8f645` completed a fresh large-record pair with
all 400 events and both deadlines met. Workers-on loop p99 was 9.3 ms.
The combined load footprint rose from 223 to 379 MiB.

The latency columns show p50 / p95 / p99 / maximum. Each value is the median
of three trials in that mode.

| Case    | Workers |          Loop delay (ms) |                    Event latency (ms) |
| ------- | ------- | -----------------------: | ------------------------------------: |
| Small   | off     |    2.0 / 2.0 / 2.6 / 5.8 |         108.0 / 212.5 / 214.2 / 214.2 |
| Small   | on      |    2.0 / 2.0 / 2.5 / 5.5 |         108.3 / 214.9 / 214.9 / 214.9 |
| Normal  | off     |    2.0 / 2.0 / 2.7 / 6.6 |         417.5 / 917.3 / 921.3 / 924.8 |
| Normal  | on      |    2.0 / 2.0 / 2.8 / 5.7 |         416.0 / 918.7 / 922.1 / 925.1 |
| Fleet   | off     |    2.0 / 2.0 / 2.6 / 9.4 |      812.4 / 1618.2 / 1623.8 / 1632.7 |
| Fleet   | on      |   2.0 / 2.0 / 2.6 / 14.3 |      812.3 / 1617.6 / 1624.7 / 1633.5 |
| Large   | off     | 2.0 / 4.6 / 11.2 / 189.8 | 10240.6 / 19343.9 / 20152.1 / 20353.7 |
| Large   | on      |   2.0 / 5.9 / 8.1 / 17.5 | 10087.7 / 19190.5 / 19998.1 / 20200.4 |
| Backlog | off     |   2.0 / 2.0 / 2.7 / 13.7 | 28808.3 / 30225.2 / 30326.1 / 30326.1 |
| Backlog | on      |    2.0 / 2.0 / 2.6 / 7.5 | 28754.7 / 30171.7 / 30273.8 / 30273.8 |

The next table shows combined sampled resource peaks and average CPU, with workers off → on.

| Case    | Idle footprint (MiB) | Load footprint (MiB) | Idle RSS (MiB) | Load RSS (MiB) | Idle CPU (cores) | Load CPU (cores) |
| ------- | -------------------: | -------------------: | -------------: | -------------: | ---------------: | ---------------: |
| Small   |         52.0 → 129.0 |         60.0 → 140.0 |  101.0 → 244.0 |  122.9 → 289.5 |    0.005 → 0.000 |    0.021 → 0.038 |
| Normal  |         52.0 → 129.0 |         65.0 → 146.0 |  101.1 → 244.7 |  134.3 → 305.6 |    0.005 → 0.010 |    0.045 → 0.075 |
| Fleet   |         52.0 → 131.0 |         67.0 → 152.0 |  101.6 → 248.7 |  140.7 → 323.0 |    0.000 → 0.005 |    0.026 → 0.043 |
| Large   |         55.0 → 133.0 |        235.0 → 380.0 |  212.7 → 328.8 |  661.7 → 856.7 |    0.000 → 0.005 |    0.232 → 0.283 |
| Backlog |         52.0 → 131.0 |         93.0 → 201.0 |  116.7 → 261.9 |  185.4 → 387.6 |    0.000 → 0.005 |    0.030 → 0.053 |

The last table shows the workers-on medians in daemon / probe / scan / ingest order. Memory values are in MiB, and CPU values are in cores.

| Case    |            Idle footprint |              Load footprint |                   Idle RSS |                    Load RSS |                      Idle CPU |                      Load CPU |
| ------- | ------------------------: | --------------------------: | -------------------------: | --------------------------: | ----------------------------: | ----------------------------: |
| Small   | 52.0 / 25.0 / 27.0 / 25.0 |   56.0 / 29.0 / 27.0 / 34.0 | 106.7 / 44.8 / 47.1 / 45.7 |  121.0 / 56.5 / 48.3 / 64.3 | 0.000 / 0.000 / 0.000 / 0.000 | 0.018 / 0.007 / 0.004 / 0.009 |
| Normal  | 52.0 / 25.0 / 27.0 / 25.0 |   58.0 / 32.0 / 27.0 / 31.0 | 106.0 / 44.6 / 47.8 / 45.9 |  126.6 / 61.5 / 48.6 / 69.2 | 0.005 / 0.000 / 0.005 / 0.000 | 0.038 / 0.014 / 0.004 / 0.018 |
| Fleet   | 52.0 / 25.0 / 27.0 / 25.0 |   60.0 / 34.0 / 29.0 / 33.0 | 106.7 / 45.0 / 49.7 / 46.8 |  131.0 / 64.4 / 57.4 / 68.1 | 0.000 / 0.000 / 0.000 / 0.000 | 0.020 / 0.008 / 0.004 / 0.010 |
| Large   | 55.0 / 25.0 / 27.0 / 26.0 | 191.0 / 35.0 / 33.0 / 133.0 | 187.5 / 46.1 / 49.3 / 46.4 | 493.2 / 70.4 / 58.0 / 209.9 | 0.005 / 0.000 / 0.000 / 0.000 | 0.191 / 0.010 / 0.004 / 0.078 |
| Backlog | 53.0 / 25.0 / 27.0 / 25.0 |   92.0 / 29.0 / 30.0 / 54.0 | 118.7 / 46.9 / 49.5 / 45.7 |  179.2 / 57.8 / 58.2 / 92.3 | 0.005 / 0.000 / 0.000 / 0.000 | 0.029 / 0.006 / 0.008 / 0.009 |

## Before enabling workers by default

Keep workers opt-in until their combined physical memory fits the rollout
gate. The bridge still starts three resident worker processes. Sharing a
runtime can reduce that fixed cost. Keep the per-kind limits and test the
failure behavior again after a change to process ownership.
[Worker bridge](../../apps/cli/src/workers/bridge.ts#L51) ·
[Process launch](../../apps/cli/src/workers/host.ts#L178)

The production send path still prepares transcripts and redacts secrets on
the main thread. Only the worker fixture calls `MessagePreparation`.
Connect it to the production send path and verify payload parity. Then
repeat the paired gate with the large records and the backlog.
[Daemon preparation](../../apps/cli/src/daemon.ts#L11724) ·
[Preparation worker client](../../apps/cli/src/workers/preparationClient.ts#L28)

## Ingest concurrency

The daemon queues cursor opens in arrival order. A slot stays occupied until
its transcript read and cursor cleanup end. The queue holds at most 32
waiters, and the existing transcript deadline applies while they wait. An
overflow refuses admission before it reads a cursor page.

The regression test reads 30 transcripts concurrently. It verifies that each
transcript returns both records in file order and consumes the exact input
byte count. A mutation that bypasses the four-cursor limit made 26 requests
fail with `operation_failed`. The restored test passed.

## Failure checks

Each mutation changed production code for one test run. Its named test
failed, and the source was restored. The unmodified tests passed twice.

| Behavior        | Mutation                                                | Test                                |
| --------------- | ------------------------------------------------------- | ----------------------------------- |
| Crash           | Leave the worker kind enabled after its third crash     | `third crash disables kind`         |
| Hang            | Reject the expired request and leave its worker running | `queue and inflight caps`           |
| Slow start      | Accept a reply at the request deadline                  | `slow-start worker result`          |
| Message order   | Resolve the oldest request when a later request replies | `out-of-order worker replies`       |
| Backlog         | Admit one request beyond the queue capacity             | `queue and inflight caps`           |
| Shutdown        | Permit local fallback after the host closes             | `shutdown does not launch fallback` |
| Sleep and wake  | Count a suspend failure as a worker crash               | `suspend callback order`            |
| Low descriptors | Treat `EMFILE` on worker spawn as a failed operation    | `worker spawn refused with EMFILE`  |

The production source entry test also passed for all three worker kinds
with a 64-descriptor limit.
