import type { ClientSyncRegistryEntry } from "./clientSyncRegistry";

export const FENCED_PROMPT_SYNC_COLLECTIONS = {
  fencedPromptAddresses: {
    localFirst: true,
    unprotectedFields: ["answerSummary"],
    sync: {
      isDelta: true,
      deepFields: ["questions", "answerer"],
      preserveFields: ["accepted", "feedAbsent", "answerSummary"],
    },
    feeds: [
      "permissions.listAnswerablePromptAddresses",
      "permissions.getFencedPromptFeed",
    ],
  },
  fencedObservedTurns: {
    sync: { isDelta: true, deepFields: ["observed_turn"] },
  },
} as const satisfies Record<string, ClientSyncRegistryEntry>;

export const replication = {
  fencedPromptAddresses: "local",
  fencedObservedTurns: "local",
} as const;
