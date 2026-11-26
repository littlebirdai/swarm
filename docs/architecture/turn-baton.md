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
   it names. A null token requires a person who started that turn and
   the absence of a claim row. The first contest creates the starter's
   claim and records the other person's message as queue in one write
   transaction. A pending takeover holds new steers.
3. Between turns, take the oldest queue message. A steer for an ended
   or replaced turn settles as stale without applying its text. A
   client can explicitly submit that text as queue. A steer that loses
   the baton before start also settles without effect.
4. A later steer can pass a waiting queue row. It cannot pass an older
   eligible steer or an occupied slot. For example, if 12 waits for
   turn end and 13 and 14 are eligible steers, reserve 13 first. When
   13 settles, 12 is still the oldest nonterminal row. When the turn
   ends, 12 becomes eligible with its original sequence.
5. Reserve the message and set the session's active attempt in one
   transaction. At start, check the exact attempt, message, sequence,
   epoch, runtime, and run lease. Check the current turn and baton in
   that transaction too. A stale start clears a slot only if it still
   owns the unstarted attempt. A replay of a started permit is for
   recovery. An ambiguous attempt blocks both intents until resolution.
   A person must authorize any resend of a steer that was in doubt.

Maintain `next_nonterminal_sequence` as the oldest unsettled sequence
across both intents. The active attempt can name a later sequence.
Settlement recomputes the oldest unsettled row and must preserve any
earlier gap. Boot transfer and epoch transition use the exact active
attempt as effect authority. An older waiting row cannot free that slot.
If a run loses its negotiated capability, recover its existing attempt
under the original rules before issuing a queue permit to its successor.

## Storage and migration

| Record           | Fields and indexes                                                                                                                                                                                                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pending message  | Store effective intent and, for steer, the observed turn ID and its start event sequence. Reuse the existing delivery ID, epoch, status, and conversation sequence. Add an index on conversation, epoch, delivery status, intent, and sequence for the pending queue and steer lookups. |
| Delivery attempt | Copy the effective intent, expected turn, and checked baton token onto the attempt. Preserve them across retries of the same permit. The existing active attempt ID and sequence index identify the attempt and its message.                                                            |
| Turn projection  | Store the verified starter and start event sequence with the open turn. The existing conversation-and-run index locates the projection. The start event sequence distinguishes a reused turn ID after boot transfer.                                                                    |
| Execution head   | Keep one admission counter, one oldest nonterminal sequence, and one active delivery attempt ID. Use the existing conversation index.                                                                                                                                                   |

Read an older fenced row with no intent as queue. Keep its sequence,
epoch, and delivery ID. Preserve the interpretation of an existing
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

| Function                                                                                                                                           | Change and test                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `enqueuePendingMessage`, `allocateFencedDeliveryMetadata`, `releaseQueuedRows`                                                                     | Record queue intent and observed turn without a second order. Test an atomic join, replay after interruption, and migration of sequenced and unsequenced rows.                                         |
| `claimNextDeliveryInDb`, `orderedNonterminalMessages`, `rejectHeadDeliveryInDb`                                                                    | Select and reject the exact eligible row. Test queue 12, steers 13 and 14, then queue 12 again between turns. Test that a caller cannot choose a later eligible row by ID.                             |
| `verifyAttemptFence`, `startDeliveryInDb`                                                                                                          | Recheck turn and holder with the existing slot and epoch checks. Test lease expiry, holder change, takeover, turn ID reuse after boot transfer, and an agent or second person presenting a null token. |
| `finishTerminalDelivery`, `advanceNonterminalHead`, `releaseClaimBeforeEffectInDb`, `failDeliveryBeforeEffectInDb`, `resolveAmbiguousDeliveryInDb` | Free or hold the exact attempt and preserve the earlier gap. Test duplicate settlement, an ambiguous steer, and a person-authorized resend with a fresh ID.                                            |
| `claimExecutionStartInDb`, `cancelUnstartedOldEpoch`, `cancelFencedDeliveriesOnKill`                                                               | Keep exact-slot authority across boot transfer, epoch transition, and cancellation. Test adoption of a later active attempt with an earlier queue row, and reject the old boot's start.                |
| `appendRunEvents`, `clearEventTurn`                                                                                                                | Preserve the turn instance and verify the starter from the corresponding server admission. Test split event batches and prompt changes during the turn.                                                |

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
