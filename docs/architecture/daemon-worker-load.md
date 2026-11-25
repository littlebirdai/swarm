# Offline daemon worker load

## Rollout criteria

Run three pairs for each fleet size of 5, 20, and 200 synthetic sessions.
Alternate which mode runs first. Every workers-on run must have a main-loop
delay p99 of at most 100 ms and a maximum below 1 second. Every run must
deliver each event once, in order for its session, and complete each round
before the next round is due. Worker PIDs must stay constant after warmup.

For each fleet size, compare the median workers-on minus workers-off difference
across the pairs. Allow the greater of 10% of the workers-off median or these
absolute tolerances:

| Measure                                            | Absolute tolerance |
| -------------------------------------------------- | -----------------: |
| Loop delay p50, p95, p99                           |               5 ms |
| Loop delay maximum                                 |              20 ms |
| Event latency p50, p95, p99                        |              10 ms |
| Event latency maximum                              |              25 ms |
| Daemon and combined RSS peaks, idle and under load |             16 MiB |
| Daemon and combined CPU, idle and under load       |          0.05 core |

Use the combined peak RSS for the memory gate because all three children share
the machine's memory budget. Report the daemon and each child separately too.

## Method

Run `bun apps/cli/src/bench/worker-load.ts > worker-load.jsonl` on macOS or
Linux. The program writes one JSON record per run and one gate summary per
fleet size. Exit 1 means that a criterion failed or that a run did not finish.

Each run starts a fresh Bun process in a private temporary directory with an
empty home and an allowlisted environment. It calls the daemon's production
transcript sync and stale-file scan, and sends a production process probe. In
workers-on mode it launches the three production worker entry points. The real
`SyncService` and Convex HTTP client prepare the mutation. An in-process fetch
handler checks its conversation, message ID, and content, then returns a
synthetic acknowledgment. The benchmark checks the file position and sync
ledger after the acknowledgment. It uses no real session, account, agent, or
network service.

Each run warms the workers and measures two seconds of idle time. It then
schedules 12 rounds at two-second intervals. Each round runs a process probe,
scans the fleet, and appends one 4 KiB transcript record to 3, 10, or 17 sessions,
respectively. The rounds rotate through all sessions. At most four transcript
passes run concurrently. Each event's latency starts at its scheduled round
time and ends when the daemon commits its position and ledger. It includes
dispatch delay, local I/O, parsing, preparation, the normal sync throttle, and
the synthetic acknowledgment.

The main process measures lateness relative to a 10 ms timer. A long stall
produces one long sample. The maximum matters when few stalls occur. The
benchmark samples RSS every 250 ms and at both ends of each phase. It sums
simultaneous RSS samples, which can count shared pages more than once. CPU is
the change in cumulative process CPU time divided by elapsed time. It covers
the main process and persistent workers. It excludes short-lived probe
subprocesses.

This benchmark exercises the production local sync path. Full daemon startup,
native watcher scheduling, live delivery, and backend response time are outside
the measurement window. The 200-session fleet applies file and scan pressure.
The 17 events per round stay below the `SyncService` limit of ten mutation
dispatches per second.

## Results

Workers remain opt-in. All nine workers-on trials passed the loop budget.
The highest workers-on p99 was 5.0 ms, and the longest delay was 16.3 ms.
All 18 trials delivered 2,160 events in total. No round missed its deadline.
Latency, CPU, and daemon-only RSS stayed within their paired tolerances.
Combined RSS failed at all three fleet sizes.

The run used source revision `1c25a51de812`, daemon build `acabf659444a`,
and Bun 1.4.4 on a 16 GiB Apple silicon Mac with macOS 27.0.
The one-minute machine load at trial ends ranged from 1.29 to 5.08.
Each trial recorded 2,071 to 2,116 loop samples.

The latency columns show p50 / p95 / p99 / maximum, with the median of three
trials for each statistic.

| Sessions | Workers |       Loop delay (ms) |               Event latency (ms) |
| -------: | ------- | --------------------: | -------------------------------: |
|        5 | off     | 2.0 / 2.0 / 2.8 / 5.4 |    108.4 / 212.7 / 213.4 / 213.4 |
|        5 | on      | 2.0 / 2.0 / 2.8 / 9.3 |    110.7 / 214.5 / 216.0 / 216.0 |
|       20 | off     | 2.0 / 2.0 / 3.0 / 7.4 |    416.2 / 916.7 / 921.6 / 921.8 |
|       20 | on      | 1.9 / 2.0 / 2.8 / 5.9 |    417.8 / 919.5 / 922.6 / 923.9 |
|      200 | off     | 2.0 / 2.0 / 3.0 / 8.1 | 816.3 / 1619.6 / 1627.6 / 1631.8 |
|      200 | on      | 1.6 / 2.0 / 2.9 / 5.9 | 816.2 / 1619.1 / 1628.8 / 1632.4 |

The next table shows median combined resource use, with workers off → on.

| Sessions | Idle RSS (MiB) | Load RSS (MiB) | Idle CPU (cores) | Load CPU (cores) |
| -------: | -------------: | -------------: | ---------------: | ---------------: |
|        5 |  100.2 → 242.4 |  132.4 → 298.1 |    0.020 → 0.044 |    0.029 → 0.047 |
|       20 |  101.2 → 243.5 |  148.0 → 311.4 |    0.025 → 0.035 |    0.042 → 0.080 |
|      200 |  100.1 → 244.0 |  152.0 → 332.3 |    0.030 → 0.044 |    0.069 → 0.094 |

The last table shows the workers-on medians in daemon / probe / scan / ingest order.

| Sessions |             Idle RSS (MiB) |             Load RSS (MiB) |              Idle CPU (cores) |              Load CPU (cores) |
| -------: | -------------------------: | -------------------------: | ----------------------------: | ----------------------------: |
|        5 | 103.8 / 45.0 / 47.9 / 46.1 | 127.9 / 57.9 / 48.8 / 64.4 | 0.030 / 0.005 / 0.005 / 0.005 | 0.027 / 0.007 / 0.004 / 0.009 |
|       20 | 105.0 / 44.6 / 47.9 / 46.1 | 130.1 / 61.8 / 48.6 / 72.9 | 0.020 / 0.005 / 0.005 / 0.005 | 0.043 / 0.015 / 0.004 / 0.017 |
|      200 | 104.8 / 43.5 / 49.5 / 46.1 | 138.8 / 66.1 / 56.6 / 68.1 | 0.030 / 0.005 / 0.005 / 0.005 | 0.049 / 0.018 / 0.008 / 0.019 |

The paired median RSS increase was 142–144 MiB at idle and 163–176 MiB under
load. The allowance was 16 MiB in each case. The increase comes from the three
resident Bun children. The bridge creates one host for each kind, and each host
starts its own process. Each worker held 44–50 MiB at idle.
[Worker bridge](../../apps/cli/src/workers/bridge.ts#L51) ·
[Worker spawn](../../apps/cli/src/workers/host.ts#L178)

Share one child across the three kinds to reduce the fixed memory cost.
Keep the limits for each kind. Repeat the paired benchmark to measure the
RSS change.

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
