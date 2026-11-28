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
import { readFencedBindingAndPromptState } from "./lib/edge/prompt-answers.route";
import { sharedPromptPermissionsEnabled } from "./lib/edge/prompt-authority.rules";
import { checkConversationAccess, type AccessLevel } from "./privacy";
import { redactSecrets } from "./redact";
import { answerOnItsWay, viewerSeesDetail } from "./teamSuggestions";
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

const RESOLVED_DECISION_STATUSES = [
  "answered",
  "dismissed",
  "withdrawn",
] as const;

const PERMISSION_SKIP_TOOLS = new Set([
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
]);

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
  source: "pending_permission" | "fenced_turn" | "message";
  label: string;
  tool_name?: string;
  created_at: number;
  message_id?: Id<"messages">;
  timestamp?: number;
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
  includeSnapshots: boolean,
): Promise<{
  files: ChangedFileSummary[];
  total: number;
  truncated: boolean;
  snapshotTurnCount: number;
  snapshotsTruncated: boolean;
}> {
  const [rawSnapshots, rawFileChanges] = await Promise.all([
    includeSnapshots
      ? ctx.db
          .query("tree_snapshots")
          .withIndex("by_conversation_taken", (q) =>
            q.eq("conversation_id", conversationId).gt("taken_at", since),
          )
          .order("desc")
          .take(SNAPSHOT_SCAN_CAP + 1)
      : Promise.resolve([]),
    ctx.db
      .query("file_changes")
      .withIndex("by_conversation_timestamp", (q) =>
        q.eq("conversation_id", conversationId).gt("timestamp", since),
      )
      .order("desc")
      .take(FILE_CHANGES_SCAN_CAP + 1),
  ]);

  const snapshotsTruncated = rawSnapshots.length > SNAPSHOT_SCAN_CAP;
  const fileChangesTruncated = rawFileChanges.length > FILE_CHANGES_SCAN_CAP;
  const snapshots = rawSnapshots.slice(0, SNAPSHOT_SCAN_CAP);
  const fileChanges = rawFileChanges.slice(0, FILE_CHANGES_SCAN_CAP);

  let snapshotTurnCount = 0;
  let pathsClipped = false;
  const snapshotCounts = new Map<string, number>();
  for (const snap of snapshots) {
    if (snap.source === "turn") snapshotTurnCount++;
    if (snap.source === "prompt") continue;
    if (snap.changed_count > snap.changed_paths.length) pathsClipped = true;
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
    truncated: snapshotsTruncated || fileChangesTruncated || pathsClipped,
    snapshotTurnCount,
    snapshotsTruncated,
  };
}

