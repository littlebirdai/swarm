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

| Writer                                                                   | Behavior for a conversation under the execution protocol                                                                                                                                               |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `moveSessionToDevice`, `reparentSessionToDevice`, `reassignToDevice`     | Refuse with a reason before the ownership or command writes.                                                                                                                                           |
| `claimConversation`, `claimConversationForStart`, `setConversationOwner` | Refuse the legacy claim or set. The pre-start claim returns `won: false` and the reason.                                                                                                               |
| `claimDeviceAccount`                                                     | Exclude fenced rows from the move scan. Move eligible legacy rows. On the last page, one separate lookup reports if fenced sessions remain. Add one to the skipped count when that lookup finds a row. |
| `registerManagedSession`                                                 | Return `notOwner` and the reason for a different device. Other registrations can refresh the managed row and heartbeat. They do not write the conversation owner.                                      |
| Cloud `placeConversation`, `claimSharedCheckout`, and `parkOnCloudHost`  | Refuse with a reason before placement, checkout, or spawn writes.                                                                                                                                      |
| `reconfigureSession`                                                     | Refuse a cloud request or a target device change, even without a pending park. Return `reconfigured: false` with a reason. Dispatch shows the reason to the user.                                      |
| Transcript ingest                                                        | Skip the device backfill. Keep the other ingest updates.                                                                                                                                               |
| `mergeDuplicateUser`                                                     | Refuse the merge if the source owns an execution head. Check each runner row before the merge writes it. A dry run can still show the proposed changes.                                                |

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
   evidence review during successor preparation. The window uses a
   provisional server constant of 10 seconds.

2. **Prepare and activate.** Authorize successor creation from the move
   record and the destination credentials. The source lease token stays
   with the source. Set `owner_user_id` on the destination's `execution_bindings` row.
   Use the destination runner. Authorize `publishReadyBinding`,
   `publishStartFailedBeforeEffect`, `publishStartAmbiguous`, and
   `disposePreReadyBinding` against that row and move record.

   For an offline source, require server proof that the host stopped or
   that the runtime cannot act. Lease expiry alone gives no such proof.
   If the server cannot prove quarantine, keep the move on hold.

   Set `admission_epoch` to the successor for new messages during the move.
   Retarget the old `pending` rows in indexed batches of at most 100.
   Keep message IDs and sequence numbers. Pause admissions on abort.
   Retarget staged rows to the source before the server restores its
   admission epoch. Require a new source lease after an abort.

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

Before you enable moves, choose the settlement window duration and the
server evidence that proves quarantine. Define how to recover if the
destination fails after preparation or after a partial retarget.
