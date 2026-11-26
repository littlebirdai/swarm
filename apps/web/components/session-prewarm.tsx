import { useConversationMessages } from "../hooks/use-conversation-messages";

export function SessionPrewarm({ sessionId }: { sessionId: string }) {
  useConversationMessages(
    sessionId,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    true,
  );
  return null;
}
