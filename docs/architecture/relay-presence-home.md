# A home for session viewer presence

Use the relay for live session viewers and cursors. Keep draft authorship, draft claims, and each viewer’s last reading position in Convex. A relay disconnect can remove a face or cursor. A send and a saved reading position must survive it.

## What Convex stores today

The `doc_presence` table has one row per user and document key. It stores the user’s display fields, cursor positions, and a server timestamp. On each read, `getPresence` excludes the caller and rows at least 30 seconds old. `removePresence` deletes the whole row. `apps/server/convex/schema/documents.tables.ts:223`, `apps/server/convex/docSync.ts:668`, `apps/server/convex/docSync.ts:800`, `apps/server/convex/docSync.ts:837`.

- **Composer viewers and carets** (`compose:<conversationId>`). The web shows who else is in the composer, their draft previews and suggestions, and their carets in the shared draft. Convex computes `can_send` with the product send rule. `apps/web/components/collab-composer.tsx:86`, `apps/web/components/conversation/GhostDrafts.tsx:31`, `apps/web/hooks/useSharedDraft.ts:150`, `apps/server/convex/docSync.ts:715`.
- **Transcript reading positions** (`compose:<conversationId>`). The transcript uses `anchor` and `anchor_at` for other readers’ faces and jump markers. The anchor names a message and an offset within it. A heartbeat leaves `anchor_at` unchanged unless the position moves. Removal deletes the last position, and expiry hides it. `apps/web/components/conversation-view.tsx:3705`, `apps/web/components/conversation/ReadingMarks.tsx:27`, `apps/web/components/conversation/ReadingMarks.tsx:79`, `apps/server/convex/docSync.ts:721`, `apps/server/convex/docSync.ts:800`.
- **Joint-send authorship** (`compose:<conversationId>`). A direct joint send checks each other named part against a fresh draft preview. The check uses display name and trimmed text. On failure, it wraps the body in the sender’s name. The ordinary composer can also construct a joint wrapper before dispatch. `apps/server/convex/pendingMessages.ts:1463`, `apps/server/convex/pendingMessages.ts:1532`, `apps/web/components/message-input.tsx:2802`, `apps/server/convex/dispatch.ts:2427`.
- **Draft claims** (`compose:<conversationId>`). Joint sends and suggestion actions put claims on the actor’s row. A recipient clears the matching text and keeps any later suffix. The claim lifetime is 15 seconds. The client sends claims separately from the send. `apps/server/convex/docSync.ts:656`, `apps/server/convex/docSync.ts:756`, `apps/web/hooks/useJointComposer.ts:48`, `apps/web/hooks/useJointComposer.ts:69`, `apps/web/hooks/useJointComposer.ts:98`.
- **Comment previews** (`comment:<conversationId>` or `comment:<conversationId>:<anchor>`). The comment composer uses the row for typing previews scoped to the thread. It can also request a separate scope key. Keep these rows in Convex for this migration. `apps/web/lib/commentThread.ts:95`, `apps/web/components/comments/CommentComposer.tsx:74`, `apps/server/convex/docSync.ts:35`.
- **Document editor cursors** (A `docs` row ID). The document editor uses the row for other editors’ cursors and selections. Convex also uses a recent cursor update to guard whole-body writes while edit steps arrive. Keep this dependency in Convex. `apps/web/components/editor/CollabDocEditor.tsx:126`, `apps/web/components/editor/CollabDocEditor.tsx:335`, `apps/server/convex/lib/docBody.ts:80`.

Composer presence currently sends a heartbeat every three seconds while active. It sends draft and cursor changes sooner. A sole owner subscribes but normally starts writes only when another viewer appears. The shared draft’s text and revision already travel through Convex document sync. `apps/web/hooks/useDocPresence.ts:82`, `apps/web/hooks/useDocPresence.ts:104`, `apps/web/components/collab-composer.tsx:79`, `apps/web/hooks/useSharedDraft.ts:196`, `apps/server/convex/docSync.ts:181`.

Other Convex records serve different features. `user_presence` supplies desktop activity for push policy and an access-checked session indicator for the team roster. `live_presence` serves artifact cursors and selections. Follow mode uses `view_states` for a leader’s current position while a follower has a live lease. Leave all three in place. `apps/server/convex/pushRouter.ts:94`, `apps/server/convex/pushRouter.ts:616`, `apps/server/convex/teams.ts:627`, `apps/server/convex/livePresence.ts:18`, `apps/server/convex/livePresence.ts:62`, `apps/server/convex/follow.ts:132`.

## Convex records that outlive presence

### Drafts and claims

