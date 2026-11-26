# Steer admission in the delivery kernel

This design applies to fenced sessions with the turn baton flag on and a
daemon that supports `steer-baton-v1`. The current kernel reserves the
oldest nonterminal row. If that row must wait for the turn to end, the
kernel cannot reserve a later steer. Select the oldest **eligible** row
and keep the existing session-wide delivery slot.

## Admission rules

1. At enqueue, give every message one server-assigned
   `conversation_sequence`, one delivery ID, and an admission epoch.
   Preserve those values on retries. The sequence is the order of
   records in the inbox and the tie-breaker among eligible messages.
2. During an open turn, queue messages wait. A steer is eligible when
   the sender still has send access and holds the baton for the turn
   it names. A null token requires the verified person who started that
   turn, no active steer claim, and an unconverted implied right for that
   turn instance. The first contest grants the starter's claim, marks
   the turn converted, and records the other person's message as queue
   in one transaction. After conversion, an expired or released claim
   leaves the baton free for the next eligible sender. It cannot restore
   the starter's implied right. A pending takeover holds new steers.
3. Between turns, take the oldest queue message. A steer for an ended
   or replaced turn settles as stale without applying its text. A
   client can explicitly submit that text as queue. Bind each pending
   steer to the baton token accepted at enqueue, including an explicit
   null for an implied right. A steer admitted under token 1 stays stale
   if its sender later acquires token 3.
4. A later steer can pass a waiting queue row. It cannot pass an older
   eligible steer or an occupied slot. For example, if 12 waits for
   turn end and 13 and 14 are eligible steers, reserve 13 first. When
   13 settles, 12 is still the oldest nonterminal row. When the turn
   ends, 12 becomes eligible with its original sequence.
5. Reserve the message and set the session's active attempt in one
   transaction. At start, check the exact attempt, message, sequence,
   epoch, runtime, and run lease. Check the current turn and baton in
   that transaction too, using the original admitted token. A stale start
   clears a slot only if it still owns the unstarted attempt. A replay of a started permit is for
   recovery. An ambiguous attempt blocks both intents until resolution.
   A person must authorize any resend of a steer that was in doubt.

The permit selection transaction terminally rejects an unreserved pending
steer as soon as it can prove its turn or token stale. Set
`delivery_status: "rejected"`, set `status: "cancelled"`, and record the
stale reason. Recompute the oldest unsettled sequence in the same
transaction. This path creates no attempt and leaves the active slot alone.
During `drain-current`, the runtime disposition transaction checks the run
lease and uses the same stale-row cleanup before it counts remaining
messages. If valid work remains after cleanup, return `{ accepted: false }` so
the caller can retry and the cleanup commits.

Maintain `next_nonterminal_sequence` as the oldest unsettled sequence
across both intents. The active attempt can name a later sequence.
Settlement recomputes the oldest unsettled row and must preserve any
earlier gap. Boot transfer and epoch transition use the exact active
attempt as effect authority. An older waiting row cannot free that slot.
If a run loses its negotiated capability, recover its existing attempt
under the original rules before issuing a queue permit to its successor.

## Storage and migration

| Record           | Fields and indexes                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pending message  | Store effective intent and, for steer, the observed turn ID, its start event sequence, and the admitted baton token or null. Reuse the existing delivery ID, epoch, status, and conversation sequence. Add an index on conversation, epoch, delivery status, intent, and sequence for the pending queue and steer lookups.                                                                                                   |
| Delivery attempt | Copy the effective intent, expected turn, and checked baton token onto the attempt. Preserve them across retries of the same permit. The existing active attempt ID and sequence index identify the attempt and its message.                                                                                                                                                                                                 |
| Turn projection  | Store the verified starter, start event sequence, and `baton_converted` with the open turn. Set the marker when an explicit claim becomes authoritative for that turn, including one already active at turn start. Drop the marker when the turn ends or its projection resets. The existing conversation-and-run index locates the projection. The start event sequence distinguishes a reused turn ID after boot transfer. |
| Execution head   | Keep one admission counter, one oldest nonterminal sequence, and one active delivery attempt ID. Use the existing conversation index.                                                                                                                                                                                                                                                                                        |

Look up pending queue rows under both index keys, `intent: "queue"` and
`intent: undefined`. Merge the two ordered results by original sequence
before selecting the oldest eligible queue row. A legacy row at 10 must
win over an explicit queue row at 11. Keep each row's sequence, epoch,
and delivery ID. Preserve the interpretation of an existing
claimed, started, or ambiguous attempt until it settles. Enable the new
selector for a session only after these attempts drain or recovery
resolves them. Leave legacy sessions on their current path.

