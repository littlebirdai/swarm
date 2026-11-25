import { defineSchema } from "convex/server";
import { authTables } from "@convex-dev/auth/server";
import { capabilityTables, teamKitTables } from "./capabilitiesSchema";
import { googleOAuthTables } from "./googleOAuthSchema";
import { mcpTables } from "./mcpSchema";
import { assistantTables } from "./assistantSchema";
import { castMachineTables } from "./castMachinesSchema";
import { dataSyncTables } from "./dataSyncSchema";
import { oauthConnectorTables } from "./oauthConnectorsSchema";
import { issueSyncTables } from "./issueSyncSchema";
import { agentTables } from "./agentSchema";
import { expectationTables } from "./expectationsSchema";
import { machineResourceTables } from "./machineResourcesSchema";
import { teamHostTables } from "./teamHostsSchema";
import { accountPoolTables } from "./accountPoolSchema";
import { managedDeviceTables } from "./managedDevicesSchema";
import { ingestTables } from "./ingestSchema";
import { envTables } from "./envSchema";
import { momentsTables } from "./momentsSchema";
import { liveArtifactTables } from "./liveArtifactsSchema";
import { pageStateTables } from "./pageStateSchema";
import { dataQueryTables } from "./dataQueriesSchema";
import { deployTables } from "./deploySchema";
import { lineTrialTables } from "./lineTrialSchema";
import { orgRoleTokenTables } from "./orgRoleTokensSchema";
import { liveFlowTables } from "./liveFlowsSchema";
import { flowMapTables } from "./flowMapSchema";
import { sessionFlowTables } from "./sessionFlowsSchema";
import { landedChangeTables } from "./landedChangesSchema";
import { slackTables } from "./slackSchema";
import { passkeyTables } from "./passkeysSchema";
import { accessLogTables } from "./accessLogSchema";
import { teamReadKeyTables } from "./teamReadKeysSchema";
import { dataDeletionTables } from "./dataDeletionsSchema";
import {
  accountTables,
  accountAuthTables,
  ipRateLimitTables,
} from "./schema/accounts.tables";
import {
  daemonCommandTables,
  deviceTables,
  systemConfigTables,
  daemonLogTables,
} from "./schema/machines.tables";
import {
  teamTables,
  teamMembershipTables,
  teamRoutingTables,
} from "./schema/teams.tables";
import {
  subscriptionTables,
  usageCalibrationTables,
} from "./schema/billing.tables";
import {
  sessionPathStatTables,
  sessionOwnershipTables,
  inboxTables,
} from "./schema/session-inbox.tables";
import { conversationTables } from "./schema/conversations.tables";
import { sessionMigrationTables } from "./schema/session-migration.tables";
import { anchorTables } from "./schema/anchors.tables";
import { orgRoleTables } from "./schema/org-roles.tables";
import { orgChangeTables } from "./schema/org-changes.tables";
import { orgTemplateTables } from "./schema/org-templates.tables";
import {
  transcriptTables,
  messageCommentTables,
  messagePayloadTables,
  conversationImageTables,
  linkPreviewTables,
} from "./schema/messages.tables";
import {
  sessionPatternTables,
  sessionInsightTables,
  projectMemoryTables,
} from "./schema/session-insights.tables";
import {
  fileTouchTables,
  repositoryHistoryTables,
  fileChangeBodyTables,
  repositorySourceTables,
} from "./schema/repositories.tables";
import {
  syncCursorTables,
  clientStateTables,
  counterAndSyncLogTables,
} from "./schema/sync.tables";
import {
  sessionDeliveryTables,
  conversationEventTables,
} from "./schema/session-delivery.tables";
import {
  managedSessionTables,
  sessionStartTables,
} from "./schema/managed-sessions.tables";
import {
  pullRequestTables,
  githubEventTables,
} from "./schema/pull-requests.tables";
import { externalEventTables } from "./schema/events.tables";
import {
  deploymentTables,
  checkoutFlowTables,
} from "./schema/deployments.tables";
import { activityTables, timelineTables } from "./schema/activity.tables";
import { changeStoryTables } from "./schema/changes.tables";
import {
  notificationTables,
  entitySubscriptionTables,
} from "./schema/notifications.tables";
import {
  pendingPermissionTables,
  sessionDecisionTables,
} from "./schema/session-decisions.tables";
import {
  sessionSharingTables,
  messageShareTables,
  sessionFrameTables,
  viewFollowTables,
} from "./schema/session-sharing.tables";
import { scheduleTables } from "./schema/schedules.tables";
import { projectTables } from "./schema/projects.tables";
import { modTables } from "./schema/mods.tables";
import { planTables, planTemplateTables } from "./schema/plans.tables";
import {
  taskTables,
  taskCommentTables,
  taskHistoryTables,
} from "./schema/tasks.tables";
import { signalTables } from "./schema/signals.tables";
import {
  documentTables,
  vaultMirrorTables,
  documentEditingTables,
} from "./schema/documents.tables";
import { artifactTables, artifactViewTables } from "./schema/artifacts.tables";
import { callAndTranscriptTables } from "./schema/calls.tables";
import { workflowTables } from "./schema/workflows.tables";
import { chatTables, chatTypingTables } from "./schema/chat.tables";