Add a session draft record keyed by conversation and authenticated author. Store a server-issued revision, the bounded draft preview, and its expiry. Use the existing 2,000-character preview limit and a 30-second offer lifetime. Update on edits, explicit withdrawal, and renewal of an active offer. An empty solo composer needs no row. Use a revision check so a delayed tab cannot replace a newer offer. The authenticated author can offer a suggestion even if they cannot send. Recheck conversation access on reads and writes.

Send each joint part with the author ID and draft revision. In the send transaction, check the acting sender’s send access and each named author’s current conversation access. Check the text against the exact draft revision and derive its display name on the server. Apply the same rule to every joint-send route. Keep the existing `sendMessageV2` `runLocalCommand` fingerprint for single-author sends, including its optional quote fields. Add the structured proof to the fingerprint only for joint sends. Treat a stale joint offer as a terminal rejection. Write no queue row or claim. A replay of that command returns the same rejection. After review, the sender can submit the updated offer under a new command ID. `apps/server/convex/pendingMessages.ts:1015`.

The validator must cover these joint-send routes.

- Direct `sendSessionMessage`, including the collaborator composer. `apps/server/convex/pendingMessages.ts:1463`, `apps/web/components/collab-composer.tsx:634`.
- Receipt-backed `sendMessage` via `sendMessageV2`, legacy `sendMessage`, and `queueMessage`. `apps/server/convex/dispatch.ts:2384`, `apps/server/convex/dispatch.ts:2427`, `apps/server/convex/dispatch.ts:2459`.
- **Send as** from a guest suggestion. The client creates a joint wrapper and sends through the ordinary composer path. **Add to my draft** claims the offer without sending. `apps/web/hooks/useJointComposer.ts:98`.

Record each accepted draft claim by send ID, author, and revision in the same transaction as the queue row. The recipient reads only its own claims for sessions it can still open. Remove only the matched text and preserve any later suffix. A retry of the same command must return its prior result and create no second claim. The action that copies a suggestion into another composer needs its own authenticated, idempotent claim for the exact revision. It has no queue row. Keep claims through a brief reconnect and clean up expired offers and claims in bounded batches.

Keep draft text and claims out of relay frames. Continue to use Convex document sync for the shared draft. Derive `can_send` from current Convex permissions, independent of the viewer’s connection.

### Last reading position

Add one private read-anchor record per user and conversation. Store the transcript message ID, offset, and time of the last change. On every read or write, check the authenticated user’s current access. The server must confirm that the message belongs to the readable transcript and that the offset is between zero and one. If the message no longer exists, use the normal transcript landing position.

Measure the current position even when a viewer is alone. Save it on conversation exit and at infrequent checkpoints after meaningful movement. An abrupt close can lose the final save, so restore the last confirmed checkpoint. Use the newest active view and a sequence within that view to reject late writes from an older tab. Do not write at the live cursor rate. Delete these records when the conversation or account is permanently removed. Presence removal, expiration, and relay failure leave them intact. Show other viewers’ positions only from a current live cursor.

### Client store and access

Use one `CLIENT_SYNC_REGISTRY` key for each record. Feed each key only while its conversation is visible. Read the rendered data from the store. Keep the client copies in memory and local to the window. Clear them on access loss, expiry, or account change. Authorize reads and writes in Convex. Derive user IDs from the authenticated principal and use the conversation access rules. Never use `team_id` as an access check. `apps/web/store/clientSyncRegistry.ts:137`, `apps/web/store/client-sync-registry.scope.ts:7`, `apps/web/store/clientSyncRegistry.ts:2595`.

| Convex table                | Access check                                                                                                                                 | `CLIENT_SYNC_REGISTRY` key | `DATA_SCOPE` | `REPLICATION_CLASSIFICATION` |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------ | ---------------------------- |
| `conversation_read_anchors` | The caller owns `user_id` and passes `checkConversationAccess`.                                                                              | `sessionReadAnchors`       | `viewer`     | `local`                      |
| `conversation_draft_offers` | A reader passes `checkConversationAccess`. A writer also owns the offer’s `user_id`.                                                         | `sessionDraftOffers`       | `entity`     | `local`                      |
| `conversation_draft_claims` | A recipient owns `user_id` and passes `checkConversationAccess`. The actor must pass `canSendProductMessage` and match the offer and action. | `sessionDraftClaims`       | `viewer`     | `local`                      |

