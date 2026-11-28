# Daemon extraction

Status: active extraction on `packages/edge-supervisor` and `packages/delivery`; legacy agent backends still live in `apps/cli/src/daemon.ts`.

`apps/cli/src/daemon.ts` will become a thin entry point that parses config, starts `packages/edge-supervisor`, and waits. Each daemon concern moves into an Effect 4 service package. Services communicate only through typed messages on `SupervisorBus` in `packages/edge-supervisor/src/bus.ts` and the wire contract in `packages/edge-contract`. Services do not import each other.

## Services

| Concern                       | Package / File                                                                                                                                   | Status      | Notes                                                                                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Edge link and heartbeat flush | `packages/edge-supervisor/src/machine.ts`, `packages/edge-supervisor/src/heartbeat-flush.ts`, `packages/edge-supervisor/src/edge-link-bus.ts`    | Extracted   | Owns hello/heartbeat link supervision, session heartbeats, and `edge.*` bus bridging                                                                                        |
| Delivery                      | `packages/delivery/src/effect.ts`, `packages/delivery/src/settlement.ts`, `packages/delivery/src/journals.ts`, `packages/delivery/src/bridge.ts` | Extracted   | Owns permits, `start -> deliver -> settle`, `retry_after_ms` backoff, receipt journal, and `in_doubt` recovery; wired into `apps/cli/src/execution/codex-pilot-delivery.ts` |
| Provider adapter              | `packages/provider-adapter/src/effect.ts`                                                                                                        | In progress | Owns Codex app-server pilot; Claude Code SDK, tmux paste, terminal injection, and legacy delivery remain for extraction                                                     |
| Transcript ingest and uplink  | `apps/cli/src/daemon.ts`, `apps/cli/src/retryQueue.ts`                                                                                           | Remaining   | `RetryQueue` retries transcript and session mutations; not message delivery                                                                                                 |
| Terminal streaming and typing | `apps/cli/src/daemon.ts`                                                                                                                         | Remaining   | PTY and tmux streaming stay in the daemon until extracted                                                                                                                   |
| Relay publisher               | `packages/relay`                                                                                                                                 | In progress | Viewer presence and live relay publishing                                                                                                                                   |
| Device moves                  | `apps/cli/src/daemon.ts`                                                                                                                         | Remaining   | Device handoff and takeover moves                                                                                                                                           |
| Task claims and renewal       | `apps/cli/src/daemon.ts`                                                                                                                         | Remaining   | Owned by the task-claim lane                                                                                                                                                |
| Parking                       | `apps/cli/src/execution/codex-pilot-cleanup.ts`                                                                                                  | Remaining   | Parked pilot state and idle eviction                                                                                                                                        |

## Supervisor bus messages

`SupervisorBus` validates every published message against `BusMessageSchemas` in `packages/edge-supervisor/src/bus.ts` and isolates services by message kind (`packages/edge-supervisor/src/bus-types.ts`):

- Delivery control and telemetry: `delivery.wake`, `delivery.stop`, `delivery.settled`
- Edge link RPC requests and replies: `edge.permits.next` / `edge.permits.next.result`, `edge.delivery.start` / `edge.delivery.start.result`, `edge.delivery.settle` / `edge.delivery.settle.result`, `edge.takeover.ack` / `edge.takeover.ack.result`, `edge.blob.get` / `edge.blob.get.result`
- Provider handoff and receipts: `provider.deliver` / `provider.deliver.result`, `provider.deliver.cancel`, `provider.recover` / `provider.recover.result`, `provider.receipt`

`SupervisorBus.request` does not hold a subscription of its own. One dispatcher fiber in the bus reads every reply and completes the waiting request by its `request_id`, so a requester can never block on its own full subscription when the bus is at capacity. A request fails at once when the bus is closed, when a request with the same id still waits, or when too many requests wait. Closing the bus fails every waiting request. The bus loops park on `PubSub.take` and do not yield after each message.

Every delivery cycle runs `start`, input preparation (`edge.blob.get`), `provider.deliver`, and `settle` inside one uninterruptible Effect step. Only one step runs at a time for each session. The lock for a session stays in memory while a step uses it or waits for it. Retryable edge responses honor `retry_after_ms` before re-polling `edge.permits.next`. A bus timeout on an edge call is also a retryable step. Unconfirmed outcomes settle `in_doubt`, hold the local slot and artifacts, and resolve on `provider.receipt`, on a late `provider.deliver.result`, or on restart recovery. A receipt wake settles the held delivery and does not send new messages.

A permit that reports `state: "started"` settles from the receipt journal or from `provider.recover`, and never calls `edge.delivery.start` again. A permit that reports `state: "new"` always calls `edge.delivery.start` first, because the server accepts an `applied` settlement only from a started or ambiguous attempt. A steer permit records its handover in the steer journal before recovery. A replayed new steer permit whose attempt is already a recorded handover goes to recovery and is never sent again.

The bus loops of the delivery service, the delivery bridge, and the edge link never wait for a slow handler. They start each handler in its own fiber, and a pool limits the number of handlers that run at the same time and how long each one runs. The bridge has one pool for edge calls and a separate pool for provider calls, so slow provider calls cannot block settlement. A request over the limit gets a retryable `busy` reply at once. A busy `provider.recover` is a retryable step and does not settle the delivery in doubt.

The bus loop of the delivery service is the only reader of `provider.deliver.result`. It gives each result to the step that waits for it. The result and the time limit of the step race to complete one value, so exactly one of them wins. When a `provider.deliver` request times out, the service sends `provider.deliver.cancel`, and the bridge aborts the provider call. A result that arrives after the time limit settles the delivery the same way as a provider receipt.

A wake over the drain limit waits in a bounded queue and starts when a drain ends. A second wake for a queued or running session keeps its place, and a wake that does not send new messages never cancels one that does. A receipt wake that the full queue refuses is tried again each time a drain slot or a queue place frees. A stop or a settlement removes the session from the refused receipt wakes. A merged wake keeps the higher run, and a wake for an older run than the running drain is ignored. A takeover acknowledgement waits until every covered handover has settled, and a `stale` acknowledgement is a pending step, not a takeover.

The service layer builds the bus first, then the bridge, then the delivery service. Disposal runs in the opposite order, so the bridge answers the settlement of a step that is still running.

## Left for the provider adapter extraction

The legacy delivery paths in `apps/cli/src/daemon.ts` are kept untouched while Claude Code and tmux dialects move into provider adapters:

- `deliverMessage`, `handlePendingMessageBatch`, and `scheduleMessageRetry` in `apps/cli/src/daemon.ts`
- `claudeSdkBackend`, `injectViaTmux`, and `injectViaTerminal` delivery handlers in `apps/cli/src/daemon.ts`
- Legacy Codex app-server turn start and execution work subscription polling (`pilotPolls`) in `apps/cli/src/execution/runtime-rail.ts`
- Fenced runtime host callbacks wired from `apps/cli/src/daemon.ts` into `apps/cli/src/execution/drivers/start-fenced-runtime.ts`
