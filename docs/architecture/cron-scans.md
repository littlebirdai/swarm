# Bounded cron scans

## Recent-message search mirror

The search mirror has one fixed 15-second Convex cron. It reads `SEARCH_MIRROR_CRON_BACKOFF` at runtime. With the flag off, each tick uses the original 1,000-row batch limit. With the flag on, due ticks use a 400-row limit. A tick with work keeps the 15-second cadence. An idle tick selects a 30-second cadence.

The mirror records the due time when it starts a cadence or updates its cursor. During a quiet period, the stored due time anchors the recurring 30-second cadence. This lets later quiet ticks reuse that state. A tick before its due window reads the state and returns without writing. There is no separately scheduled drain chain.

The flag reduces work per call. The cron still makes four calls per minute. Cutting the number of calls requires a deploy-time change to the cron interval.

## Activity rollup

The hourly activity sweep first scans heartbeats through the run's start time. It then scans heartbeats that moved past that time, up to the time when the first phase ended. The tail stops after four pages, then the sweep processes recently created accounts. A heartbeat beyond the tail cutoff or a row beyond the page cap is eligible on the next hourly run.

The sweep claims each account for its run before it processes any days. A failed day gets one retry through the Convex scheduler. The scheduled job records the account and day, so the retry does not repeat the user's other days.
