import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { query } from "./functions";
import {
  readAnchorMessage,
  readAnchorRow,
} from "./lib/conversationReadAnchors";
import { answerLabel } from "./lib/decisionVerdict";
import { firstUnansweredOpenTurnPrompt } from "./lib/edge/prompt-answers.route";
import { checkConversationAccess } from "./privacy";
import {
  approxMessageBytes,
  isNavigableUserMessage,
  NAV_PROMPT_LIVE_SINCE,
} from "./userMessagesFilter";

const TURN_COUNT_CAP = 200;
const TURN_SCAN_DOC_LIMIT = 600;
const TURN_SCAN_BYTE_LIMIT = 1_500_000;
const SNAPSHOT_SCAN_CAP = 200;
const FILE_CHANGES_SCAN_CAP = 500;
const MAX_CHANGED_FILES = 25;
const DECISIONS_SCAN_CAP = 50;
const MAX_DECISIONS = 10;
const STALE_PENDING_MS = 2 * 60 * 60 * 1000;

const DECISION_STATUSES = [
  "pending",
  "answered",
  "dismissed",
  "withdrawn",
] as const;

type ChangedFileSummary = {
  path: string;
  count: number;
};

type DecisionSummary = {
  _id: Id<"session_decisions">;
  short_id?: string;
  title: string;
  state: Doc<"session_decisions">["status"];
  answer?: string;
};

type OpenPromptSummary = {
  kind: "permission" | "question";
  label: string;
  tool_name?: string;
  created_at: number;
};

async function countTurnsSince(
  ctx: QueryCtx,
  conversation: Doc<"conversations">,
  since: number,
): Promise<{ count: number; truncated: boolean }> {
  const indexedFrom =
    conversation.nav_prompts_indexed_at !== undefined
      ? since
      : Math.max(since, NAV_PROMPT_LIVE_SINCE);
  const flagged = await ctx.db
    .query("messages")
    .withIndex("by_conversation_nav_prompt", (q) =>
      indexedFrom === since
        ? q
            .eq("conversation_id", conversation._id)
            .eq("nav_prompt", true)
            .gt("timestamp", since)
        : q
            .eq("conversation_id", conversation._id)
            .eq("nav_prompt", true)
            .gte("timestamp", indexedFrom),
    )
    .order("desc")
    .take(TURN_COUNT_CAP + 1);

  let count = flagged.filter((m) => m.timestamp > since).length;
  if (count > TURN_COUNT_CAP) {
    return { count: TURN_COUNT_CAP, truncated: true };
  }
  if (indexedFrom <= since) {
    return { count, truncated: false };
  }

  let docs = 0;
  let bytes = 0;
  let truncated = false;
  const older = ctx.db
    .query("messages")
    .withIndex("by_conversation_role_timestamp", (q) =>
      q
        .eq("conversation_id", conversation._id)
        .eq("role", "user")
        .gt("timestamp", since)
        .lt("timestamp", indexedFrom),
    )
    .order("desc");

  for await (const m of older) {
    if (m.timestamp <= since) break;
    if (m.timestamp >= indexedFrom) continue;
    if (isNavigableUserMessage(m as any)) {
      count++;
      if (count > TURN_COUNT_CAP) {
        count = TURN_COUNT_CAP;
        truncated = true;
        break;
      }
    }
    if (++docs >= TURN_SCAN_DOC_LIMIT) {
      truncated = true;
      break;
    }
    if ((bytes += approxMessageBytes(m as any)) >= TURN_SCAN_BYTE_LIMIT) {
      truncated = true;
      break;
    }
  }

  return { count, truncated };
}

async function readChangedFilesSince(
  ctx: QueryCtx,
  conversationId: Id<"conversations">,
  since: number,
): Promise<{
  files: ChangedFileSummary[];
  total: number;
  snapshotTurnCount: number;
}> {
  const [snapshots, fileChanges] = await Promise.all([
    ctx.db
      .query("tree_snapshots")
      .withIndex("by_conversation_taken", (q) =>
        q.eq("conversation_id", conversationId).gt("taken_at", since),
      )
      .order("desc")
      .take(SNAPSHOT_SCAN_CAP),
    ctx.db
      .query("file_changes")
      .withIndex("by_conversation_timestamp", (q) =>
        q.eq("conversation_id", conversationId).gt("timestamp", since),
      )
      .order("desc")
      .take(FILE_CHANGES_SCAN_CAP),
  ]);

  let snapshotTurnCount = 0;
  const snapshotCounts = new Map<string, number>();
  for (const snap of snapshots) {
    if (snap.source === "turn") snapshotTurnCount++;
    if (snap.source === "prompt") continue;
    for (const path of snap.changed_paths) {
      snapshotCounts.set(path, (snapshotCounts.get(path) ?? 0) + 1);
    }
  }

  const editCounts = new Map<string, number>();
  for (const change of fileChanges) {
    if (change.change_type === "commit") continue;
    editCounts.set(
      change.file_path,
      (editCounts.get(change.file_path) ?? 0) + 1,
    );
  }

  const paths = new Set([...editCounts.keys(), ...snapshotCounts.keys()]);
  const merged: ChangedFileSummary[] = [];
  for (const path of paths) {
    merged.push({
      path,
      count: Math.max(editCounts.get(path) ?? 0, snapshotCounts.get(path) ?? 0),
    });
  }
  merged.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));

  return {
    files: merged.slice(0, MAX_CHANGED_FILES),
    total: merged.length,
    snapshotTurnCount,
  };
}

