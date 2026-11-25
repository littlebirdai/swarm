import { Check, Clock, X } from "lucide-react";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useInboxStore } from "../../store/inboxStore";

// A teammate's own suggestions in this session and what became of each
// (convex teamSuggestions.listMine). Waiting ones can be taken back, or sent
// the ordinary way once the owner has left; decided ones stay a while so the
// author sees the outcome.
const DECIDED_SHOWN_MS = 10 * 60_000;
export function MySuggestions({
  rows,
  ownerName,
  ownerHere,
  onSendNow,
}: {
  rows: any[];
  ownerName: string;
  ownerHere: boolean;
  onSendNow: (row: { _id: string; body: string }) => void;
}) {
  const now = useCoarseNow(30_000);
  const withdraw = useInboxStore((s) => s.withdrawTeamSuggestion);
  // Every waiting one (so each can be taken back), and the last few decided.
  const decided = rows
    .filter(
      (r) =>
        !r.kind &&
        r.status !== "pending" &&
        now - (r.decided_at ?? r.created_at ?? 0) < DECIDED_SHOWN_MS,
    )
    .slice(-3);
  const shown = [
    ...decided,
    ...rows.filter((r) => !r.kind && r.status === "pending"),
  ];
  if (shown.length === 0) return null;
  const first = ownerName.split(/\s+/)[0] || ownerName;
  return (
    <div
      className="mx-auto conv-col px-2 sm:px-4 pt-1.5 space-y-1"
      data-my-suggestions
    >
      {shown.map((r) => {
        const state =
          r.status === "pending"
            ? {
                icon: <Clock className="w-3 h-3" />,
                tone: "text-sol-violet",
                label: `Waiting for ${first}`,
              }
            : r.status === "sent"
              ? {
                  icon: <Check className="w-3 h-3" />,
                  tone: "text-sol-green",
                  label: r.edited
                    ? `${first} sent an edit`
                    : `${first} sent it`,
                }
              : r.status === "closed"
                ? {
                    icon: <X className="w-3 h-3" />,
                    tone: "text-sol-text-dim",
                    label: "Not sent",
                  }
                : {
                    icon: <X className="w-3 h-3" />,
                    tone: "text-sol-text-dim",
                    label: `${first} passed`,
                  };
        return (
          <div
            key={r._id}
            data-suggestion-status={r.status}
            className="flex items-center gap-2 px-3 py-1.5 rounded-xl border border-sol-border/40 bg-sol-bg-alt/50 text-meta"
          >
            <span
              className={`shrink-0 inline-flex items-center gap-1 font-medium ${state.tone}`}
            >
              {state.icon}
              {state.label}
            </span>
            <span
              className="flex-1 min-w-0 truncate text-sol-text-muted"
              title={r.body}
            >
              {r.body}
            </span>
            {r.status === "pending" && !ownerHere && (
              <button
                onClick={() => onSendNow(r)}
                className="shrink-0 h-6 px-2.5 rounded-full font-medium border border-sol-cyan/40 text-sol-cyan hover:bg-sol-cyan/15 transition-colors"
              >
                Send now
              </button>
            )}
            {r.status === "pending" && (
              <button
                onClick={() => withdraw(r._id, r.conversation_id)}
                className="shrink-0 h-6 px-2.5 rounded-full font-medium border border-sol-border text-sol-text-dim hover:text-sol-text transition-colors"
              >
                Withdraw
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