async function readDecisionsSince(
  ctx: QueryCtx,
  conversationId: Id<"conversations">,
  since: number,
): Promise<{ items: DecisionSummary[]; total: number; truncated: boolean }> {
  const [pendingRaw, ...resolvedBuckets] = await Promise.all([
    ctx.db
      .query("session_decisions")
      .withIndex("by_conversation_status", (q) =>
        q.eq("conversation_id", conversationId).eq("status", "pending"),
      )
      .order("desc")
      .take(DECISIONS_SCAN_CAP + 1),
    ...RESOLVED_DECISION_STATUSES.map((status) =>
      ctx.db
        .query("session_decisions")
        .withIndex("by_conversation_status_resolved", (q) =>
          q
            .eq("conversation_id", conversationId)
            .eq("status", status)
            .gt("resolved_at", since),
        )
        .order("desc")
        .take(DECISIONS_SCAN_CAP + 1),
    ),
  ]);

  let truncated =
    pendingRaw.length > DECISIONS_SCAN_CAP &&
    pendingRaw[DECISIONS_SCAN_CAP]!.created_at > since;
  const byId = new Map<string, Doc<"session_decisions">>();
  for (const d of pendingRaw.slice(0, DECISIONS_SCAN_CAP)) {
    if (d.created_at > since) {
      byId.set(String(d._id), d);
    }
  }
  for (const bucket of resolvedBuckets) {
    if (bucket.length > DECISIONS_SCAN_CAP) {
      truncated = true;
    }
    for (const d of bucket.slice(0, DECISIONS_SCAN_CAP)) {
      if (d.resolved_at !== undefined && d.resolved_at > since) {
        byId.set(String(d._id), d);
      }
    }
  }

  const matched = [...byId.values()].sort(
    (a, b) => (b.resolved_at ?? b.created_at) - (a.resolved_at ?? a.created_at),
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

  return { items, total: matched.length, truncated };
}

function parseAskUserQuestionInput(toolInput: string): {
  label: string;
  expired: boolean;
  fencedTurnId?: string;
} {
  try {
    const parsed = JSON.parse(toolInput) as {
      deniesAt?: unknown;
      fencedTurnId?: unknown;
      questions?: Array<{ question?: unknown; header?: unknown }>;
    };
    const expired =
      typeof parsed.deniesAt === "number" && parsed.deniesAt <= Date.now();
    const fencedTurnId =
      typeof parsed.fencedTurnId === "string" ? parsed.fencedTurnId : undefined;
    const first = parsed.questions?.[0];
    const label =
      typeof first?.question === "string" && first.question.trim()
        ? first.question.trim()
        : typeof first?.header === "string" && first.header.trim()
          ? first.header.trim()
          : "Question";
    return { label, expired, fencedTurnId };
  } catch {
    return { label: "Question", expired: false };
  }
}

async function resolvePermissionViewer(
  ctx: QueryCtx,
  userId: Id<"users">,
  conversation: Doc<"conversations">,
  access: AccessLevel,
  preloadedBinding: Doc<"execution_bindings"> | null,
): Promise<{
  runner: boolean;
  proposer: boolean;
  sharedFenced: boolean;
}> {
  const runner = conversation.user_id.toString() === userId.toString();
  if (runner) {
    return { runner: true, proposer: false, sharedFenced: false };
  }
  if (access === "shared") {
    return { runner: false, proposer: false, sharedFenced: false };
  }
  const ownerDoc = await ctx.db.get(conversation.user_id);
  const proposer =
    !ownerDoc?.is_bot && (await viewerSeesDetail(ctx, userId, conversation));
  const sharedFenced = await sharedPromptPermissionsEnabled(
    ctx,
    conversation,
    preloadedBinding,
  );
  return { runner: false, proposer, sharedFenced };
}

async function readOpenPrompt(
  ctx: QueryCtx,
  userId: Id<"users">,
  conversation: Doc<"conversations">,
  access: AccessLevel,
): Promise<OpenPromptSummary | null> {
  const { binding: fencedBinding, fencedState } =
    conversation.execution_protocol_state === "fenced"
      ? await readFencedBindingAndPromptState(ctx, conversation)
      : { binding: null, fencedState: null };

  const permViewer = await resolvePermissionViewer(
    ctx,
    userId,
    conversation,
    access,
    fencedBinding,
  );
  const canReadPermission =
    permViewer.runner || permViewer.proposer || permViewer.sharedFenced;

  if (canReadPermission) {
    const cutoff = Date.now() - STALE_PENDING_MS;
    const pending = await ctx.db
      .query("pending_permissions")
      .withIndex("by_conversation_status", (q) =>
        q.eq("conversation_id", conversation._id).eq("status", "pending"),
      )
      .order("desc")
      .take(10);

    for (const p of pending) {
      if (p.created_at <= cutoff) continue;
      if (PERMISSION_SKIP_TOOLS.has(p.tool_name)) continue;
      if (
        !permViewer.runner &&
        !permViewer.proposer &&
        !(permViewer.sharedFenced && p.fenced_prompt_id)
      ) {
        continue;
      }
      if (
        fencedState &&
        p.fenced_prompt_id &&
        p.fenced_prompt_turn_id &&
        (await fencedState.isAnswered(
          p.fenced_prompt_turn_id,
          p.fenced_prompt_id,
        ))
      ) {
        continue;
      }
      const label = permViewer.runner
        ? p.intent?.trim() || p.tool_name
        : permViewer.proposer
          ? redactSecrets(p.arguments_preview).trim() || p.tool_name
          : p.tool_name;
      return {
        kind: "permission",
        source: "pending_permission",
        label,
        tool_name: p.tool_name,
        created_at: p.created_at,
      };
    }
  }

  if (fencedState?.openPrompt) {
    if (access === "shared") return null;
    if (fencedState.openPrompt.kind === "permission") {
      if (!canReadPermission) return null;
      return {
        kind: "permission",
        source: "fenced_turn",
        label: "Permission",
        created_at: conversation.updated_at,
      };
    }

    const latestForFenced = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q) =>
        q.eq("conversation_id", conversation._id),
      )
      .order("desc")
      .first();
    const askCall =
      latestForFenced?.role === "assistant"
        ? latestForFenced.tool_calls?.find(
            (tc) =>
              (tc.name === "AskUserQuestion" ||
                tc.name === "ask_user_question") &&
              tc.id === fencedState.openPrompt!.prompt_id,
          )
        : undefined;
    if (askCall && latestForFenced) {
      const parsed = parseAskUserQuestionInput(askCall.input);
      if (parsed.expired) return null;
      return {
        kind: "question",
        source: "fenced_turn",
        label: parsed.label,
        created_at: latestForFenced.timestamp,
        message_id: latestForFenced._id,
        timestamp: latestForFenced.timestamp,
      };
    }

    return {
      kind: "question",
      source: "fenced_turn",
      label: "Question",
      created_at: conversation.updated_at,
    };
  }

  if (fencedState?.allOpenTurnPromptsAnswered) {
    return null;
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
      (tc) => tc.name === "AskUserQuestion" || tc.name === "ask_user_question",
    );
    if (askCall) {
      const parsed = parseAskUserQuestionInput(askCall.input);
      if (parsed.expired) return null;
      if (latestMessage.message_uuid?.startsWith("owned-prompt:")) {
        const closed = await ctx.db
          .query("messages")
          .withIndex("by_conversation_uuid", (q) =>
            q
              .eq("conversation_id", conversation._id)
              .eq("message_uuid", `${latestMessage.message_uuid}-closed`),
          )
          .first();
        if (closed) return null;
        if (
          fencedState &&
          parsed.fencedTurnId &&
          (await fencedState.isAnswered(parsed.fencedTurnId, askCall.id))
        ) {
          return null;
        }
      }
      if (
        await answerOnItsWay(
          ctx,
          conversation._id,
          latestMessage._creationTime ?? 0,
        )
      ) {
        return null;
      }
      return {
        kind: "question",
        source: "message",
        label: parsed.label,
        created_at: latestMessage.timestamp,
        message_id: latestMessage._id,
        timestamp: latestMessage.timestamp,
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
    if (!conversation) return null;
    const access = await checkConversationAccess(ctx, userId, conversation);
    if (access === "denied") return null;

    const anchorRow = await readAnchorRow(ctx, userId, conversation_id);
    if (!anchorRow?.anchor) return null;
    const anchorMessage = await readAnchorMessage(
      ctx,
      conversation_id,
      anchorRow.anchor,
    );
    if (!anchorMessage) return null;

    const since = anchorMessage.timestamp;
    const canReadPrivateSections = access !== "shared";
    const [turns, files, decisions, openPrompt] = await Promise.all([
      countTurnsSince(ctx, conversation, since),
      readChangedFilesSince(
        ctx,
        conversation_id,
        since,
        canReadPrivateSections,
      ),
      canReadPrivateSections
        ? readDecisionsSince(ctx, conversation_id, since)
        : Promise.resolve({ items: [], total: 0, truncated: false }),
      readOpenPrompt(ctx, userId, conversation, access),
    ]);

    const rawTurns = Math.max(turns.count, files.snapshotTurnCount);
    const newTurns = Math.min(rawTurns, TURN_COUNT_CAP);
    const turnsTruncated =
      turns.truncated || files.snapshotsTruncated || rawTurns > TURN_COUNT_CAP;

    return {
      anchor: {
        message_id: anchorRow.anchor.message_id,
        offset: anchorRow.anchor.offset,
        timestamp: anchorMessage.timestamp,
        changed_at: anchorRow.anchor.changed_at,
      },
      new_turns: newTurns,
      turns_truncated: turnsTruncated,
      changed_files: files.files,
      changed_files_total: files.total,
      changed_files_truncated: files.truncated,
      decisions: decisions.items,
      decisions_total: decisions.total,
      decisions_truncated: decisions.truncated,
      can_open_decisions: canReadPrivateSections,
      open_prompt: openPrompt,
    };
  },
});
