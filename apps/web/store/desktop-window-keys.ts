import { REPLICATED_EPHEMERAL_KEYS } from "./clientSyncRegistry";
import type { InboxStoreState } from "./inboxStore";

type StoreKey = Extract<keyof InboxStoreState, string>;

const appearance = [
  "activeTabId",
  "tabs",
  "clientState",
  "currentUser",
  "pendingMessages",
  "mods",
  "settingsData",
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
  "pending",
  "queuedMessages",
  "blockedReviveRequestedAt",
  "syncMeta",
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

const PALETTE_KEYS = [
  ...appearance,
  ...inbox,
  ...people,
  "agentDefinitions",
  "agentTasks",
  "bookmarks",
  "docs",
  "drafts",
  "favorites",
  "flowMaps",
  "initiatives",
  "machineRoster",
  "managedSessions",
  "mentionIndex",
  "opsAppCalls",
  "opsApps",
  "opsEvents",
  "opsGroups",
  "opsReplays",
  "opsReplayTallies",
  "opsSources",
  "opsWatches",
  "projects",
  "recentProjects",
  "recentProjectsByDevice",
  "recentVisits",
  "repoBrowse",
  "savedViews",
  "sessionIndex",
  "tasks",
  "teamMachines",
  "userSkills",
  "wallet",
] as const satisfies readonly StoreKey[];

export const DESKTOP_WINDOW_KEYS = {
  palette: [
    ...PALETTE_KEYS,
    "machineResources",
    "pendingMessageStatus",
    "reviewComments",
    "sessionCommands",
  ],
  people: [...appearance, ...inbox, ...people, "bookmarks", "favorites"],
  "call-panel": [
    ...PALETTE_KEYS,
    "_lastViewedAt",
    "anchors",
    "commits",
    "decisionStacks",
    "docDetails",
    "lineDeploys",
    "orgProposals",
    "orgProposalChanges",
    "pendingMessageStatus",
    "pullRequests",
    "pullRequestDetails",
    "reviewComments",
    "sessionCommands",
    "teamDeploys",
    "workflows",
  ],
  "agent-dock": [
    ...appearance,
    ...inbox,
    "teams",
    "teamMembers",
    "chatMessages",
    "pendingPermissions",
    "drafts",
  ],
  "call-ring": [
    ...appearance,
    "teams",
    "teamMembers",
    "chatChannels",
    "chatRail",
    "guestsWaiting",
    "roomKnocks",
    "pending",
    "syncMeta",
  ],
  "meeting-offer": appearance,
  "share-cursors": appearance,
} as const satisfies Record<string, readonly StoreKey[]>;

export function desktopWindowKeys(): readonly StoreKey[] | undefined {
  if (typeof window === "undefined" || !window.__CODECAST_ELECTRON__) return;
  const kind = window.location.pathname.replace(/^\/|\/$/g, "");
  if (Object.hasOwn(DESKTOP_WINDOW_KEYS, kind))
    return DESKTOP_WINDOW_KEYS[kind as keyof typeof DESKTOP_WINDOW_KEYS];
}
