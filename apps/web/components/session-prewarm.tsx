import { useConversationMessages } from "../hooks/use-conversation-messages";

export function SessionPrewarm({ sessionId }: { sessionId: string }) {
  useConversationMessages(sessionId);
  return null;
}
