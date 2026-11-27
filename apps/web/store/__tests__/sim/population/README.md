# Sync population simulation

The population simulation measures the current sync log for one team of 1, 50, or 500 people. All measured devices receive the team scope and their owner's personal scope. The follow graph is available for future interest-scope comparisons.

## Run

From `apps/web`, run the 1- and 50-person cases with all devices. The unfiltered `bun run sim` suite also runs these cases.

```sh
bun test --isolate store/__tests__/sim/population
```

The [architecture note](../../../../../../docs/architecture/sync-sim.md#population-baseline) gives the baseline commands, including the opt-in 500-person run.

## Workload

Each member has one active session and one completed session. Each member has a home project and can follow up to three more projects. Extra follows favor popular projects. Members follow up to five active peer sessions in those projects.

Active sessions send a heartbeat every 30 seconds, with a random initial offset. Each active session writes one prompt and reply before the peak. About 35% write another pair in the last 12 seconds. About 30% of members edit a shared project doc. Different members own the projects and their docs. These writes use the Convex heartbeat, transcript, and doc handlers.

Each member has five agents. The model selects half the agents to work, rounded up. Each selected agent creates one task and can edit it through the production web task mutations. Agents pick their home project 75% of the time and can pick a followed project otherwise. About 10% of tasks use a personal workspace. Those tasks omit a team project because the production mutation requires the task and project to share a workspace. A working agent averages one task write per minute for the first 48 seconds. The expected rate increases fivefold for the last 12 seconds.

The driver starts with empty client stores. Each device polls every 1.5 seconds and applies changes with the production `catchUpScope`. The driver polls once after the write window ends and drains delayed analytics jobs. This workload uses named sessions with title generation disabled.

## Measurements

Keep the workload, seed, and device sample fixed when you compare interest scopes with team fan-out.

JSON also reports bytes and task rows per device. Bytes count UTF-8 JSON for heads, range, and by-ID responses and exclude transport framing and requests. Task rows count the tasks in the client store after the last poll.