export default defineSchema(
  {
    // Capability library tables (fleet mirror + catalog cache). Defined in their
    // own module so the capability functions and their tests share one source;
    // spread here because a deploy only ships what this file names.
    ...capabilityTables,
    ...teamKitTables,
    ...machineResourceTables,
    ...teamHostTables,
    ...accountPoolTables,
    ...managedDeviceTables,
    ...googleOAuthTables,
    ...mcpTables,
    ...oauthConnectorTables,
    // External data: sources, groups, samples, replays, metric watches, app calls (external-data.md).
    ...ingestTables,
    ...envTables,
    ...momentsTables,
    ...liveArtifactTables,
    ...pageStateTables,
    ...dataQueryTables,
    ...deployTables,
    ...lineTrialTables,
    ...orgRoleTokenTables,
    ...liveFlowTables,
    ...flowMapTables,
    ...sessionFlowTables,
    ...landedChangeTables,
    ...slackTables,
    ...passkeyTables,
    ...accessLogTables,
    ...teamReadKeyTables,
    ...dataDeletionTables,
    ...authTables,
    ...accountTables,
    ...daemonCommandTables,
    ...teamTables,
    ...subscriptionTables,
    ...teamMembershipTables,
    ...sessionPathStatTables,
    ...teamRoutingTables,
    ...sessionOwnershipTables,
    ...conversationTables,
    ...sessionMigrationTables,
    ...anchorTables,
    ...orgRoleTables,
    ...orgChangeTables,
    ...orgTemplateTables,
    ...transcriptTables,
    ...inboxTables,
    ...sessionPatternTables,
    ...fileTouchTables,
    ...messageCommentTables,
    ...syncCursorTables,
    ...accountAuthTables,
    ...sessionDeliveryTables,
    ...deviceTables,
    ...managedSessionTables,
    ...repositoryHistoryTables,
    ...messagePayloadTables,
    ...fileChangeBodyTables,
    ...conversationImageTables,
    ...pullRequestTables,
    ...externalEventTables,
    ...deploymentTables,
    ...repositorySourceTables,
    ...activityTables,
    ...sessionInsightTables,
    ...timelineTables,
    ...changeStoryTables,
    ...notificationTables,
    ...ipRateLimitTables,
    ...pendingPermissionTables,
    ...projectMemoryTables,
    ...sessionDecisionTables,
    ...sessionSharingTables,
    ...githubEventTables,
    ...messageShareTables,
    ...systemConfigTables,
    ...scheduleTables,
    ...projectTables,
    ...modTables,
    ...planTables,
    ...taskTables,
    ...signalTables,
    ...taskCommentTables,
    ...conversationEventTables,
    ...taskHistoryTables,
    ...documentTables,
    ...artifactTables,
    ...sessionStartTables,
    ...artifactViewTables,
    ...sessionFrameTables,
    ...vaultMirrorTables,
    ...documentEditingTables,
    ...callAndTranscriptTables,
    ...checkoutFlowTables,
    ...workflowTables,
    ...clientStateTables,
    ...daemonLogTables,
    ...planTemplateTables,
    ...entitySubscriptionTables,
    ...counterAndSyncLogTables,
    ...chatTables,
    ...viewFollowTables,
    ...chatTypingTables,
    ...usageCalibrationTables,
    ...linkPreviewTables,

    ...issueSyncTables,
    ...agentTables,
    ...expectationTables,
    ...assistantTables,
    ...castMachineTables,
    ...dataSyncTables,
  },
  {
    // The `messages` table is in the millions of rows, and the default
    // `schemaValidation: true` re-scans every document on every `convex deploy` —
    // turning a one-field function change into a multi-minute full-table walk.
    // Disable the runtime/push-time scan: writes still flow through mutations with
    // `v.*` arg validators and the schema continues to generate the TypeScript
    // types, so the validators above remain the source of truth for shape — they
    // just aren't re-checked against the whole DB on each push.
    schemaValidation: false,
  },
);
