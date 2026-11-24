import {
  META_STORE_KEYS,
  WEB_COLLECTION_INDEXES,
  isPersistedClientStoreKey,
} from "../clientSyncRegistry";

export { WEB_COLLECTION_INDEXES };

// The on-disk schema starts with the client sync registry: every persisted
// collection becomes a table keyed by its registered `indexes` (default "_id"),
// beside the system tables below. Registering a collection IS the schema
// change; the only hand step left is bumping CACHE_SCHEMA_VERSION so IndexedDB
// runs the upgrade (a test pins CACHE_SCHEMA_SIGNATURE to the derived schema,
// so a schema change without a bump fails at test time, not at a user's boot).
//
// One version declaration is enough for every installed DB: Dexie diffs the
// declared schema against what is actually on disk (adds tables and indexes,
// drops removed tables) rather than replaying a version ladder — so the old
// twelve-step ladder that restated the whole schema per step is gone.
export const PENDING_INPUT_PREFIX = "pendingInput:v1:";

export const CACHE_SCHEMA_VERSION = 113;
export const CACHE_SCHEMA_SIGNATURE =
  "accountPool:_id|agentChains:_id, name|agentDefinitions:_id, name|agentTaskRuns:_id, task_id|agentTasks:_id|anchorSpaces:_id|anchors:_id|artifacts:_id|bucketAssignments:_id|buckets:_id|callDetails:_id|callList:_id|capabilityBindings:_id|capabilityState:_id|changeEditions:_id, team_id, repository, scope, date|changeLive:_id, team_id, repository, surface|changeStories:_id, team_id, repository, date, area|changeStorySessions:_id, team_id, story_id|changeWorks:_id, team_id, kind|chatAuthors:_id|chatChannels:_id|chatMessages:_id, channel_id, thread_root_id|chatReactions:_id, message_id|chatReads:_id, channel_id|chatSlackLinks:_id, chat_channel_id, team_id|chatSlackPeople:_id, team_id, codecast_user_id|checkouts:_id, workspace|codeComments:_id, pull_request_id, repository, file_path, created_at|comments:_id|commits:_id|composerSuggestions:_id|conversationMessageMeta:convId, latestTimestamp|conversationMessageRows:[convId+messageKey], [convId+position+messageKey+revision]|conversationPages:_id|conversationUserMessages:convId|conversations:_id|dataResults:_id, doc_id|decisionComments:_id, decision_id, created_at|decisionDetails:_id|decisionStacks:_id|decisionThreads:_id|deployDetails:_id|deployReach:_id|deployTargets:_id, workspace|dispatchOutbox:id|docDetails:_id|docs:_id|envStandings:_id|expectationsOverview:_id|externalEvents:_id, team_id, conversation_id, pr_id, task_id, repository, created_at|flowMaps:_id|foreignTriggers:_id|guestSuggestions:_id, conversation_id|handledDecisions:_id|harnessChanges:_id|initiativeUpdates:_id, initiative_id|initiatives:_id, short_id|issueSyncSources:_id, project_id|lineCards:_id, project_id|lineDeploys:_id, project_id|lineDispatch:_id|lineGraphEditability:_id|lineGraphVersions:_id, workflow_id|lineLabels:_id, run_id|lineOccurrences:_id, project_id|lineReviews:_id|lineStages:_id|lineTimeline:_id, at|lineTries:_id, project_id|liveElements:_id, doc_id|liveFlows:_id, team_id|liveHeads:_id|liveVersions:_id, doc_id|machineResources:_id|managedSessions:_id|meetingBotSettings:_id|meetingBots:_id|meetingCalendarEvents:_id|messageFeed:_id, timestamp|meta:key|modObjects:_id|modState:_id|mods:_id|mySends:_id, timestamp|notifications:_id|opsAppCalls:_id, source_id|opsApps:_id|opsCiRuns:_id|opsEvents:_id|opsGroups:_id, source_id|opsReplayTallies:_id|opsReplayTimelines:_id|opsReplays:_id|opsSamples:_id, group_id|opsSources:_id|opsWatchSeries:_id|opsWatches:_id|orgLog:_id|orgLogRows:_id, batch|orgProposalChanges:_id, proposal_id|orgProposals:_id|orgTemplateInstances:_id|pageEmbeds:_id|pageThreads:_id|pendingPermissions:_id, conversation_id|permissionRules:_id|pipelines:_id, workspace|plans:_id|prGuides:_id|projectExpectations:_id|projectOutputs:_id|projectTeammateSources:_id|projectUpdates:_id, project_id|projects:_id|pullRequestDetails:_id|pullRequestSessions:_id, conversation_id|pullRequests:_id|quoteDrafts:_id, conversation_id, client_id|repoBrowse:_id, scope, repository|repoBrowseAccess:_id, scope, repository|repoFlows:_id, root, repository|runGraphs:_id|savedViews:_id|secretHistory:_id|secrets:_id, name|sessionCommands:_id|sessionDecisions:_id|sessionFlows:_id, graph_hash|sessionGoals:_id|sessionIndex:_id|sessionReads:_id, conversation_id|sessions:_id|settingsData:_id|shipTargets:_id|sideAnswers:_id, conversation_id|signals:_id|stationInputs:_id|taskComments:_id|taskEvidence:_id|tasks:_id|teamDeploys:_id, workspace|teamKitItems:_id|teamPrompts:_id, team_id, date|threadInbox:_id, kind, team_id, channel_id, conversation_id, task_id|trialCards:_id, project_id|trialProjects:_id|trialRuns:_id, project_id|trialSpend:_id|viewerRoles:_id|weeklyCards:_id|workflowRuns:_id, workflow_id|workflows:_id";

export const SYSTEM_TABLES = {
  meta: "key",
  // Indexed by latestTimestamp so the on-disk store can be pruned (LRU + TTL)
  // instead of growing forever — one row per conversation ever opened.
  conversationMessageMeta: "convId, latestTimestamp",
  conversationMessageRows:
    "[convId+messageKey], [convId+position+messageKey+revision]",
  // The complete navigable user-message list (getUserMessages), one small row
  // per conversation. Its own table, separate from the transcript cache: the
  // two lists arrive from different subscriptions at different times, and a
  // shared row would need a read-modify-write per flush to avoid one list
  // clobbering the other. Pruned in lockstep with the transcript.
  conversationUserMessages: "convId",
  // No index, on purpose. Every dispatch puts a row here and deletes it on ack,
  // and Chromium never removes the index entry of a deleted row while a
  // connection stays open: a read through the index steps over every dead
  // entry since boot to learn the table is empty. With a `ts` index, loading
  // this empty table took 476ms in a day-old tab (3ms by primary key) and
  // pinned the desktop app's browser process. loadOutbox sorts the few live rows.
  dispatchOutbox: "id",
} as const;

/** Stable serialization of the on-disk schema (sorted). */
export function cacheSchemaSignature(): string {
  return Object.entries({ ...WEB_COLLECTION_INDEXES, ...SYSTEM_TABLES })
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([table, indexes]) => `${table}:${indexes}`)
    .join("|");
}

export const META_KEYS = new Set<string>(
  META_STORE_KEYS.filter((key) => !(key in WEB_COLLECTION_INDEXES)),
);

// A top-level store key is durable iff it maps to a dedicated collection table
// or is whitelisted as a meta blob. Keys that satisfy neither are silently
// dropped on write — the class of bug that lost pending user messages.
export function isPersistedStoreKey(key: string): boolean {
  return isPersistedClientStoreKey(key);
}
