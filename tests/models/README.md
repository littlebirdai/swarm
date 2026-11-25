# Protocol models

These TLA+ models describe the target protocols. TLC checks each configuration
against [expectations.json](./expectations.json).

## Run the checks

Use Bun and Java 17 or later. If Java is outside your PATH, set `JAVA_HOME`.

```sh
bun tests/models/run-models.ts
bun test tests/models/tlc-result.test.ts
```

The runner downloads TLC 1.7.4 on first use and checks its SHA-256 before each
use. It stores the JAR under `$XDG_CACHE_HOME/swarm/tlc` or
`~/.cache/swarm/tlc`. CI uses Java 17 from the Ubuntu runner image.

The `invariants` and `properties` lists pin every rule in each configuration.
Every configuration must check at least one rule. An empty `violations` list
requires a successful run. A named violation requires
a TLC counterexample for that rule. To check the next rule, the runner removes
the failed invariant from a temporary copy of the configuration and runs TLC
again. A temporal counterexample must come from a configuration with one property.

`distinctStates` is TLC's count after a complete search. For configurations with
`stopAfterCounterexamples`, it is the count at the last expected counterexample,
if specified. The largest mutations use this mode to preserve the known
counterexamples from the original bounded checks.

## Models

- **CacheHost** models cache writes and reads when a host hangs, restarts, or
  loses its lease. It checks that a new host can serve and that readers skip no
  rows and see only their account's rows.
- **CoSteer** models two people who send messages to one agent and share the turn.
  It checks that the baton stays with its holder until a steer in flight settles.
- **Delivery** models message delivery across lost replies, runtime changes, and
  retries. It checks that receipts keep retries safe and shows which guarantees
  fail after a person chooses to resend in paste mode.
- **FencedTakeover** models owner takeover while another person's steer is in
  flight. It checks that no late steer lands after takeover and that a stable
  connection lets the owner take control.
- **Lease** models claims, renewal, expiry, and fencing tokens. It checks that
  only the current claim can complete the work, even when a silent holder keeps
  working.
- **LoneJoin** models a second person who asks to steer a session with one active
  sender. It checks that a lone sender writes no claim row and that the second
  person can take over after the holder goes away.
- **OutboxMove** models unsent work across a storage migration, a crash, a
  rollback, and sign-out. It checks that each action reaches the server at most
  once, under its own account, and eventually arrives or is discarded at sign-out.
- **PromptAnswer** models the path from an answer on a prompt card to the agent.
  It checks that one eligible person can settle the current prompt and that a
  stale answer cannot reach a later prompt.
- **StaleSteer** models a steer or interrupt that names the turn from which it
  was sent. It checks that the action affects only that turn and that the
  machine check also works by itself.
- **SwarmFlow** models one message from a local send through storage, agent
  delivery, and notification. It checks delivery, status, and recipient rules
  with retries, a machine restart, and different notification scopes.
- **TerminalControl** models a typing lease across pane replacement, token
  revocation, and out-of-order control messages. It checks that the current
  typist's keys reach the correct pane, including when keys travel by relay.
- **TurnBaton** models two senders and one owner who can take the turn. It checks
  that only the holder can send into a turn and that only one steer is in flight.

## Replay traces against the packages

The model job uses TLC 1.7.4 to dump the Lease graph and both Delivery graphs.
It keeps the constants and bounds from the checked configurations. It checks
the rules in separate runs, so a known counterexample cannot truncate a graph.
The runner uses one worker, seed 1, and fingerprint index 0. It selects a path
for each named action sequence, with state order as the tie breaker. It compares
each action and full state with the committed fixture. The action list in
`Next` must match trace coverage, including actions with no code counterpart.

```sh
bun tests/models/run-models.ts --traces
bun tests/models/run-models.ts --traces --update
bun test packages/edge-client/test/lease-traces.test.ts packages/session-contract/test/delivery-traces.test.ts
```

The first command checks the fixtures. The second regenerates them. The third
runs the replays with Bun and needs no Java. The package and always-run test jobs
run the replays. The extra TLC checks take about two seconds locally with a
cached JAR. The 13 Bun tests take about 110 ms including startup.

### Lease

Five traces cover 7 of 7 model actions. The harness gives each worker its own
`EdgeClient` layer. The transport returns scripted replies. TestClock controls
lease time. The test observes work through scoped acquisition and teardown.

