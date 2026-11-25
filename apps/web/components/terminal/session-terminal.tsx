"use client";

import { useState } from "react";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { ConversationTerminalSplit as OwnerTerminalSplit } from "./ConversationTerminal";
import { TeamTerminal } from "./team-terminal";

export function ConversationTerminalSplit({
  convKey,
  tmuxSession,
  teamTerminal,
}: {
  convKey: string;
  tmuxSession?: string | null;
  teamTerminal?: boolean;
}) {
  return (
    <>
      {teamTerminal && (
        <TeamTerminalPanel
          key={convKey}
          conversationId={convKey as Id<"conversations">}
        />
      )}
      <OwnerTerminalSplit convKey={convKey} tmuxSession={tmuxSession} />
    </>
  );
}

function TeamTerminalPanel({
  conversationId,
}: {
  conversationId: Id<"conversations">;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        className="px-3 py-1 text-meta text-sol-text-muted hover:text-sol-text"
        onClick={() => setOpen(!open)}
      >
        {open ? "Hide team terminal" : "Team terminal"}
      </button>
      {open && <TeamTerminal conversationId={conversationId} />}
    </>
  );
}
