# A home for session viewer presence

Use the relay for live session viewers and cursors. Keep draft authorship, draft claims, and each viewer’s last reading position in Convex. A relay disconnect can remove a face or cursor. A send and a saved reading position must survive it.

## What Convex stores today

The `doc_presence` table has one row per user and document key. It stores the user’s display fields, cursor positions, and a server timestamp. On each read, `getPresence` excludes the caller and rows at least 30 seconds old. `removePresence` deletes the whole row. `apps/server/convex/schema/documents.tables.ts:223`, `apps/server/convex/docSync.ts:668`, `apps/server/convex/docSync.ts:800`, `apps/server/convex/docSync.ts:837`.

- **Composer viewers and carets** (`compose:<conversationId>`). The web shows who else is in the composer, their draft previews and suggestions, and their carets in the shared draft. Convex computes `can_send` with the product send rule. `apps/web/components/collab-composer.tsx:86`, `apps/web/components/conversation/GhostDrafts.tsx:31`, `apps/web/hooks/useSharedDraft.ts:150`, `apps/server/convex/docSync.ts:715`.
- **Transcript reading positions** (`compose:<conversationId>`). The transcript uses `anchor` and `anchor_at` for other readers’ faces and jump markers. The anchor names a message and an offset within it. A heartbeat leaves `anchor_at` unchanged unless the position moves. Removal deletes the last position, and expiry hides it. `apps/web/components/conversation-view.tsx:3705`, `apps/web/components/conversation/ReadingMarks.tsx:27`, `apps/web/components/conversation/ReadingMarks.tsx:79`, `apps/server/convex/docSync.ts:721`, `apps/server/convex/docSync.ts:800`.
- **Joint-send authorship** (`compose:<conversationId>`). A direct joint send checks each other named part against a fresh draft preview. The check uses display name and trimmed text. On failure, it wraps the body in the sender’s name. The ordinary composer can also construct a joint wrapper before dispatch, so review both send routes before migration. `apps/server/convex/pendingMessages.ts:1463`, `apps/server/convex/pendingMessages.ts:1532`, `apps/web/components/message-input.tsx:2802`, `apps/server/convex/dispatch.ts:2427`.
- **Draft claims** (`compose:<conversationId>`). Joint sends and suggestion actions put claims on the actor’s row. A recipient clears the matching text and keeps any later suffix. The claim lifetime is 15 seconds. The client sends claims separately from the send. `apps/server/convex/docSync.ts:655`, `apps/server/convex/docSync.ts:756`, `apps/web/hooks/useJointComposer.ts:48`, `apps/web/hooks/useJointComposer.ts:69`, `apps/web/hooks/useJointComposer.ts:98`.
- **Comment previews** (`comment:<conversationId>` or `comment:<conversationId>:<anchor>`). The comment composer uses the row for typing previews scoped to the thread. It can also request a separate scope key. Keep these rows in Convex for this migration. `apps/web/lib/commentThread.ts:95`, `apps/web/components/comments/CommentComposer.tsx:74`, `apps/server/convex/docSync.ts:35`.
- **Document editor cursors** (A `docs` row ID). The document editor uses the row for other editors’ cursors and selections. Convex also uses a recent cursor update to guard whole-body writes while edit steps arrive. Keep this dependency in Convex. `apps/web/components/editor/CollabDocEditor.tsx:126`, `apps/web/components/editor/CollabDocEditor.tsx:335`, `apps/server/convex/lib/docBody.ts:80`.

Composer presence currently sends a heartbeat every three seconds while active. It sends draft and cursor changes sooner. A sole owner subscribes but normally starts writes only when another viewer appears. The shared draft’s text and revision already travel through Convex document sync. `apps/web/hooks/useDocPresence.ts:82`, `apps/web/hooks/useDocPresence.ts:104`, `apps/web/components/collab-composer.tsx:79`, `apps/web/hooks/useSharedDraft.ts:196`, `apps/server/convex/docSync.ts:181`.

Other Convex records serve different features. `user_presence` supplies desktop activity for push policy and an access-checked session indicator for the team roster. `live_presence` serves artifact cursors and selections. Follow mode uses `view_states` for a leader’s current position while a follower has a live lease. Leave all three in place. `apps/server/convex/pushRouter.ts:94`, `apps/server/convex/pushRouter.ts:616`, `apps/server/convex/teams.ts:627`, `apps/server/convex/livePresence.ts:18`, `apps/server/convex/livePresence.ts:62`, `apps/server/convex/follow.ts:132`.

## Convex records that outlive presence

### Drafts and claims

