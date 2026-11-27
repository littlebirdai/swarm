# Conversation reads in live queries

Convex tracks the full documents a query reads. A streamed message advances
`conversations.updated_at` and `message_count`. Reading a conversation just
to check its owner therefore subscribes the query to transcript activity too.

This inventory groups the web, mobile, and CLI subscribers by the facts
they read. It includes reads through shared access, inbox, and reference
resolvers. One-shot HTTP reads, actions, and mutation lookups are outside
the inventory.

| Subscribed queries                                                                                                                                                                                                                                                                                                                     | Conversation facts used                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `executionBindings.listExecutionWork`                                                                                                                                                                                                                                                                                                  | Safety block recorded by `pending_api_error_kind` or the classified `session_error`.                                                                                                 |
| `org.tree`, `org.sessionsUnder`, `org.scopeFeed`, `org.scopeSummary`, `org.roleCard`, `org.brief`                                                                                                                                                                                                                                      | Role associations, activity, status, card identity and team visibility.                                                                                                              |
| `decisionTeamList.listForTeam`, `sessionDecisions.get`, `getWithDoc`, `getWithDocMany`, `listForRole`, `findByAnswer`, `decisionThread.thread`                                                                                                                                                                                         | Session and prompt authorization, titles, project paths, and thread access.                                                                                                          |
| `messages.getConversationFileChangeIndex`, `getConversationImages`, `conversationPages.list`, `sessionGuests.guestState`                                                                                                                                                                                                               | Transcript access and share state for linked files, images, pages, and guest access.                                                                                                 |
| `agentTasks.webListRuns`, `tasks.webActiveSessions`                                                                                                                                                                                                                                                                                    | Runner, display state, and the conversation's link to the task.                                                                                                                      |
| `pendingMessages.getConversationPendingMessage`                                                                                                                                                                                                                                                                                        | Runner for the viewer's delivery indicator, owner assignments, team visibility, and share redemption for the shared queue. Queue text and sender names come from other tables.       |
| `pendingMessages.getPendingMessagesForDaemon`, `pendingMessages.getMessageStatus`, `collab.collabRequests`                                                                                                                                                                                                                             | Delivery eligibility and agent type, or runner and message ownership. They use session starts and still read the conversation when a projection is missing.                          |
| `notifications.list`, `sessionDecisions.listForUser`, `sessionDecisions.listOpenForLines`                                                                                                                                                                                                                                              | Session title and project path, plus agent type and identity for notifications. These reads fall back to the full conversation when the card is missing.                             |
| `conversations.resolveConversation`, `webGet`, `getSharedConversationMeta`, `getConversation`, `getConversationWithMeta`, `getConversationTree`                                                                                                                                                                                        | IDs and reference resolution, access, title and visibility, lifecycle and placement, or parent and child links. Some return the full metadata needed by a session view.              |
| `conversations.listConversations`, `listPublicConversations`, `listFavoriteSessions`, `listInboxSessions`, `listTeamInboxSessions`, `sessionsLiveness`, `teamSessionsLiveness`, `inboxForCLI`, `feedForCLI`                                                                                                                            | Candidate windows, ownership and visibility, filing, status, display fields, activity order, and parent or child state. The liveness queries also use counts and last-message facts. |
| `conversations.getMessageFeed`, `searchConversations`, `conversationMessagesForCLI`, `getConversationGitDiff`                                                                                                                                                                                                                          | Scope and access, search ranking and card text, transcript reference, or the requested diff.                                                                                         |
| `conversations.listMessagesTail`, `getTranscriptWatermark`, `messages.getMessageTimestamp`, `findMessageByContent`, `webGet`, `getSharedMessage`, `images.getImageUrls`                                                                                                                                                                | Transcript authorization, share recognition, or send access. Message bodies, timestamps, coverage, and images come from their own rows.                                              |
| `permissions.getPendingPermissions`, `quoteDrafts.listForConversation`, `collab.mySendAccess`, `sessionOwnership.listOwners`                                                                                                                                                                                                           | Session access, assignment and send policy, session project, or prompt ownership.                                                                                                    |
| `devices.getConversationMachine`, `ownerDeviceDisplay`, `edgeRunLease.forcedMoveOptions`                                                                                                                                                                                                                                               | Session identity, access, runner, assigned device, placement, and move eligibility.                                                                                                  |
| `terminalWatch.status`, `watchers`, `blockedViewers`, `screen`, `terminalStream.getPane`                                                                                                                                                                                                                                               | Session and runner binding, team access and view grants. Frames, leases, and input have separate rows.                                                                               |
| `pull_requests.getPRsForConversation`, `commits.getCommitsForConversation`, `externalEvents.listForConversation`, `transcripts.webCallsForConversation`, `projectSources.teammateSources`, `sessionGoals.forConversation`, `tasks.webListByConversation`, `follow.viewOf`, `lineWorkspace.stationInput`, `conversationReadAnchors.get` | Session access and identity. Some resolve repo, project, parent, or route before reading the linked rows.                                                                            |
| `plans.webGet`, `docs.webGet`, `docs.mentionSearch`, `taskMining.webGetTaskDetail`, `bookmarks.listBookmarks`, `anchors.listAnchors`, `anchors.getAnchorSpace`, `ship.forTarget`, `sessionThreads.listSessionThreads`, `sessionQuerySuggest.recentFiles`                                                                               | Linked session access, title or summary, path, liveness, or thread endpoints.                                                                                                        |
| `users.getPublicProfile`, `getPublicPinnedSessions`, `getUserAbstractActivity`, `getUserProfileFeed`, `getDirectoryTeamMappings`, `listConversationsForPath`, `getSuggestedTeamProjects`, `userSends.teamDay`                                                                                                                          | Public or team visibility, session title and summary, filing, activity dates, and project paths.                                                                                     |

## Rollout

Run `internal.pageData.backfillSessionStarts` before setting
`EXECUTION_WORK_SESSION_CARD=1` so existing sessions get a projected safety
verdict. With the flag on, the execution-work feed still reads the full
conversation when the card or its safety verdict is missing. The flag defaults
off.

Once the web pending-queue projection ships, run
`internal.pageData.backfillSessionStarts` before setting
`CODECAST_NARROW_PENDING_QUEUE_READS=1` so already-open sessions benefit. Older
rows without `queue_access` continue to use the full conversation. The flag
defaults off.

The regression tests check that ordinary streamed message writes leave the
narrow queries' document read sets untouched. An access change, a delivered
echo, or a safety change can still invalidate a query when it changes the
answer. Transcript viewers and queries that display activity still depend
on transcript changes.

## CLI watch reads

The unfiltered personal subscription used by `cast sessions -w` ranks the
existing inbox windows before applying its display limit. It loads status
and decisions for eligible rows and for children that can change a visible
parent's status. Dismissed and stashed rows skip those reads unless requested
with `--all`. Foreign-run sessions use one liveness lookup per visible row.

The watch returns each displayed row's label. Its `labels` summary is empty
because the stream does not show counts for archived conversations. For
daemon-wide liveness it reads `users.daemon_last_seen` and considers the
managed rows it covers. An unrelated legacy heartbeat can keep a row live
in the ordinary inbox until the user-wide daemon heartbeat catches up
with it. The watch reads bounded recent heartbeat ranges, at most 256
cold session lookups, and bounded pending decision ranges. On accounts
that exceed those bounds, older facts can affect the ordinary inbox
without appearing in the watch.
