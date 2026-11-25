"use client";

import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { ConversationTerminalSplit as OwnerTerminalSplit } from "./ConversationTerminal";
import { TeamTerminal } from "./team-terminal";

export function ConversationTerminalSplit({
  convKey,
  tmuxSession,
}: {
  convKey: string;
  tmuxSession?: string | null;
}) {
  return (
    <>
      <TeamTerminal
        key={convKey}
        conversationId={convKey as Id<"conversations">}
      />
      <OwnerTerminalSplit convKey={convKey} tmuxSession={tmuxSession} />
    </>
  );
}
