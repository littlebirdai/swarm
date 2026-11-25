# Move a fenced conversation

## Current behavior

For execution authority, a same-account move changes only
`conversations.owner_device_id`. It also updates session metadata and can
queue a resume. A reparent can also change the runner account. Neither
path advances the execution epoch or replaces the `execution_bindings` row. The release
command asks the source daemon to stop. An offline daemon can miss it.

[Device moves](../../apps/server/convex/devices.ts) · [Source release](../../apps/server/convex/sessionRelease.ts)

The destination cannot claim the old run. The edge claim compares its
device with the device on the ready `execution_bindings` row.
The start claim checks that device too. The execution head and
`execution_bindings` row can keep the former runner after a cross-account move.

[Run leases](../../apps/server/convex/lib/edge/runLease.ts) · [Execution authority](../../apps/server/convex/executionBindings.ts)

The move does not revoke the source lease. A move back can make the
same token usable again if its epoch, boot, claim, and expiry still match.
On main, the edge lease lookup checks the device on the `execution_bindings` row and does not
check the conversation device. A device equality check stops source work
while the conversation is away. It cannot prevent reuse on return.

[Lease lookup](../../apps/server/convex/lib/edge/runLease.ts)

| Mutation                    | Check on main                                          |
| --------------------------- | ------------------------------------------------------ |
| `claimExecutionStart`       | Checks the runner, epoch, and device on the binding.   |
| `rejectHeadDelivery`        | Checks the runner, epoch, lease, and queue head.       |
| `releaseClaimBeforeEffect`  | Checks the runner, attempt fence, and claimed state.   |
| `abandonAmbiguousAndResend` | Checks the runner, attempt fence, and ambiguous state. |

These mutations do not compare the caller's device with the conversation
device. An unstarted permit can stay on the head after a move. The move
does not call `requeueDeliveryBeforeEffect`, which clears that slot and
keeps the message at its original sequence.

[Execution mutations](../../apps/server/convex/executionBindings.ts) · [Delivery slot](../../apps/server/convex/lib/delivery-slot.state.ts)

## Recommended move

Use one durable move record on the execution head. It names the source
epoch, destination device and runner, and next epoch. The move request
blocks new source work in the same transaction. It returns an unstarted
claim to `pending` at the same queue sequence. The source lease loses
authority for new work, even if the user selects that device again.

Give the source a short window to settle an attempt that it already
started. Require the exact attempt and source fence. This window grants
only the authority to report the outcome. If the window expires without
an outcome, mark the attempt ambiguous and require reconciliation.
Never retry an ambiguous attempt as part of the move.

Prepare an `execution_bindings` row for the destination. Require
proof that the source stopped or that the server quarantined it. Activate
the new epoch only after the destination is ready and the old attempt has
a terminal disposition. Update the conversation owner, runner, and head together.

Retarget queued messages to the new epoch. Keep each delivery ID and sequence.
Require a new lease. A move back consumes another epoch.

[Successor activation](../../apps/server/convex/executionBindings.ts)

The alternative is to refuse fenced moves until these changes ship.
Apply the refusal before a device or runner change or a resume command.
A request for the current device can remain a no-op.

## Implementation slices

1. Route `moveSessionToDevice`, `reparentSessionToDevice`, and
   `reassignToDevice` through one move transition. Route `claimConversation`,
   `claimConversationForStart`, and `setConversationOwner` through the same
   authority check. Extend the move and reparent tests for aborts, retries,
   cross-account moves, and moves back.

2. Update `requestExecutionSuccessor`, `claimExecutionStart`, and
   `activateExecutionSuccessor` to check the recorded destination.
   Keep authorization for a destination in the move record distinct from authority
   for the current epoch. Add tests for concurrent moves, stale tokens,
   and rejection before source stop or quarantine proof.

3. Update `claimNextDelivery`, `startDelivery`, `rejectHeadDelivery`,
   `releaseClaimBeforeEffect`, and `abandonAmbiguousAndResend` to check move
   state before any new effect. Test slot release, queue order, started
   settlement, duplicate settlement, and expired settlement windows.

4. Check the move record in `ownedRun` and `renewRunLease`. Use one window check in `completeDelivery`, `markDeliveryAmbiguous`,
   `resolveAmbiguousDelivery`, and edge settlement. Test the full move
   through edge and Convex. Check that the source cannot read blobs.
   Confirm that the destination gets a new lease on a move and on a move back.

[Move tests](../../apps/server/convex/devices.move.test.ts) · [Reparent tests](../../apps/server/convex/devices.reparent.test.ts) · [Execution tests](../../apps/server/convex/executionBindings.test.ts) · [Edge tests](../../apps/server/convex/edge-delivery.test.ts) · [Lease tests](../../apps/server/convex/run-lease.test.ts)
