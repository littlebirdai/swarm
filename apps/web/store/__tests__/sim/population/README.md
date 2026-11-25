# Sync population simulation

The simulation measures how much task sync traffic one device receives as the population grows. The current sync log sends shared task changes to the whole team and sends owner copies through the personal scope. The project follow graph is available for a future run with interest scopes.

## Run

From `apps/web`, run the 10-person tests. The unfiltered `bun run sim` suite also includes them.

```sh
bun test store/__tests__/sim/population --isolate
```

Run the standalone population driver for larger populations. The default seed is 42, and the default sample is 20 devices or one per person if there are fewer people. Add `--json` for per-device results and distributions.

```sh
bun --smol store/__tests__/sim/population/population.ts --people 1 --json
bun --smol store/__tests__/sim/population/population.ts --people 50 --json
bun --smol store/__tests__/sim/population/population.ts --people 50 --devices 50 --json
bun --smol store/__tests__/sim/population/population.ts --people 500 --json
```

## Workload and measurements

For groups of two or more, the model assigns 80% of people to the main team and puts the rest in teams of at most 30 people. It gives each team about one project per 12 members. Each person has a home project. Below 50 people, each person follows every project in their team. At higher populations, extra follows favor the first projects in each team. Agents choose the home project for 75% of assignments and choose from all followed projects for the rest.

Each team member has five agents. A solo person has 20 agents and uses only the personal scope. The model selects half the agents to work and rounds up when necessary. Each working agent creates one task and can edit that task. Approximately 10% of team members' tasks use a personal workspace. The first 48 seconds represent one change per minute per working agent. The last 12 seconds use five times that rate. The seed sets the phase of each agent's changes.

All people contribute writes. The seed selects devices without replacement. Each sampled device uses its own real client store, one user identity, and the real personal and team scopes for that user. The driver polls every 1.5 seconds and makes a final poll after the last drain. It starts with empty task stores and measures task log traffic for one minute. The load excludes transcripts, legacy bridge traffic, bootstrap snapshots, and other live feeds.

- **Events per device** count actions in actual `getRange` responses. The total includes personal and team copies when a device holds both scopes.
- **Bytes per device** count UTF-8 JSON for the heads, range, and by-ID responses. Transport framing and request bytes are outside this measure.
- **Rows per device** count tasks in the store after the final poll. The client applies the production `catchUpScope` path. JSON also reports by-ID task fetches and titles that differ from the final server rows.
- **Head writes** count committed inserts and patches to `sync_heads`. The tracked mutation uses the production fan-out, outbox writer, and scheduled drain.
- **Drain lag** measures virtual time from a slot's latest save to delivery. The fake database commits each call in one virtual instant.
- **Modeled retries per write** count competing jobs divided by application saves. A job counts once if it would overlap a same-scope head write under a 5 ms transaction window. This includes a job whose scheduler state is canceled if a drain delivered its slot less than 5 ms earlier. Only delayed jobs count as retry candidates. The model omits contention between saves and drains. The serialized database cannot measure Convex OCC retries or retry-adjusted lag.

## Baseline

Seed 42 on Apple M6 with Bun 1.4.4. Device columns give the mean. The drain lag column gives p95.

| People | Devices | Saves | Head writes | Modeled retries per write | Drain lag (ms) | Events per device | Bytes per device | Rows per device |
| -----: | ------: | ----: | ----------: | ------------------------: | -------------: | ----------------: | ---------------: | --------------: |
|      1 |       1 |    19 |          19 |                    0.0000 |             25 |              19.0 |           20,473 |            10.0 |
|     50 |      20 |   222 |         425 |                    0.0315 |             25 |             145.5 |          144,929 |            78.9 |
|     50 |      50 |   222 |         425 |                    0.0315 |             25 |             140.4 |          139,980 |            75.8 |
|    500 |      20 | 2,240 |       4,279 |                    0.0674 |             25 |           1,421.1 |        1,358,146 |           793.0 |

At 50 people, the full run reproduced each of the 20 sampled devices exactly. The sample means were 3.6% higher for events, 3.5% higher for bytes, and 4.1% higher for rows. Both runs produced the same server metrics.

At 500 people, the sample covered three of five teams. The main team had 17 of the 20 sampled devices and 400 of the 500 people. Each main-team device received 1,646 team events, or 27.4 per second across the minute.

The mean events per device rose 9.8 times between the 50-person and 500-person samples. Compare that measure with a future interest-scope run that uses the same workload and device sample.
