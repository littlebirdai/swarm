# Move a fenced conversation

## First change

Refuse device and runner transfers while `execution_protocol_state` has
a value. This includes legacy quiescence. Reject the request before it can change ownership, release the source,
claim a cloud checkout, or queue a resume.

Today a same-account move changes the conversation device and leaves
the execution epoch and ready row in place. The destination cannot claim
that row. The old lease can survive the move and work again after a move
back. An unstarted permit can stay at the queue head.
[Device writers](../../apps/server/convex/devices.ts) · [Run leases](../../apps/server/convex/lib/edge/runLease.ts)

On main, `claimExecutionStart`, `rejectHeadDelivery`,
`releaseClaimBeforeEffect`, and `abandonAmbiguousAndResend` do not compare
the caller's device with the conversation device. They check the current
execution row or the attempt fence. The first change leaves these
mutations to the fenced execution protocol.
[Execution authority](../../apps/server/convex/executionBindings.ts)

| Writer                                                                   | Behavior for a conversation under the execution protocol                                                                                                          |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `moveSessionToDevice`, `reparentSessionToDevice`, `reassignToDevice`     | Refuse with a reason before the ownership or command writes.                                                                                                      |
| `claimConversation`, `claimConversationForStart`, `setConversationOwner` | Refuse the legacy claim or set. The pre-start claim returns `won: false` and the reason.                                                                          |
| `claimDeviceAccount`                                                     | Scan bounded pages and move eligible legacy rows. Count each fenced row as skipped and report the refusal with the final count.                                   |
| `registerManagedSession`                                                 | Return `notOwner` and the reason for a different device. Other registrations can refresh the managed row and heartbeat. They do not write the conversation owner. |
| Cloud `placeConversation`, `claimSharedCheckout`, and `parkOnCloudHost`  | Refuse with a reason before placement, checkout, or spawn writes.                                                                                                 |
| `reconfigureSession`                                                     | Refuse a cloud request or a target device change, even without a pending park. Return `reconfigured: false` with a reason. Dispatch shows the reason to the user. |
| Transcript ingest                                                        | Skip the device backfill. Keep the other ingest updates.                                                                                                          |
| `mergeDuplicateUser`                                                     | Refuse the merge if the source owns an execution head. Check each runner row before the merge writes it. A dry run can still show the proposed changes.           |

A single session with a large linked pending-message queue can still exceed
one transaction. Tests of the current transfer reached this limit at about
16,000 small messages or 850 messages of 10 KB each.

The legacy start and pending-message guards already refuse fenced work.
`moveToRemote` refuses before it queues a transfer. Migration plans skip
fenced rows with a reason. If a session becomes fenced before the transfer
starts, mark the migration row failed.

`runHere` and `enqueueQuiesce` refuse fenced sessions. `failSession`
clears the migration marker and skips the restore command for those sessions. Migration completion uses
the same device move check.

Conversation creation sets the owner on a new row. Only execution
initialization, legacy quiescence, and successor activation set
ownership in the fenced protocol.
[Ingest and un-park](../../apps/server/convex/conversations.ts) · [Registration](../../apps/server/convex/managedSessions.ts) · [Cloud placement](../../apps/server/convex/cloudPlacement.ts) · [Account merge](../../apps/server/convex/admin_mergeUser.ts) · [Migrations](../../apps/server/convex/sessionMigrations.ts)

## Later epoch move

Ship these changes in order. Keep the refusal in the move entry points
until the first two steps pass together.

1. **Record and fences.** Store the source epoch, source lease, attempt,
   destination device and runner, and next epoch. Block source work and
   blob reads at once. Apply the fence to lease claim and renew, permit
   claim and start, event append, and the execution mutations above.
   Clear an unstarted claim and preserve its delivery ID and sequence.

   Let the source settle only its exact started attempt. End the window
   at the earlier of its deadline and the lease's `expires_at`.
   Do not renew the old lease. On expiry, mark the
   attempt ambiguous. Require evidence before delivery continues.

   The internal `edgeRunLease.recordMove` mutation stores the record on the
   execution head. It preserves the current owner and admission epoch.
   The same transaction clears an unstarted claim. It schedules expiry for a
   started attempt with a live lease. If there is no live lease, it marks
   the attempt ambiguous in that transaction.

   Only a started slot opens a settlement window. The source must present
   the recorded lease token while both the attempt and slot are started.
   Releasing the lease closes the window. An ambiguous slot stays held for
   evidence review during successor preparation. While the recorded lease
   and window are live, an identical outcome can return a duplicate receipt
   without changing the slot.

   With `CODECAST_FORCED_DEVICE_MOVE_V1` on, the recorded lease determines
   the deadline. The window ends when that lease expires or 30 seconds
   after the move is recorded, whichever is earlier. An authenticated
   source stop or replacement boot closes it immediately. A missing,
   expired, or released lease gives no window. A forced move closes the
   window at once. With the flag off, an internal normal move keeps the
   10-second limit and still ends at lease expiry if that comes first.

