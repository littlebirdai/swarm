import Link from "next/link";
import {
  ArrowDownRight,
  ArrowUp,
  ChevronRight,
  FileCode2,
  GitCommitHorizontal,
  MessageCircleQuestion,
} from "lucide-react";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import {
  hasLateJoinUpdates,
  type LateJoinSummary,
} from "../../hooks/use-late-join-summary";
import { decisionHref } from "../../lib/decisionLinks";
import { formatRelative } from "../../lib/utils";
import { Button } from "../ui/button";

function decisionTone(state: string): string {
  if (state === "pending") {
    return "border-sol-amber/40 bg-sol-amber/10 text-sol-amber";
  }
  if (state === "answered") {
    return "border-sol-green/40 bg-sol-green/10 text-sol-green";
  }
  return "border-sol-border bg-sol-bg text-sol-text-dim";
}

function fileBasename(path: string): string {
  const parts = path.split("/");
  return parts.length > 2 ? parts.slice(-2).join("/") : path;
}

function formatCountLabel(
  count: number,
  truncated: boolean,
  singular: string,
  plural: string,
): string {
  const suffix = count === 1 && !truncated ? singular : plural;
  return `${count}${truncated ? "+" : ""} ${suffix}`;
}

export function LateJoinSummaryPanel({
  summary,
  onJump,
  onJumpPrompt,
}: {
  summary: LateJoinSummary;
  onJump: (messageId: string, timestamp: number) => void;
  onJumpPrompt: (prompt: NonNullable<LateJoinSummary["open_prompt"]>) => void;
}) {
  const now = useCoarseNow(60_000);
  if (!hasLateJoinUpdates(summary)) return null;

  const extraFiles = summary.changed_files_total - summary.changed_files.length;
  const extraDecisions = summary.decisions_total - summary.decisions.length;
  const turnLabel = formatCountLabel(
    summary.new_turns,
    summary.turns_truncated,
    "turn",
    "turns",
  );
  const filesLabel = formatCountLabel(
    summary.changed_files_total,
    summary.changed_files_truncated,
    "file",
    "files",
  );
  const decisionsLabel = formatCountLabel(
    summary.decisions_total,
    summary.decisions_truncated,
    "decision",
    "decisions",
  );

  return (
    <section
      data-cc-late-join-summary
      aria-label="Late-join summary"
      className="shrink-0 border-b border-sol-border/60 bg-sol-bg-alt/80 px-3 py-2"
    >
      <div className="conv-col mx-auto flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2 text-meta">
            <span className="font-medium text-sol-text">
              Since {formatRelative(summary.anchor.timestamp, now)}
            </span>
            {summary.new_turns > 0 && (
              <span
                data-cc-late-join-turns
                className="inline-flex items-center rounded border border-sol-border/70 bg-sol-bg px-1.5 py-0.5 text-mark tabular-nums text-sol-text-muted"
              >
                {turnLabel}
              </span>
            )}
            {summary.changed_files_total > 0 && (
              <span
                data-cc-late-join-files-count
                className="inline-flex items-center gap-1 rounded border border-sol-border/70 bg-sol-bg px-1.5 py-0.5 text-mark tabular-nums text-sol-text-muted"
              >
                <FileCode2 className="h-3 w-3" />
                {filesLabel}
              </span>
            )}
            {summary.decisions_total > 0 && (
              <span
                data-cc-late-join-decisions-count
                className="inline-flex items-center gap-1 rounded border border-sol-border/70 bg-sol-bg px-1.5 py-0.5 text-mark tabular-nums text-sol-text-muted"
              >
                <GitCommitHorizontal className="h-3 w-3" />
                {decisionsLabel}
              </span>
            )}
            {summary.open_prompt && (
              <button
                type="button"
                data-cc-late-join-prompt-badge
                onClick={() => onJumpPrompt(summary.open_prompt!)}
                className="inline-flex items-center gap-1 rounded border border-sol-orange/40 bg-sol-orange/10 px-1.5 py-0.5 text-mark text-sol-orange hover:bg-sol-orange/20 transition-colors"
              >
                <MessageCircleQuestion className="h-3 w-3" />
                {summary.open_prompt.kind}
              </button>
            )}
          </div>
          <Button
            type="button"
            size="xs"
            variant="default"
            data-cc-late-join-jump
            onClick={() =>
              onJump(summary.anchor.message_id, summary.anchor.timestamp)
            }
          >
            <ArrowUp className="h-3.5 w-3.5" />
            Jump to read point
          </Button>
        </div>

        {summary.changed_files.length > 0 && (
          <div className="flex items-start gap-2 text-meta">
            <span className="w-16 shrink-0 pt-0.5 text-sol-text-dim">
              Files
            </span>
            <div className="flex min-w-0 flex-wrap items-center gap-1">
              {summary.changed_files.slice(0, 6).map((file) => (
                <span
                  key={file.path}
                  title={file.path}
                  className="inline-flex max-w-[220px] items-center gap-1 rounded border border-sol-border/60 bg-sol-bg px-1.5 py-0.5 font-mono text-meta text-sol-text"
                >
                  <span className="truncate">{fileBasename(file.path)}</span>
                  <span className="text-mark tabular-nums text-sol-text-dim">
                    {file.count}
                  </span>
                </span>
              ))}
              {summary.changed_files.length > 6 && (
                <span className="text-meta tabular-nums text-sol-text-dim">
                  +{summary.changed_files.length - 6 + Math.max(0, extraFiles)}
                  {summary.changed_files_truncated ? "+" : ""}
                </span>
              )}
              {summary.changed_files.length <= 6 && extraFiles > 0 && (
                <span className="text-meta tabular-nums text-sol-text-dim">
                  +{extraFiles}
                  {summary.changed_files_truncated ? "+" : ""}
                </span>
              )}
            </div>
          </div>
        )}

        {summary.decisions.length > 0 && (
          <div className="flex items-start gap-2 text-meta">
            <span className="w-16 shrink-0 pt-0.5 text-sol-text-dim">
              Decisions
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              {summary.decisions.slice(0, 4).map((decision) => (
                <Link
                  key={decision._id}
                  href={decisionHref(decision)}
                  data-cc-late-join-decision={decision._id}
                  className="group flex min-w-0 items-center gap-1.5 rounded hover:bg-sol-bg/60"
                >
                  <span
                    className={`shrink-0 rounded border px-1.5 py-0.5 text-mark ${decisionTone(decision.state)}`}
                  >
                    {decision.state}
                  </span>
                  <span className="truncate text-sol-text group-hover:underline">
                    {decision.title}
                  </span>
                  {decision.answer && (
                    <span className="shrink-0 truncate text-sol-text-dim">
                      · {decision.answer}
                    </span>
                  )}
                  <ChevronRight className="ml-auto h-3 w-3 shrink-0 text-sol-text-dim opacity-0 group-hover:opacity-100" />
                </Link>
              ))}
              {(summary.decisions.length > 4 || extraDecisions > 0) && (
                <span className="text-meta tabular-nums text-sol-text-dim">
                  +{Math.max(0, summary.decisions.length - 4) + extraDecisions}
                  {summary.decisions_truncated ? "+" : ""}
                </span>
              )}
            </div>
          </div>
        )}

        {summary.open_prompt && (
          <div
            data-cc-late-join-prompt
            className="flex items-center gap-2 text-meta"
          >
            <span className="w-16 shrink-0 text-sol-text-dim">Prompt</span>
            <button
              type="button"
              data-cc-late-join-prompt-jump
              onClick={() => onJumpPrompt(summary.open_prompt!)}
              className="group flex min-w-0 flex-1 items-center gap-1.5 text-left hover:underline"
            >
              <span className="shrink-0 rounded border border-sol-orange/40 bg-sol-orange/10 px-1.5 py-0.5 text-mark text-sol-orange">
                {summary.open_prompt.kind}
              </span>
              <span className="min-w-0 truncate text-sol-text">
                {summary.open_prompt.label}
              </span>
              <ArrowDownRight className="h-3 w-3 shrink-0 text-sol-orange" />
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