async function readDecisionsSince(
  ctx: QueryCtx,
  conversationId: Id<"conversations">,
  since: number,
): Promise<{ items: DecisionSummary[]; total: number }> {
  const buckets = await Promise.all(
    DECISION_STATUSES.map((status) =>
      ctx.db
        .query("session_decisions")
        .withIndex("by_conversation_status", (q) =>
          q.eq("conversation_id", conversationId).eq("status", status),
        )
        .order("desc")
        .take(DECISIONS_SCAN_CAP),
    ),
  );

  const matched = buckets
    .flat()
    .filter(
      (d) =>
        d.created_at > since ||
        (d.resolved_at !== undefined && d.resolved_at > since),
    )
    .sort(
      (a, b) =>
        (b.resolved_at ?? b.created_at) - (a.resolved_at ?? a.created_at),
    );

  const items: DecisionSummary[] = matched.slice(0, MAX_DECISIONS).map((d) => {
    const answer =
      d.status === "answered"
        ? answerLabel(d, {
            status: "answered",
            answer_index: d.answer_index,
            answer_text: d.answer_text,
            answer_json: d.answer_json,
          })
        : undefined;
    return {
      _id: d._id,
      ...(d.short_id ? { short_id: d.short_id } : {}),
      title: d.question,
      state: d.status,
      ...(answer ? { answer } : {}),
    };
  });

  return { items, total: matched.length };
}

function askUserQuestionLabel(toolInput: string): string {
  try {
    const parsed = JSON.parse(toolInput) as {
      questions?: Array<{ question?: unknown; header?: unknown }>;
    };
    const first = parsed.questions?.[0];
    if (typeof first?.question === "string" && first.question.trim()) {
      return first.question.trim();
    }
    if (typeof first?.header === "string" && first.header.trim()) {
      return first.header.trim();
    }
  } catch {
    return "Question";
  }
  return "Question";
}

async function readOpenPrompt(
  ctx: QueryCtx,
  conversation: Doc<"conversations">,
): Promise<OpenPromptSummary | null> {
  const cutoff = Date.now() - STALE_PENDING_MS;
  const pending = await ctx.db
    .query("pending_permissions")
    .withIndex("by_conversation_status", (q) =>
      q.eq("conversation_id", conversation._id).eq("status", "pending"),
    )
    .order("desc")
    .take(10);

  const activePermission = pending.find((p) => p.created_at > cutoff);
  if (activePermission) {
    return {
      kind: "permission",
      label: activePermission.intent?.trim() || activePermission.tool_name,
      tool_name: activePermission.tool_name,
      created_at: activePermission.created_at,
    };
  }

  if (conversation.execution_protocol_state === "fenced") {
    const fencedPrompt = await firstUnansweredOpenTurnPrompt(ctx, conversation);
    if (fencedPrompt) {
      return {
        kind: fencedPrompt.kind,
        label: fencedPrompt.kind === "permission" ? "Permission" : "Question",
        created_at: conversation.updated_at,
      };
    }
  }

  const latestMessage = await ctx.db
    .query("messages")
    .withIndex("by_conversation_timestamp", (q) =>
      q.eq("conversation_id", conversation._id),
    )
    .order("desc")
    .first();

  if (latestMessage?.role === "assistant") {
    const askCall = latestMessage.tool_calls?.find(
      (tc) => tc.name === "AskUserQuestion",
    );
    if (askCall) {
      return {
        kind: "question",
        label: askUserQuestionLabel(askCall.input),
        created_at: latestMessage.timestamp,
      };
    }
  }

  return null;
}

export const get = query({
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, { conversation_id }) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const conversation = await ctx.db.get(conversation_id);
    if (
      !conversation ||
      (await checkConversationAccess(ctx, userId, conversation)) === "denied"
    ) {
      return null;
    }

    const anchorRow = await readAnchorRow(ctx, userId, conversation_id);
    if (!anchorRow?.anchor) return null;
    const anchorMessage = await readAnchorMessage(
      ctx,
      conversation_id,
      anchorRow.anchor,
    );
    if (!anchorMessage) return null;

    const since = anchorMessage.timestamp;
    const [turns, files, decisions, openPrompt] = await Promise.all([
      countTurnsSince(ctx, conversation, since),
      readChangedFilesSince(ctx, conversation_id, since),
      readDecisionsSince(ctx, conversation_id, since),
      readOpenPrompt(ctx, conversation),
    ]);

    return {
      anchor: {
        message_id: anchorRow.anchor.message_id,
        offset: anchorRow.anchor.offset,
        timestamp: anchorMessage.timestamp,
        changed_at: anchorRow.anchor.changed_at,
      },
      new_turns: Math.max(turns.count, files.snapshotTurnCount),
      turns_truncated: turns.truncated,
      changed_files: files.files,
      changed_files_total: files.total,
      decisions: decisions.items,
      decisions_total: decisions.total,
      open_prompt: openPrompt,
    };
  },
});