Add a session draft record keyed by conversation and authenticated author. Store a server-issued revision, the bounded draft preview, and its expiry. Use the existing 2,000-character preview limit and a 30-second offer lifetime. Update on edits, explicit withdrawal, and renewal of an active offer. An empty solo composer needs no row. Use a revision check so a delayed tab cannot replace a newer offer. The authenticated author can offer a suggestion even if they cannot send. Recheck conversation access on reads and writes.

Send each joint part with the author ID and draft revision. In the send transaction, check the acting sender’s send access and each named author’s current conversation access. Check the text against the exact draft revision and derive its display name on the server. Apply the same rule to direct, receipt-backed, and queued joint sends. If an offer changes or expires, ask the sender to review the draft again. Keep ordinary single-author sends on their existing path.

Record each accepted draft claim by send ID, author, and revision in the same transaction as the queue row. The recipient reads only its own claims for sessions it can still open. Remove only the matched text and preserve any later suffix. A retry of the same command must return its prior result and create no second claim. The action that copies a suggestion into another composer needs its own authenticated, idempotent claim for the exact revision. It has no queue row. Keep claims through a brief reconnect and clean up expired offers and claims in bounded batches.

Keep draft text and claims out of relay frames. Continue to use Convex document sync for the shared draft. Derive `can_send` from current Convex permissions, independent of the viewer’s connection.

### Last reading position

Add one private read-anchor record per user and conversation. Store the transcript message ID, offset, and time of the last change. On every read or write, check the authenticated user’s current access. The server must confirm that the message belongs to the readable transcript and that the offset is between zero and one. If the message no longer exists, use the normal transcript landing position.

Measure the current position even when a viewer is alone. Save it on conversation exit and at infrequent checkpoints after meaningful movement. An abrupt close can lose the final save, so restore the last confirmed checkpoint. Use the newest active view and a sequence within that view to reject late writes from an older tab. Do not write at the live cursor rate. Delete these records when the conversation or account is permanently removed. Presence removal, expiration, and relay failure leave them intact. Show other viewers’ positions only from a current live cursor.

## Who gets relay grants

Today the web provider is opt-in through `VITE_RELAY_PRESENCE` and a configured relay URL. It offers one relay client per authenticated window and pauses when the window is hidden or offline. On main, no product consumer uses its context for session presence. `apps/web/components/relay-presence-provider.tsx:32`, `apps/web/components/relay-presence-provider.tsx:70`, `apps/web/components/relay-presence-provider.tsx:117`, `apps/web/lib/relay-presence-config.ts:1`.

The current mint already covers assigned co-owners. `canOwnerOrTeamAccess` accepts the runner, the cached primary owner, and users in `session_owners`. It also accepts teammates with full content access. It omits the shared tier, which the Convex composer uses for signed-in guests. `apps/server/convex/relayGrants.ts:103`, `apps/server/convex/privacy.ts:200`, `apps/server/convex/privacy.ts:228`, `apps/server/convex/privacy.ts:276`, `apps/server/convex/docSync.ts:35`.

For viewer presence, use an isolated session hub with an ID such as `viewer:<conversationId>` under the existing session hub kind. Mint that ID on the server from the canonical conversation ID after `checkConversationAccess`. Keep the existing mint policy for the original hub. A relay grant permits subscription to the entire named hub, regardless of its publish list. Reserve the prefix for this mint purpose. Keep baton and machine grants on the original hub. Issue publish rights only for `presence`, `draft_cursor`, and `reading_cursor`. `packages/relay-contract/src/authorization.ts:31`, `packages/relay-contract/README.md:24`, `packages/relay-contract/README.md:114`.

| Viewer                                                                                                                      | Viewer hub grant                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runner and assigned co-owners                                                                                               | Yes. These roles already have conversation content access and can announce presence.                                                                  |
| Teammate with full content access                                                                                           | Yes. The team visibility rule permits their transcript access.                                                                                        |
| Signed-in guest with a current share redemption or mention read grant                                                       | Yes. The same Convex access rule permits composer presence today. Separate send approval still controls delivery.                                     |
| Anonymous link holder, summary-only teammate without another grant, revoked viewer without another grant, or unrelated user | No. A valid session identity and conversation content access are both necessary. A raw share token and a send-only grant do not satisfy these checks. |

Recheck access on every mint and renewal. Keep the current 60-second ceiling and cap grants at the authentication deadline. Use a shorter ceiling of 15 seconds for the shared tier during the rollout. On access loss, the client clears the hub and releases the grant. An omitted hub in a refresh does not revoke an existing grant. The relay must stop traffic at expiry even if the client fails to release it. The shared-tier rollout therefore accepts up to 15 seconds of access after revocation. If privacy policy requires immediate revocation, leave that rollout off until the relay can enforce revocation from Convex. `apps/server/convex/relayGrants.ts:16`, `apps/server/convex/relayGrants.ts:66`, `packages/relay-contract/README.md:46`.