Keep the saved anchor outside `session_reads`. The inbox derives unread state from that collection and syncs it across windows. Scroll checkpoints there would rerun inbox reads and broadcasts. `inboxStore.viewAnchor` is the window’s live viewport measurement. Restore by scrolling once to the saved anchor, then let the viewport measure itself. The saved anchor has one writable home in Convex. The client key is a read cache. `apps/web/store/clientSyncRegistry.ts:859`, `apps/web/store/inboxStore.ts:2282`, `apps/web/store/inboxStore.ts:13628`.

In step 2, the compatibility path translates legacy writes to the same draft and claim records. It projects the old response shape on reads. Never store a second draft or claim on `doc_presence` for an opted-in session. Keep the compatibility reader through rollback until active offers and claims expire.

### Deletion and account merge

Give all three tables `by_conversation` and `by_user` indexes. Index `actor_user_id` separately on claims. Register all three in `CONVERSATION_ROW_TABLES`, which serves session delete and regulated deletion. Register them in `accountDelete.ts`, where claims need deletion by either user reference. The regulated deletion guard rejects any uncovered table with a `conversation_id`. `apps/server/convex/lib/conversationRows.ts:9`, `apps/server/convex/sessionDelete.ts:31`, `apps/server/convex/lib/deletionPlans.ts:124`, `apps/server/convex/regulatedDeletion.test.ts`, `apps/server/convex/accountDelete.ts:24`.

Add explicit rules to `admin_mergeUser.ts`. Keep the newest valid anchor for each conversation and destination user. Delete draft offers from the source account. Delete claims that reference the source account as recipient or actor, so no claim survives with a stale identity and `delete_source: true` finds no remaining reference. `apps/server/convex/admin_mergeUser.ts:21`.

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

### Budgets and windows

- One token carries up to 16 grants. One connection carries up to 256 live hubs. Each user gets 120 mint requests per minute across all windows. The relay allows eight connections per authenticated subject by default. It returns `hello.unavailable` when a ninth connection tries to join at that cap. `packages/relay-contract/src/authorization.ts:13`, `apps/server/convex/relayGrants.ts:16`, `apps/server/convex/relayGrants.ts:90`, `apps/relay/src/config.ts:69`, `packages/relay/src/relay.ts:110`, `packages/relay/src/connection.ts:307`.
- Each window subscribes to `viewer:` hubs only for the sessions it shows. Run any inbox-wide subscription only on the elected sync host through `useIsSyncHost()`. On `unavailable` or `rate_limited`, cancel automatic retries for that view and fall back to Convex. Resume on a new eligible view or an explicit recovery signal. `apps/web/hooks/useSyncRole.ts:17`.
- Renew a 15-second shared-tier grant every 10 seconds. Batch shared-tier hubs separately from 60-second hubs because one token carries one expiry. A full 15-second batch costs six steady-state mints per minute per window, plus the initial request and any reconnects. `packages/relay-contract/README.md:31`, `apps/server/convex/relayGrants.ts:81`.

### Display identity and live updates

Relay viewer frames identify a user by `user_id`. The facepile, carets, and reading marks also need a name, color, and avatar. Use the roster first. For other IDs seen on the hub, use a batched Convex query scoped to the conversation. Check that the caller and every requested user pass `checkConversationAccess` for that same conversation. Return only name, color, and avatar for eligible IDs. Omit inaccessible users. Clear cached identities on access loss or account change. `packages/relay-contract/src/frames.ts:81`, `apps/web/components/collab-composer.tsx:123`, `apps/web/components/conversation/ReadingMarks.tsx:45`.

Use the relay’s authenticated subject and connection ID. Track sequence and TTL per connection, hub, and signal type. Drop stale updates and clear one connection on leave or expiry. Count a person as present while any of their connections remains active. Apply a draft cursor only at its matching revision and a reading cursor only to its matching message. The relay keeps no replay buffer and the default signal TTL is 15 seconds. Republish presence and each active reading and draft cursor every 10 seconds. Publish the current values on subscribe and reconnect. The receiver sets `anchor_at` from its clock when it first sees a position or when that position changes. Refreshes at the same position keep that timestamp. `packages/relay-contract/src/frames.ts:34`, `packages/relay-contract/README.md:137`, `packages/relay-contract/README.md:160`, `apps/relay/src/config.ts:60`.

## PR order and rollout gates

Each PR adds its own flag, separate from the existing provider flag. Every new flag defaults to off. Each PR can ship before the next one. Steps 4–6 also require `VITE_RELAY_PRESENCE=1` and a configured relay URL. Server changes ship before clients that call the new functions. Capture a flag-off baseline for each measure before its canary.

### 1. Save reading positions

