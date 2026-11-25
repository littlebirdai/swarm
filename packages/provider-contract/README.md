# Provider contract

The machine service uses one `ProviderAdapter` for an exact agent and version.
`observe` opens a transcript stream. An observed session can also send
best-effort input to a bound pane. `start` and `resume` open an owned session
with a structured control channel. An owned session exposes a provider
checkpoint for a later run. Call `getCheckpoint()` when you need to save or
resume it. This live read returns the latest checkpoint known to the adapter.
The provider can change it during a run.

The adapter uses promises for requests and an async iterable for events.
Plain TypeScript can await and iterate them directly. An Effect adapter can
bridge scoped operations and a stream at this boundary while keeping its
services, scopes and Schema decoders in the adapter package. Expected
operation failures resolve to tagged outcomes. Unexpected defects can reject
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
A paste also names a positive integer pane instance. An interrupt requires the
active turn. An answer requires the run, fencing token and pending prompt ID.
Compare the guard with the current position immediately before the effect.
A null turn means confirmed idle. Refuse before effect if you cannot verify the
position. Stale results identify the observed turn, prompt or pane. A prompt
observation can report a null run or prompt ID. The terminal observation names
the run and omits the fencing token. The machine can map it to the edge terminal observation
with a null token. `unsupported`, `refused`, `stale` and `closed` have no agent
or pane effect.

`accepted` means the provider durably recorded the delivery. A retry with the
same delivery ID first checks the fence. A valid retry returns `duplicate`
with the same receipt and emits no second receipt event. If the adapter
supports resume, it exposes recovered receipts from earlier runs of the
session. The machine records delivery start before it calls the adapter.

A clean write without a durable receipt returns `in-doubt` with reason
`best-effort`. This includes a successful paste, SDK enqueue, or structured
transport acknowledgment without durable receipt support. Use reason
`unknown` when a crash or timeout prevents the adapter from determining
whether the write took effect. Both reasons carry a diagnostic code and
message. The machine can reconcile the outcome with transcript evidence.

A turn can end between the local check and a write on an unfenced wire. If
the adapter learns of the turn end after the write, settle the operation
from the write evidence. Return `accepted` for durable acceptance or
`in-doubt` when the adapter lacks that evidence. A `stale` result requires
proof that the write had no effect.

For interrupt and answer, `applied` means the provider confirmed the control
operation. These operations do not emit inbox delivery receipts. If the
effect of an open is unknown, the caller must resolve the old runtime before
it starts another run.

One consumer reads each session's event stream. Each event uses the edge
contract's envelope, kind and body. Durable events have increasing `seq`
values above the supplied `afterSeq`. Use `0` when the session has no
committed events. Transient `message.delta` events use the edge contract's
unsequenced shape. The machine coordinates sequence ownership when it
changes sources. Terminal frames travel through the relay. Adapters decode
provider payloads and retain undecodable raw payloads.

The adapter bounds pending events and applies backpressure when the reader
falls behind. A source that cannot pause needs a bounded handoff to durable
storage or an explicit stream failure. It cannot silently drop durable events.
The iterator's `return()` releases the subscription and completes pending
reads and event writes. The caller still closes the session to release its
runtime resources. A process exit emits `session.ended` before the stream
completes. An unexpected adapter defect rejects the iterator.

Concurrent and repeated `close` calls share one result and release the
session once. Close fences new writes and any operation that still waits to
write. A write already in progress settles according to its evidence.
Closing observation releases its watch and paste access. Closing ownership
also stops its process and control channel. After close settles, pending
reads complete and late notifications cannot surface. If release fails,
close returns the same typed failure on each call and keeps the stream and
controls closed. The machine still needs proof before it replaces the runtime.

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
Bun test. Supply a fresh adapter with a controllable provider or pane for each
case. Feed events through the provider boundary and supply their expected
canonical records. Report the effects that reach the provider and the
resources that close. Feed a non-turn event first so an idle steer can still
run. Use separate hooks for a running turn and a pending prompt. Provide a
write gate if the transport can pause before a write. A fixture can leave its
checkpoint stable. Specify whether the stream blocks producers or fails on
overflow. Signal process exit and adapter defects through the fixture.