Use the relay’s authenticated subject and connection ID. Track sequence and TTL per connection, hub, and signal type. Drop stale updates and clear one connection on leave or expiry. Count a person as present while any of their connections remains active. Apply a draft cursor only at its matching revision and a reading cursor only to its matching message. The relay keeps no replay buffer. `packages/relay-contract/src/frames.ts:34`, `packages/relay-contract/README.md:137`, `packages/relay-contract/README.md:160`.

## PR order and rollout gates

Each PR adds its own flag, separate from the existing provider flag. Every new flag defaults to off. Each PR can ship before the next one. Server changes ship before clients that call the new functions. Capture a flag-off baseline for each measure before its canary.

### 1. Save reading positions

Add the private read-anchor API and storage. With the flag on, save checkpoints and the final anchor on clean exit. Copy a valid last anchor from a legacy composer row before removal during the compatibility period. Keep the live reading marks on Convex. The flag restores the old landing behavior.

Test clean exit, lost exit, reconnect, two tabs, stale writes, deleted or inaccessible messages, access revocation, and cross-user reads. Measure anchor writes per viewer-minute, restore success, and fallback to normal landing. Verify zero writes on an idle viewer heartbeat.

### 2. Move draft authorship and claims

Add the draft and claim records behind a flag. With the flag on, populate draft offers from compatible composer updates. Route opted-in sends through the new validator. Keep the legacy endpoints for old tabs during the transition. Project accepted claims into the old read shape from the authoritative record. Roll back by restoring the legacy path while the compatibility data is available.

Test two users with the same name, spoofed IDs, mismatched text or revisions, revoked access, guest suggestions, queued and direct sends, retries, send failure, and edits after capture. Check that a successful send produces one queue row and one claim per accepted part. Measure writes per edit, added mutation reads, send latency, mismatch rate, and cleanup counts. Include zero extra draft writes for an empty solo composer.

### 3. Issue isolated viewer grants

Add the viewer hub mint purpose behind a server flag. Start with owners and full-content teammates. Add a separate off-by-default flag for the shared tier. Keep existing session hub grants and web presence unchanged. Disable issuance to roll back and let existing grants expire.

Extend `apps/server/convex/relay-grants.test.ts` and the relay contract tests. Cover each viewer tier, auth expiry, share rotation, team departure, removed ownership, forged hub IDs, cross-hub subscriptions, and forbidden signal types. Measure mint requests and reads per active viewer, denials, refresh errors, and time from revocation to the last accepted frame. Verify the 15-second shared-tier bound and zero frames across the hub boundary.

### 4. Compare relay and Convex views

Add the web adapter behind a flag. Keep the Convex view active. Publish relay signals in the canary and compare the two views with content-free counters. Keep draft text and claim reads in Convex. Scope the client to the signed-in account and window.

Extend `apps/web/components/relay-presence-provider.mount.test.tsx` and the composer tests. Cover two accounts, multiple tabs, hidden windows, lost departures, relay restart, late join, missing grants, and stale cursor revision. Measure join and leave latency, undercounts and duplicate faces, frames and bytes per viewer-minute, and reconnect and fallback rates.

### 5. Use the relay for live viewer signals

Switch a session cohort behind an off-by-default flag after the draft and anchor paths are ready. Keep the Convex publisher during this step. Use the Convex view for mixed client versions, unknown capabilities, or a relay outage. Use the relay view only for a compatible cohort with healthy subscriptions. Use one source per view and one face per user. An empty relay view can mean nobody is present. Disable the flag to return to Convex.

Test old and new tabs together in either join order, mixed guest and owner access, relay loss during a joint send, revoked access during fallback, and flag rollback. Compare Convex writes and subscription updates per viewer-minute, relay bytes, and p95 join and cursor latency against the baseline. Verify that joint sends and anchor restore work with the relay stopped.

### 6. Stop compatibility presence writes

Gate this step separately. Stop composer heartbeat and cursor writes in cohorts with relay support and no old-tab dependency. Keep fallback and rollback endpoints available. Keep comment and document-editor rows on Convex.

Prove zero Convex composer heartbeat and cursor writes in healthy relay sessions. Measure remaining legacy calls, fallback use, draft and anchor writes, relay load, and lost-viewer reports. Test the rollback with an old tab before each cohort expansion.

Use the same scenarios with the flags off and on. Record counts and latency by cohort and access tier. Keep draft text, message IDs, share tokens, and relay tokens out of the measurements.