2. **Prepare and activate.** Authorize successor creation from the move
   record and the destination credentials. The source lease token stays
   with the source. Set `owner_user_id` on the destination's `execution_bindings` row.
   Use the destination runner. Authorize `publishReadyBinding`,
   `publishStartFailedBeforeEffect`, `publishStartAmbiguous`, and
   `disposePreReadyBinding` against that row and move record.

   The server can stage the successor and its queue before the source stops.
   It holds destination startup and activation until an authenticated source
   stop releases the exact recorded lease, or the source device confirms a
   newly registered boot. An ordinary release or lease expiry keeps the move
   on hold.

   Set `admission_epoch` to the successor for new messages during the move.
   Retarget the old `pending` rows in indexed batches of at most 100.
   Keep message IDs and sequence numbers. Pause admissions on abort.
   Retarget staged rows to the source before the server restores its
   admission epoch. Require a new source lease after an abort. Abort can
   resume a source binding that has no confirmed stop, once the destination
   has no live or uncertain runtime. A confirmed source stop requires a
   separate recovery path before the source can run again.

   Activate only after the destination is ready and the old attempt has
   a terminal outcome. Transfer the head owner, conversation `user_id`,
   undelivered messages, triggers, and event-run owner together. Preserve
   `author_user_id` or set it to the former runner if it is empty.
   Queue `resume_session` and any continue message only after activation.
   An ambiguous attempt blocks both.

3. **Enable move entry points.** Use the same transition for a move, a
   reparent, and a move back. Test that no old token works after a move back.
   Also test a live or offline source, expiry, abort, partial retarget,
   cross-account readiness and cleanup, and a claim before or after start.
   Test each legacy writer with and without the execution protocol.

Before you enable moves, define how to recover a stopped source if the
destination fails after preparation or after a partial retarget.

## Force a move when the source is unavailable

`CODECAST_FORCED_DEVICE_MOVE_V1` defaults to off. The account that currently
runs the session can explicitly authorize a forced move after acknowledging
that the source may still be running. The server records who authorized it
and when.
The destination still needs its registered boot, exact ready binding, and
the completed queue retarget. A normal move still needs source stop or
replacement boot proof.

A forced move closes the source settlement window immediately. A started
or ambiguous delivery stays in doubt. At activation the same attempt and
message move to the destination epoch, with the same IDs and sequence.
The attempt keeps its source epoch for reference. The destination needs
evidence to settle it and cannot start it again.

Activation releases the old lease and records the force authorization on
the quarantined source binding. The old epoch cannot become current again.
The old device cannot be a move destination for this conversation, even
after it registers a new boot. The server cannot stop a disconnected process
from having effects outside the server. The existing abort and retarget
rules still apply before activation.

## Drive a recorded move

The server schedules a forced move when the owner requests it. For a normal
recorded move, the server schedules work after it verifies the source stop
or replacement boot. Public entry points still refuse normal moves.

The driver prepares the destination binding for its registered boot. The
destination daemon sees the binding in its authenticated execution work feed
and publishes readiness through its usual startup calls. Each scheduled
retarget step processes at most 100 messages with a 512 KiB scan budget.
Activation checks readiness again and transfers ownership in one transaction.

Each job names the move and its driver revision. The server ignores a job
when the move was aborted, replaced, or already advanced. It retries a step
up to ten attempts with exponential backoff capped at 30 seconds. The move
record keeps progress and the last failure. Activation fails without
transferring ownership if more than 100 linked triggers, or more than
512 KiB of trigger data, would need an atomic handoff.

After the driver fails, the session stays parked until its owner confirms a
device choice. Choosing the same device resumes the failed step with a fresh
retry budget if its prepared binding can still run on the current boot.
Otherwise, the driver retires that binding and restores its staged queue in
bounded pages before preparing a fresh epoch. Choosing a different device
uses the same retirement path. The request names the failed move and its
revision so a replay cannot restart a later failure. The source remains fenced throughout. The
abandoned runtime loses server authority, and its binding preserves any
evidence of a local runtime.

The completion receipt is visible for 30 seconds. The former runner must
still have access to the conversation to see it. The current owner can
choose another destination when the current device goes offline and the
receipt has expired.
