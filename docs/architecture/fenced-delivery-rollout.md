# Roll out fenced delivery

The target is one inbox per runnable session. The server assigns the delivery ID and
sequence, the current runtime claims a permit before acting, and settlement
records what happened. A send from another session queues by default. The
recipient's owner can grant steer to one sending session. A grant applies only
to that sender and a verified open turn. See [Edge events](edge-events.md).

## Paths to migrate

- **Daemon inbox.** `getPendingMessagesForDaemon` feeds the subscription,
  fallback poll and launch-prompt lookup. `claimPendingMessageForDelivery` grants
  the legacy claim. The daemon sends into a live pane, protocol bridge or
  Codex app-server thread. It can also repair and resume a transcript, carry
  input into launch, or start a fresh runtime on first delivery.
  See `apps/server/convex/pendingMessages.ts` and `apps/cli/src/daemon.ts`.
- **Launch and resume.** Composer and quick starts, task and role spawns,
  cloud placement, fork copies and imports can leave sessions on the legacy
  rail. Device commands start or resume the runtime. See
  `apps/server/convex/dispatch.ts`, `apps/server/convex/devices.ts`,
  `apps/server/convex/cloud.ts`, `apps/server/convex/forkCopy.ts`
  and `apps/server/convex/sessionRestart.ts`.
- **Hosted assistant.** The hosted turn engine reads pending input and decision
  answers and consumes them in its own turn transactions. See
  `apps/server/convex/assistant/input.ts` and
  `apps/server/convex/assistant/turns.ts`.
- **Queue producers.** Person and joint sends, session-to-session and role
  sends, trigger firings, task and decision notices, replies and recovery
  messages converge on `enqueuePendingMessage`. Explicit queue, deferred and
  held rows can still take the legacy branch on a fenced session. Some
  record-only notes intentionally wake no runtime. See
  `apps/server/convex/pendingMessages.ts` and `apps/server/convex/dispatch.ts`.
- **Prompt responses.** Legacy responses can travel as inbox messages or
  through `sendKeysToSession`. The fenced prompt-answer route already has its
  own epoch-bound claim and settlement. See
  `apps/server/convex/sessionRestart.ts`, `apps/cli/src/codex-prompt-cards.ts`
  and `apps/server/convex/lib/edge/prompt-answers.route.ts`.
- **Queue state and settlement.** Legacy paths release, reorder, merge, retry,
  reset and cancel rows. Daemon status writes and transcript echoes can settle
  legacy input. The stuck-message sweep retries, revives or expires it. Account
  moves relink the queue, and role code checks whether a legacy message is
  unsettled. See `apps/server/convex/pendingMessages.ts`,
  `apps/server/convex/messages.ts` and `apps/server/convex/orgRoles.ts`.

## Rollout order

1. **Make one runtime ready for new sessions.** Start with a fresh, local
   Codex session on a device that can run the owned app-server adapter. Register
   that capability on the current daemon boot. Let that adapter accept
   server-assigned conversation IDs and publish `steer-baton-v1` as a ready
   capability. Today the pilot selects one configured conversation at epoch 1,
   and the ready mutation accepts only the four base execution capabilities.
   The daemon work feed only signals new inbox rows for that selected pilot.
   The steer tests set the extra capability directly on the database row.
   A creation flag alone would leave a new session without the intended
   consumer or turn-aware admission.
2. **Gate new-session enrollment.** Behind a default-off flag, create the
   first binding and head in the same transaction as the conversation, before
   the first send and without scheduling a legacy start. Admit agent input as
   queue unless the verified sending session holds the owner's grant and the
   current turn is eligible. Check the grant and turn again before starting the
   effect. Test creation through the normal launch route, a granted and an
   ungranted send during an open turn, grant revocation, and creation with the
   flag off. Disable enrollment without demoting any session already fenced.
3. **Move the other launch and delivery paths.** Add fenced runtime support
   per adapter and move quick launches, spawns, first-send starts, cloud ends
   of launches, resumes and forks as each path qualifies. Move hosted input
   behind the same delivery lifecycle with the hosted worker as claimant.
   Route prompt replies through the epoch-bound prompt answer path. Test
   startup, reconnect, lost receipts and prompt replay on each path.
4. **Move queue operations and system sends.** Replace the legacy held,
   release, reorder, merge, retry, cleanup and settlement paths with fenced
   transitions. Keep record-only input outside the runnable queue. Check FIFO
   order, stable delivery IDs, sender attribution and single settlement across
   retry, cancellation, account move and transcript replay.
5. **Convert existing runnable sessions and remove legacy delivery.** Stop
   legacy delivery, account for injected or uncertain input, then activate an
   epoch through the quiescence gate. Migrate in bounded batches. Check that no
   runnable session or deliverable row lacks fenced authority before removing
   legacy daemon polling, echo settlement and every `isFencedPendingMessage`
   branch.

The current blockers for the first enrollment are in
`apps/cli/src/execution/codex-owned-pilot.ts`,
`apps/cli/src/execution/runtime-rail.ts`,
`apps/server/convex/lib/execution-work.feed.ts`,
`apps/server/convex/lib/edge/execution.validators.ts` and
`apps/server/convex/lib/execution-daemon.state.ts`.