Add the private read-anchor API and storage. With the flag on, save checkpoints and the final anchor on clean exit. Copy a valid last anchor from a legacy composer row before removal only while the step 1 flag is on. Keep the live reading marks on Convex. The flag restores the old landing behavior.

Test clean exit, lost exit, reconnect, two tabs, stale writes, deleted or inaccessible messages, access revocation, and cross-user reads. Test account merge with anchors on both accounts and retain the newest valid row. Cover session delete, regulated deletion, and account delete. Measure anchor writes per viewer-minute, restore success, and fallback to normal landing. Verify zero writes on an idle viewer heartbeat.

### 2. Move draft authorship and claims

Add the draft and claim records behind a flag. With the flag on, populate draft offers from compatible composer updates. Route opted-in sends through the new validator. Keep the legacy endpoints for old tabs during the transition. Project accepted claims into the old read shape from the authoritative record. Roll back by restoring the legacy path while the compatibility data is available.

Test two users with the same name, spoofed IDs, mismatched text or revisions, revoked access, guest suggestions, queued and direct sends, retries, send failure, and edits after capture. Cover every joint-send route and replay a stale-offer rejection. Verify the single-author fingerprint with a pre-change receipt. Test session delete, regulated deletion, and account delete for both tables. Test account merge with offers on both accounts. Verify that it deletes source offers and claims with the source user in either role, and that `delete_source: true` succeeds. Verify that the compatibility response derives from the same records. Check that a successful send produces one queue row and one claim per accepted part. Measure writes per edit, added mutation reads, send latency, mismatch rate, and cleanup counts. Include zero extra draft writes for an empty solo composer.

### 3. Issue isolated viewer grants

Add the viewer hub mint purpose behind a server flag. Start with owners and full-content teammates. Add a separate off-by-default flag for the shared tier. Keep existing session hub grants and web presence unchanged. Disable issuance to roll back and let existing grants expire.

Extend `apps/server/convex/relay-grants.test.ts` and the relay contract tests. Cover each viewer tier, auth expiry, share rotation, team departure, removed ownership, forged hub IDs, cross-hub subscriptions, and forbidden signal types. Test all grant and connection caps, mixed expiry batches, and mint limits across windows. Measure mint requests and reads per active viewer, denials, refresh errors, and time from revocation to the last accepted frame. Verify the 15-second shared-tier bound and zero frames across the hub boundary.

### 4. Compare relay and Convex views

Add the web adapter behind a flag. Keep the Convex view active. Publish relay signals in the canary and compare the two views with content-free counters. Keep draft text and claim reads in Convex. Scope the client to the signed-in account and window.

Extend `apps/web/components/relay-presence-provider.mount.test.tsx` and the composer tests. Cover two accounts, multiple tabs, hidden windows, lost departures, relay restart, late join, missing grants, and stale cursor revision. Test guest identity, revoked identity, and lookup probes from an unrelated session. Verify that unchanged cursor refreshes preserve `anchor_at` and that overload falls back without a retry loop. Measure join and leave latency, undercounts and duplicate faces, frames and bytes per viewer-minute, and reconnect and fallback rates.

### 5. Use the relay for live viewer signals

Switch a session cohort behind an off-by-default flag after the draft and anchor paths are ready. Keep the Convex publisher during this step. Keep reading `doc_presence` so a Convex-only peer triggers fallback. Use the Convex view for mixed client versions, unknown capabilities, or a relay outage. Use the relay view only for a compatible cohort with healthy subscriptions. Use one source per view and one face per user. An empty relay view can mean nobody is present. Disable the flag to return to Convex.

Test old and new tabs together in either join order, mixed guest and owner access, relay loss during a joint send, revoked access during fallback, and flag rollback. Compare Convex writes and subscription updates per viewer-minute, relay bytes, and p95 join and cursor latency against the baseline. Verify that joint sends and anchor restore work with the relay stopped.

### 6. Stop compatibility presence writes

Gate this step separately. Require healthy subscriptions and a cohort that admits only relay-capable client versions. Confirm zero Convex-only peers over the canary before stopping composer heartbeat and cursor writes. A match by user ID alone cannot prove that every tab supports the relay. Keep the Convex read and fallback paths available. Re-enable Convex publishing if a Convex-only peer appears or the relay fails. Keep comment and document-editor rows on Convex.

Prove zero Convex composer heartbeat and cursor writes in healthy relay sessions. Measure remaining legacy calls, fallback use, draft and anchor writes, relay load, and lost-viewer reports. Test the rollback with an old tab before each cohort expansion.

Use the same scenarios with the flags off and on. Record counts and latency by cohort and access tier. Keep draft text, message IDs, share tokens, and relay tokens out of the measurements.