Some fenced sessions can have old unsequenced rows in the shared queue.
At idle cutover, allocate sequences to those rows in their existing queue
order, using the same allocation transaction as new sends. Append them
after existing allocated sequences and before new admissions. Preserve
their client IDs and mark them as queue. If older rows lack a delivery ID,
mint it once in that transaction. Use the existing row as the migration
receipt so a restart cannot allocate a second sequence. Leave held notes
outside this conversion. Keep the flag-off path and its read and write
counts the same.

## Kernel changes and proof

The module names below follow the execution binding split.

| Module and functions                                                                                                                                                                                                        | Change and test                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pendingMessages.ts`, `executionBindings.ts`, `pendingMessageWrites.ts` — `enqueuePendingMessage`, `allocateFencedDeliveryMetadata`, `releaseQueuedRows`                                                                    | Record effective intent and, for steer, the observed turn and admitted token. Test atomic join and migration of sequenced and unsequenced rows.                                                                                                                                                                                                         |
| `lib/execution-delivery.attempts.ts`, `lib/executionQueue.ts` — `claimNextDeliveryInDb`, `rejectHeadDeliveryInDb`, `orderedNonterminalMessages`                                                                             | Select and reject the exact eligible row. Test legacy queue 10 before explicit queue 11, then queue 12 waiting while steers 13 and 14 deliver. Test that a caller cannot choose a later eligible row by ID.                                                                                                                                             |
| `lib/execution-delivery.attempts.ts` — `verifyAttemptFence`, `startDeliveryInDb`                                                                                                                                            | Recheck the admitted token and turn with the existing slot and epoch checks. Test expiry, takeover, token 1 followed by token 3 for the same sender, reused turn IDs, and invalid null-token senders.                                                                                                                                                   |
| `lib/execution-delivery.attempts.ts`, `lib/execution-binding.state.ts` — `finishTerminalDelivery`, `releaseClaimBeforeEffectInDb`, `failDeliveryBeforeEffectInDb`, `resolveAmbiguousDeliveryInDb`, `advanceNonterminalHead` | Free or hold the exact attempt and preserve an earlier gap. Test duplicate settlement and ambiguous steer recovery.                                                                                                                                                                                                                                     |
| `executionBindings.ts` — `abandonAmbiguousAndResendInDb`                                                                                                                                                                    | A person-authorized resend gets a fresh ID and sequence and enters as queue without the old turn or baton token. Test the new intent and idempotent resend replay.                                                                                                                                                                                      |
| `lib/execution-daemon.state.ts`, `executionBindings.ts` — `claimExecutionStartInDb`, `publishRuntimeDispositionInDb`, `cancelUnstartedOldEpoch`, `cancelFencedDeliveriesOnKill`                                             | Keep exact-slot authority across boot transfer, epoch transition, and cancellation. Test adoption of a later active attempt and old-boot refusal. Test that an unreserved stale steer reaches terminal rejection and cannot pin `drain-current`.                                                                                                        |
| `lib/edge/runEvents.ts`, `lib/claims.ts` — `appendRunEvents`, `clearEventTurn`, `claim`                                                                                                                                     | Preserve the turn instance and verify its starter. Test split event batches, prompt changes, and a second sender taking the baton after the starter's materialized claim expires in the same turn.                                                                                                                                                      |
| `edgeDelivery.ts` — `deliveryFields`, `next`, `start`, `settle`                                                                                                                                                             | Emit the recorded intent, and include `baton_token` and `expected` on steer permits. Check steer authority before start. Settle against the exact attempt and its stored steer fields, even if the turn or holder changed after start. An in-doubt steer cannot requeue automatically. Test wire fields, stale start, and settlement after turn change. |

Add kernel cases beside the existing [execution binding tests](../../apps/server/convex/execution-bindings.test.ts)
and run the same key cases through the [edge routes](../../apps/server/convex/edge-delivery.test.ts).
Compare transaction metrics with the flag off. Add a two-sender case that
checks both delivery order and the persisted inbox sequences.

## What the models check

[TurnBaton](../../tests/models/TurnBaton.tla) checks one steer in flight,
holder-only start, no intrusion, and no duplicate delivery. Its
`SendWhileHolding` transition can send a holder's waiting message while a
different sender waits. Removing the takeover guard permits an intrusion.
[CoSteer](../../tests/models/CoSteer.tla) makes queue eligible only between
turns and lets a holder steer during a turn. Neither model assigns server
sequence numbers. They support choosing among eligible messages. The
oldest-eligible rule and preservation of earlier gaps need kernel tests.
[Delivery](../../tests/models/Delivery.tla) checks the permit and epoch
rules. [FencedTakeover](../../tests/models/FencedTakeover.tla) checks when
the holder can change after a start.
[LoneJoin](../../tests/models/LoneJoin.tla) keeps the turn converted after
the holder's lease lapses. Its `GoneHolderFreesBaton` property depends on
the starter's implied right staying unavailable for that turn instance.