| Model action   | Code call and observed state                                                                                                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Claim`        | `withClaim` starts the worker with the granted token. An old token retained in `mine` drives a stale `renew` probe after reclaim.                                                               |
| `LeaseRunsOut` | Hold a renewal reply. Work stays active through 899 ms, stops at 900 ms, and remains stopped at the server expiry of 1,000 ms. The renewal aborts and teardown precedes release.                |
| `Renew`        | After lapse, the raw `renew` call receives a renewal for the current token. The old `withClaim` scope stays stopped.                                                                            |
| `Complete`     | An accepted completion ends the work scope. A stale completion leaves the live worker alone. The lease client has no completion RPC, so only TLC checks the server transition and count `done`. |
| `GiveBack`     | End the work scope and verify the subsequent release with the worker's token.                                                                                                                   |
| `Finished`     | TLC stutter. No call.                                                                                                                                                                           |
| `OutOfTokens`  | TLC bound. No call.                                                                                                                                                                             |

The work projection uses `item`, `live`, `token`, and `mine`. It compares the
active scoped worker and token after each action. In `silent-holder`, TLC
retains the first worker in `mine` after the second worker claims. This violates
the model's `OneSessionWorking` rule. The client already stopped work at the
local deadline. In `late-renew`, TLC resumes the same lease after lapse. The
client can issue a raw renew but does not resume the work scope. The model has
no local stop margin or transport response for stale renewal. The trace includes
explicit checks for both.

### Delivery

Eight traces cover 14 of 14 model actions. The harness passes facts through
`sessionMachine.apply` and observes the resulting inbox, run and effects.

| Model action      | Code call and observed state                                                                                                                                                                  |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Claim`           | `delivery.permitted` moves the row to `claimed` with an attempt for the current run.                                                                                                          |
| `Start`           | `delivery.start` moves the row to `delivery-started` and emits one `delivery.apply` effect.                                                                                                   |
| `Apply`           | Host input and durable deduplication have no code in this reducer. TLC supplies the outcome for the next `Ack`.                                                                               |
| `Ack`             | `delivery.settle` records the supplied `applied` or `duplicate` result as `delivered`.                                                                                                        |
| `DaemonRestarts`  | Daemon memory has no code in this reducer.                                                                                                                                                    |
| `Requeue`         | `delivery.returned` moves an unstarted attempt to `pending`.                                                                                                                                  |
| `ReportAmbiguous` | `delivery.settle` with `in_doubt` moves the row to `ambiguous`.                                                                                                                               |
| `HostDies`        | `run.processExited` marks the reducer run stopped. Process death detection is outside the reducer.                                                                                            |
| `Reopen`          | `run.successorAuthorized`, `run.claimed`, and `run.runtimeReady` advance the run. The reducer retires the old permit at authorization.                                                        |
| `Supersede`       | Observe the retired permit. For a started own-mode attempt, pass `delivery.reconciled` with receipt evidence if TLC records a receipt. Without evidence the reducer leaves the row ambiguous. |
| `Correlate`       | A provider `receipt` event moves the row to `correlated-delivered`.                                                                                                                           |
| `SendAgain`       | `inbox.abandoned` with a replacement abandons the first row. Replay continues with the new delivery ID.                                                                                       |
| `Done`            | TLC stutter. No call.                                                                                                                                                                         |
| `Parked`          | TLC bound. No call.                                                                                                                                                                           |

The status projection maps `waiting` to `pending`, `started` to
`delivery-started`, and both delivered code statuses to `delivered`.
`epoch` maps to the run number. `host` maps to the run's ready or stopped
status. `pEpoch` maps to the active attempt's run, or zero when the reducer
has retired the attempt. TLC alone observes daemon memory `d`, host input
count `got`, and durable receipt flag `rc`. Receipt storage, replay, absence
proof, and effect execution have no implementation in this reducer.

In the successor traces, the reducer retires the permit during `Reopen`.
TLC retires it during the subsequent `Supersede`. In
`successor-without-receipt`, TLC returns a started attempt to `waiting` on
receipt absence. The reducer has no fact that proves receipt absence, so it
keeps the row ambiguous without reconciliation evidence. In `paste-resend`,
TLC reuses the original row and counts two host inputs. The reducer keeps the
abandoned row and submits a new ID. The replay checks both row outcomes.
