import { desktopPanelKind } from "../lib/windowRole";
import { REPLICATED_EPHEMERAL_KEYS } from "./clientSyncRegistry";
import type { InboxStoreState } from "./inboxStore";

type StoreKey = Extract<keyof InboxStoreState, string>;

const appearance = [
  "_lastViewedAt",
  "activeTabId",
  "tabs",
  "clientState",
  "currentUser",
  "mods",
  "settingsData",
  "pending",
  "syncMeta",
] as const;
const [placementProjection] = REPLICATED_EPHEMERAL_KEYS;
const inbox = [
  "sessions",
  placementProjection,
  "liveInboxIdList",
  "teamInboxIdSnapshot",
  "conversations",
  "buckets",
  "bucketAssignments",
  "plans",
  "sessionDecisions",
  "sessionReads",
  "pendingMessages",
  "queuedMessages",
  "fencedObservedTurns",
  "blockedReviveRequestedAt",
] as const;
const people = [
  "teams",
  "teamMembers",
  "chatChannels",
  "chatMessages",
  "chatReads",
  "chatRail",
  "chatSlackLinks",
  "chatSlackPeople",
  "chatAuthors",
  "chatReactions",
  "callRooms",
  "callStagePins",
  "guestLinks",
  "guestsWaiting",
  "roomKnocks",
  "collapsedSections",
  "orgTree",
] as const;

export const PALETTE_KEYS = [
  ...appearance,
  ...inbox,
  ...people,
  "agentDefinitions",
  "agentTasks",
  "anchors",
  "bookmarks",
  "commits",
  "docs",
  "drafts",
  "favorites",
  "flowMaps",
  "initiatives",
  "machineRoster",
  "machineResources",
  "pendingMessageStatus",
  "reviewComments",
  "sessionCommands",
  "opsReplayTallies",
  "repoBrowse",
  "managedSessions",
  "mentionIndex",
  "opsAppCalls",
  "opsApps",
  "opsEvents",
  "opsGroups",
  "opsReplays",
  "opsSources",
  "opsWatches",
  "projects",
  "pullRequests",
  "recentProjects",
  "recentProjectsByDevice",
  "recentVisits",
  "savedViews",
  "sessionIndex",
  "tasks",
  "teamMachines",
  "userSkills",
  "wallet",
] as const satisfies readonly StoreKey[];

export const DESKTOP_WINDOW_KEYS = {
  palette: PALETTE_KEYS,
  people: [...appearance, ...inbox, ...people, "bookmarks", "favorites"],
  "call-panel": [
    ...PALETTE_KEYS,
    "docDetails",
    "lineDeploys",
    "liveHeads",
    "pullRequestDetails",
    "teamDeploys",
    "taskComments",
    "decisionStacks",
    "decisionDetails",
    "decisionThreads",
    "orgProposals",
    "orgProposalChanges",
    "workflows",
  ],
  "agent-dock": [
    ...appearance,
    ...inbox,
    "teams",
    "teamMembers",
    "chatMessages",
    "pendingPermissions",
    "messages",
    "pagination",
    "userMessages",
    "fencedPromptAddresses",
    "sessionCommands",
    "docs",
    "tasks",
    "taskComments",
    "drafts",
  ],
} as const satisfies Record<
  NonNullable<ReturnType<typeof desktopPanelKind>>,
  readonly StoreKey[]
>;

export function desktopPanelScopeEnabled(): boolean {
  return (
    process.env.VITE_DESKTOP_PANEL_SCOPE === "1" &&
    typeof window !== "undefined" &&
    !!window.__CODECAST_ELECTRON__
  );
}

export function desktopWindowKeys(): readonly StoreKey[] | undefined {
  const role = desktopPanelKind();
  return desktopPanelScopeEnabled() && role
    ? DESKTOP_WINDOW_KEYS[role]
    : undefined;
}
