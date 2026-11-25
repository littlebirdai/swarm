# Provider contract

The machine service uses one `ProviderAdapter` for an exact agent and version.
`observe` opens a transcript stream. An observed session can also send
best-effort input to a bound pane. `start` and `resume` open an owned session
with a structured control channel. An owned session exposes a provider
checkpoint for a later run.

The adapter uses promises for requests and an async iterable for events.
Plain TypeScript can await and iterate them directly. An Effect adapter can
bridge scoped operations and a stream at this boundary while keeping its
services, scopes and Schema decoders in the adapter package. Expected
operation failures resolve to tagged outcomes. Unexpected defects may reject
a request or fail the iterator and reach the supervisor.

## Capabilities

`negotiateCapabilities` intersects the offers for the exact agent and
version with the caller's allowed capabilities. Multiple exact offers
must agree on a capability before it is enabled. Unknown versions and
agents start with no capabilities. Without `own`, observation and an optional
pane binding are still available, and the owned capabilities are cleared.

| Capability       | What the adapter can do                                                         |
| ---------------- | ------------------------------------------------------------------------------- |
| `own`            | Start an owned run with a structured channel                                    |
| `receipts`       | Record durable delivery IDs and recover them on resume when resume is supported |
| `steer-mid-turn` | Send into the named active turn                                                 |
| `interrupt`      | Request interruption of the named active turn                                   |
| `prompts`        | Answer the named pending prompt                                                 |
| `resume`         | Reopen a provider checkpoint in an owned run                                    |

The offer describes functionality for the negotiated version. The open
session mode determines which operations that handle can perform. A
read-only observation refuses all control. Observation with a pane can steer
only when the adapter can confirm the pane instance and idle position.
Owned sessions can send at idle even without `steer-mid-turn`.

## Delivery and lifetime

A steer carries the delivery ID and the expected run, turn and fencing token.
A paste also names the pane instance. An interrupt requires an active turn,
and an answer also requires the prompt ID. Compare the expected state with
the current position immediately before the effect. A null turn means
confirmed idle. If the position cannot be verified, refuse before effect.
A `stale` return reports the current position without exposing the token.
`unsupported`, `refused`, `stale` and `closed` have no agent or pane effect.

`accepted` means the provider has durably recorded the delivery. A retry
with the same delivery ID under a valid fence returns `duplicate` with the
same receipt, without sending again or emitting another receipt event.
`resume` exposes recovered receipts for reconciliation, including receipts
recorded under an earlier run of the session. The machine service records
delivery start before invoking the adapter and decides when to retry. Without
receipts, a completed paste is `in-doubt` with reason `best-effort`. An
unconfirmed effect is `in-doubt` with reason `unknown`. The machine can
reconcile these outcomes using transcript evidence.

For interrupt and answer, `applied` means the provider confirmed the control
operation. These operations do not mint inbox delivery receipts. An open
operation with an unknown effect is also `in-doubt`. The caller must resolve
the old runtime before starting another run.

One consumer reads the session's event stream. Each event uses the edge
contract's envelope, kind and body directly. Durable events have increasing
`seq` values above the supplied `afterSeq`. Transient `message.delta` events
use the edge contract's unsequenced shape. The machine service coordinates
sequence ownership when changing sources. Terminal frames travel through the
relay. Provider payload decoding and retention of undecodable raw payloads
belong to the adapters.

Concurrent and repeated `close` calls share one result and release the
session once. Closing observation releases its watch and paste access.
Closing ownership also stops its process and control channel. After close
settles, pending reads complete and no event can surface, even if a late
provider notification arrives. If release fails, close reports the failure
and the machine still needs proof before replacing the runtime.

## Existing driver mapping

| RuntimeDriver member                 | Provider contract mapping                                                                        | Responsibility outside the contract                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `transport`, `supportedAgents` | The selected adapter reports an exact agent and version                                          | Adapter selection and transport identity                                                                                                     |
| `capabilities`                       | Negotiate the six provider capabilities                                                          | Legacy runtime capabilities describe a different layer                                                                                       |
| `start`                              | `start` for structured ownership. A launched TUI can be observed with a pane binding             | TUI launch, managed tags and lease placement                                                                                                 |
| `adopt`                              | `observe` a live transcript or `resume` a known checkpoint after ownership is safe to reopen     | Inspect the managed namespace and distinguish alive, proven missing and unknown. Blind adoption of a running process is outside the contract |
| `deliver`                            | `steer` at idle or inside a supported turn. Use the authorized delivery ID and expected position | Permit acquisition, queue ordering and server settlement                                                                                     |
| `stop`                               | `close` releases the handle and stops an owned process                                           | Terminate externally managed panes                                                                                                           |
| `quarantine`                         | `close` removes access through the handle                                                        | Isolate conflicting external runtimes and prove they are gone                                                                                |

| Dialect                    | Observe and own                                                                                                | Operations and limits of the current code                                                                                                                                                                                                                                            |
| -------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude Agent SDK           | JSONL observation. An SDK host starts or resumes a query                                                       | Streamed input can take priority at a tool boundary. The host can interrupt and answer by request ID. It deduplicates sends in a bounded in-memory map and returns a UUID after enqueue, so the host reply alone cannot satisfy durable receipts                                     |
| Codex app-server           | Rollout observation. `thread/start` and `thread/resume` provide ownership primitives                           | The driver sends `turn/start` for delivery. The client has `turn/interrupt` and approval responses. This driver has no mid-turn steer or durable delivery-ID recovery. An RPC timeout can leave delivery unknown                                                                     |
| Grok ACP                   | `updates.jsonl` observation. ACP `session/new` and `session/load` provide ownership primitives                 | `session/prompt` runs a turn, and input sent during a turn waits. `session/cancel` is a notification. Permission replies name a pending request. Load can replay historical updates. The current ACP client has no durable delivery-ID recovery                                      |
| Transcript plus tmux paste | Watch transcript updates or query the provider's local transcript store. An explicitly bound pane allows paste | A completed paste or Enter can prove input reached the terminal. It cannot prove the agent accepted it. Pane startup, adoption, key injection as general control and process cleanup stay with the machine runtime. A session started by hand can be observed without a pane binding |

Provider-specific model selection, permission-mode changes and prompt-card
annotation remain outside this interface. An owned adapter that uses a shared
provider process must establish which resources it can close for its run.

## Adapter tests

Import `providerConformance` from `@codecast/provider-contract/test` in a
Bun test. Supply a fresh adapter and a controllable provider or pane for each
case. Feed two ordered events through the provider boundary and supply their
expected canonical records. Use the fixture's effect and release counts to
report what actually reached the provider and what resources closed. The
suite checks ordering, duplicate receipts across concurrent calls and
resume, stale and unsupported results, and close behavior. A separate
receipt-capable fixture exercises durable recovery because none of the
present transport paths proves that guarantee.
