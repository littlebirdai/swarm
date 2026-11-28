import { DISPATCHABLE_CONVERSATION_FIELDS } from "@codecast/sessions/conversationFields";

const CONVERSATION_WRITER_MODULES = [
  "cliSessionActions",
  "conversationFavorites",
  "conversationFeeds",
  "conversationForks",
  "conversationLifecycle",
  "conversationMetadata",
  "conversationNav",
  "conversationPrivacy",
  "conversationProjects",
  "conversationSharing",
  "conversationStatus",
  "inboxShelves",
  "sessionControl",
  "sessionHierarchy",
  "sessionRestart",
  "sessionThreadState",
] as const;

export const CONVERSATION_SYNC_COLLECTIONS = {
  sessions: {
    writtenBy: [...CONVERSATION_WRITER_MODULES],
    persistence: {
      kind: "collection" as const,
      key: "sessions",
      liveFields: [
        "updated_at",
        "message_count",
        "last_role_is_user",
        "context_tokens",
        "last_model_call_at",
        "activity",
        "daemon_alive_until",
        "producing_until",
        "last_heartbeat",
        "liveness_lease_end",
        "last_turn_origin",
      ],
    },
    localFirst: true as const,
    dispatchTable: {
      table: "conversations",
      kind: "collection" as const,
      fields: [...DISPATCHABLE_CONVERSATION_FIELDS],
    },
  },
  conversations: {
    writtenBy: [...CONVERSATION_WRITER_MODULES, "peerTransfers"],
    persistence: {
      kind: "meta" as const,
      key: "conversations",
      webTable: true,
    },
    localFirst: true as const,
    dispatchTable: { table: "conversations", kind: "collection" as const },
    unprotectedFields: ["peer_transfer"],
  },
};
