# Sync population simulation

The population simulation measures the current sync log for one team of 1, 50, or 500 people. All measured devices receive the team scope and their owner's personal scope. The follow graph is available for future interest-scope comparisons.

## Run

From `apps/web`, run the 1- and 50-person cases with all devices. The unfiltered `bun run sim` suite also runs these cases.

```sh
bun test --isolate store/__tests__/sim/population
```

Use the standalone driver to reproduce the baseline. The default seed is 42. The 500-person workload runs only on request and measures 20 seeded devices. All 500 people contribute writes. Add `--json` to inspect the device results and distributions.

```sh
bun --smol store/__tests__/sim/population/population.ts --people 1 --devices 1 --json
bun --smol store/__tests__/sim/population/population.ts --people 50 --devices 50 --json
bun --smol store/__tests__/sim/population/population.ts --people 500 --devices 20 --json
```

## Workload

Each member has one active session and one completed session. Each member has a home project and can follow up to three more projects. Extra follows favor popular projects. Members follow up to five active peer sessions in those projects.

Active sessions send a heartbeat every 30 seconds, with a random initial offset. Each active session writes one prompt and reply before the peak. About 35% write another pair in the last 12 seconds. About 30% of members edit a shared project doc. These writes use the Convex heartbeat, transcript, and doc handlers.

Each member has five agents. The model selects half the agents to work, rounded up. Each selected agent creates one task and can edit it. Agents pick their home project 75% of the time and can pick a followed project otherwise. About 10% of tasks use a personal workspace. A working agent averages one task write per minute for the first 48 seconds. The expected rate increases fivefold for the last 12 seconds. Task writes go through the production change-feed writer and outbox.

The driver starts with empty client stores. Each device polls every 1.5 seconds and applies changes with the production `catchUpScope`. The driver polls once after the write window ends and drains delayed analytics jobs. This workload uses named sessions with title generation disabled.

## Measurements

- **Events per device** count actual actions in `getRange` responses. The count includes both team and personal copies. Heartbeats and transcripts use separate live feeds for their direct delivery. The count includes only the sync-log effects of those writes. It excludes live-feed pushes and initial snapshots.
- **Modeled retries per write** divide competing outbox jobs by all workload writes. The model counts a delayed job once if it overlaps a same-scope head write under a 5 ms transaction window. It also counts a canceled job if a drain delivered its slot less than 5 ms earlier. The model omits contention between saves and drains and cannot measure real Convex OCC retries.
- **Drain lag** measures virtual time from the latest save to outbox delivery. It excludes client polling time. The simulation commits each database call in one virtual instant.
- **Bytes per device** count UTF-8 JSON for heads, range, and by-ID responses, excluding transport framing and requests. **Rows per device** count tasks in the client store after the last poll.

The [architecture note](../../../../../../docs/architecture/sync-sim.md#population-baseline) records the baseline. Keep the workload, seed, and device sample fixed when you compare interest scopes with team fan-out.
