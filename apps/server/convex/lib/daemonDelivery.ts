import { isHostedAgentType } from "@codecast/agent-clients/agentClients";
import {
  isConversationSafetyBlocked,
  type ConversationSafetyState,
} from "../conversationSafety";

type DaemonDeliveryState = {
  owner_device_id?: string;
  blocked: boolean;
};

export function legacyConversationAcceptsDaemonWork(
  conversation: { execution_protocol_state?: string } | null | undefined,
): boolean {
  return conversation?.execution_protocol_state === undefined;
}

export function daemonDeliveryStateOf(
  conversation: ConversationSafetyState & {
    owner_device_id?: string;
    execution_protocol_state?: string;
    cloud_placement?: string;
    migration?: unknown;
    agent_type?: string | null;
  },
): DaemonDeliveryState {
  // Placement and migration leave work queued until a device can serve it.
  // Hosted sessions and fenced sessions have their own delivery paths.
  return {
    owner_device_id: conversation.owner_device_id,
    blocked:
      isConversationSafetyBlocked(conversation) ||
      !legacyConversationAcceptsDaemonWork(conversation) ||
      conversation.cloud_placement === "pending" ||
      !!conversation.migration ||
      isHostedAgentType(conversation.agent_type),
  };
}
