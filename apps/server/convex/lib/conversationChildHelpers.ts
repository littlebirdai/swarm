import { query, type QueryCtx } from "../functions";
import { Doc, Id } from "../_generated/dataModel";
import { inboxVisibilityFields } from "../inboxProjection";
import { isNoiseTitle } from "../inboxFilters";
import { filterUserMessages } from "../userMessagesFilter";
import { checkConversationAccess } from "../privacy";

// Compress a raw message body into a short chip/snippet. Strips command/HTML
// wrappers (e.g. `<command-name>/commit</command-name>`) and collapses
// whitespace so a branch's divergent prompt reads cleanly in ~one line.
export function previewText(
  content: string | null | undefined,
): string | undefined {
  if (!content) return undefined;
  const cleaned = content
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return undefined;
  return cleaned.length > 100 ? cleaned.slice(0, 100) + "…" : cleaned;
}

// The first *genuine* user prompt on a branch after `afterTs` — i.e. the message
// the human typed that sent this branch its own way. For a fork that's the
// prompt past the fork cutoff; for the origin line it's the next human turn
// after the fork point. This is what distinguishes otherwise-identical sibling
// branches.
//
// Routes rows through the same `filterUserMessages` gate the message browser /
// rewind navigator uses, so the chip label matches a prompt you could actually
// navigate to. That gate strips harness context blocks (`<task-notification>`,
// `<system-reminder>`, `<task-reminder>`) and drops noise (tool-result echoes,
// interrupt stubs, compact boundaries, import notices) — without it a
// background-task notification leaked through as a chip reading like its raw
// ids ("w68f2jcpo toolu_01…"). Read window is generous because an
// orchestration origin line can run many tool/notification rows between the
// fork point and its next human prompt.
async function firstDivergentPreview(
  ctx: { db: any },
  conversationId: Id<"conversations">,
  afterTs: number,
): Promise<string | undefined> {
  const rows = await ctx.db
    .query("messages")
    .withIndex("by_conversation_role_timestamp", (q: any) =>
      q
        .eq("conversation_id", conversationId)
        .eq("role", "user")
        .gt("timestamp", afterTs),
    )
    .order("asc")
    .take(40);
  for (const m of filterUserMessages(rows)) {
    const p = previewText(m.content);
    if (p) return p;
  }
  return undefined;
}

// The origin line is just another sibling branch in the UI, so it needs the
// same "what prompt sent it this way" snippet the forks carry: its next user
// turn after the fork point. Which line is "the origin" depends on where each
// fork anchored — a child forked off THIS conversation (origin = this one),
// while a sibling forked off our parent (origin = forked_from). Fork-point
// timestamps come from a uuid lookup (it's shared history) so this needs no
// loaded message window — callable from the meta-only query.
export async function computeOriginDivergentPreviews(
  ctx: { db: any },
  conversation: any,
  forkChildrenDetails: Array<{ parent_message_uuid?: string }>,
  forkSiblings: Array<{ parent_message_uuid?: string }>,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const fill = async (
    forks: Array<{ parent_message_uuid?: string }>,
    originLineId: Id<"conversations"> | undefined,
  ) => {
    if (!originLineId) return;
    const seen = new Set<string>();
    for (const fork of forks) {
      const uuid = fork.parent_message_uuid;
      if (!uuid || seen.has(uuid) || out[uuid]) continue;
      seen.add(uuid);
      const fp = await ctx.db
        .query("messages")
        .withIndex("by_conversation_uuid", (q: any) =>
          q.eq("conversation_id", originLineId).eq("message_uuid", uuid),
        )
        .first();
      if (!fp) continue;
      const preview = await firstDivergentPreview(
        ctx,
        originLineId,
        fp.timestamp,
      );
      if (preview) out[uuid] = preview;
    }
  };
  await fill(forkChildrenDetails, conversation._id);
  await fill(forkSiblings, conversation.forked_from ?? undefined);
  return out;
}

// The handoff link's display payload (`cast handoff --to`, handoff.start):
// enough for a chip and a click-through, nothing that needs access rules of
// its own — same contract as forked_from_details, which likewise names the
// origin to anyone who can see this row. `getDoc` is the memo on the inbox
// paths; a plain db.get elsewhere.
export type HandoffLinkDetails = {
  conversation_id: string;
  short_id: string;
  title: string | null;
  agent_type: string | null;
  model: string | null;
};

export async function handoffLinkDetails(
  getDoc: (id: any) => Promise<any>,
  id: Id<"conversations"> | string | null | undefined,
): Promise<HandoffLinkDetails | null> {
  if (!id) return null;
  const conv = await getDoc(id);
  if (!conv) return null;
  return {
    conversation_id: String(conv._id),
    short_id: conv.short_id ?? String(conv._id).slice(0, 7),
    title: conv.title ?? null,
    agent_type: conv.agent_type ?? null,
    model: conv.model ?? null,
  };
}

// The successor of a source row: the forward pointer, else the newest child
// that points back (an older row, or a patch that never landed).
export async function handedOffToId(
  ctx: { db: any },
  conv: {
    _id: Id<"conversations">;
    handed_off_to_conversation_id?: Id<"conversations"> | null;
  },
): Promise<Id<"conversations"> | null> {
  if (conv.handed_off_to_conversation_id)
    return conv.handed_off_to_conversation_id;
  const child = await ctx.db
    .query("conversations")
    .withIndex("by_handed_off_from", (q: any) =>
      q.eq("handed_off_from_conversation_id", conv._id),
    )
    .order("desc")
    .first();
  return child?._id ?? null;
}

async function mapForkDetails(ctx: { db: any }, forks: any[]) {
  return Promise.all(
    forks.map(async (fork: any) => {
      const forkUser = await ctx.db.get(fork.user_id);
      // The prompt that defines this branch: first user message past the fork
      // cutoff. Drives the chip label so siblings read distinctly instead of by
      // their convergent auto-titles.
      const first_divergent_preview = await firstDivergentPreview(
        ctx,
        fork._id,
        fork.fork_cutoff_timestamp ?? 0,
      );
      return {
        _id: fork._id,
        user_id: fork.user_id,
        title: fork.title || "New Session",
        short_id: fork.short_id,
        started_at: fork.started_at,
        username: forkUser?.name || forkUser?.email?.split("@")[0] || "Unknown",
        parent_message_uuid: fork.parent_message_uuid,
        agent_type: fork.agent_type,
        // A cloud agent's branch is named by it (another attempt of a Codex Cloud task).
        session_id: fork.session_id,
        message_count: fork.message_count,
        first_divergent_preview,
        // Free fields straight off the conversation row — no extra reads. The
        // client subtracts fork_copied (messages inherited from the parent up to
        // the fork point) from message_count to show this branch's *own* size,
        // and uses updated_at to derive an unread badge against its local
        // _seenMessageCount cursor. The rest enriches the hover.
        updated_at: fork.updated_at,
        last_message_preview: fork.last_message_preview,
        last_message_role: fork.last_message_role,
        last_user_message_at: fork.last_user_message_at,
        status: fork.status,
        git_branch: fork.git_branch,
        fork_copied: fork.fork_copied,
        // A copy still in flight reports a partial fork_copied; the client
        // treats such a row as unable to vouch for the inherited prefix.
        fork_status: fork.fork_status,
        // Triage/visibility state, free off the same row. The client preloads
        // every returned branch into its sessions cache (preloadForkSessions);
        // omitting these seeded a stashed/dismissed branch as an ACTIVE row,
        // which rendered as a needs-input card on every boot until the live
        // inbox payload delivered the real stamps (the "forks flash in the
        // inbox on reload" bug). A seeded row must never claim more liveness
        // than the server row it came from.
        forked_from: fork.forked_from,
        project_path: fork.project_path,
        git_root: fork.git_root,
        ...inboxVisibilityFields(fork),
      };
    }),
  );
}

// Forks of `parentId` the viewer may actually open, shaped for the branch UI.
// Filtering by access is load-bearing, not cosmetic: the client preloads every
// returned branch into its local store for instant switching, so an unfiltered
// list would both leak teammates' private forks into the inbox AND surface chips
// that deny on click (the "branch spins forever" bug). Owner forks short-circuit
// the access check, so the common all-mine case stays cheap.
// The conversation that spawned this one, for the "Spawned from parent" link
// and the initial-prompt attribution. Stored on subagent rows; older subagents
// only know the spawning message's uuid, so it resolves through that. A FORK
// also carries parent_message_uuid (its fork point), but it was not spawned
// by anything — its origin is forked_from, surfaced through
// forked_from_details — so the uuid lookup must not run for it: resolving it
// dressed every fork as a subagent (a "Spawned from parent session" banner and,
// when the fork point was the first loaded message, the fork point itself
// rendered as a message FROM the parent, which hid the branch chips).
export async function resolveSpawnParentId(
  ctx: { db: { query: QueryCtx["db"]["query"] } },
  conversation: {
    parent_conversation_id?: Id<"conversations"> | null;
    parent_message_uuid?: string | null;
    forked_from?: Id<"conversations"> | null;
  },
): Promise<string | null> {
  if (conversation.parent_conversation_id)
    return conversation.parent_conversation_id;
  if (conversation.forked_from || !conversation.parent_message_uuid)
    return null;
  const parentMsg = await ctx.db
    .query("messages")
    .withIndex("by_message_uuid", (q) =>
      q.eq("message_uuid", conversation.parent_message_uuid!),
    )
    .first();
  return parentMsg ? parentMsg.conversation_id : null;
}

export async function getAccessibleForkChildren(
  ctx: QueryCtx,
  authUserId: Id<"users"> | null,
  parentId: Id<"conversations">,
) {
  const forks = await ctx.db
    .query("conversations")
    .withIndex("by_forked_from", (q) => q.eq("forked_from", parentId))
    .collect();
  const visible = [];
  for (const fork of forks) {
    if ((await checkConversationAccess(ctx, authUserId, fork)) !== "denied") {
      visible.push(fork);
    }
  }
  return mapForkDetails(ctx, visible);
}

function matchChildByPrompt(
  prompt: string,
  subagents: Array<{ _id: string; preview: string }>,
): string | undefined {
  if (!prompt || subagents.length === 0) return undefined;
  const promptStart = prompt.slice(0, 100).toLowerCase().trim();
  for (const child of subagents) {
    const preview = child.preview.slice(0, 100).toLowerCase().trim();
    if (
      promptStart === preview ||
      promptStart.startsWith(preview) ||
      preview.startsWith(promptStart)
    ) {
      return child._id;
    }
  }
  return undefined;
}

export async function findChildConversations(
  ctx: { db: any },
  conversationId: Id<"conversations">,
  messages: Array<{
    message_uuid?: string;
    tool_calls?: Array<{ name: string; input: string }>;
  }>,
): Promise<{
  children: Array<{
    _id: string;
    title: string;
    is_subagent?: boolean;
    first_message_preview?: string;
  }>;
  map: Record<string, string>;
  agentNameEntries: Array<[string, string]>;
}> {
  const map: Record<string, string> = {};

  const CHILDREN_LIMIT = 2000;
  const allChildren = await ctx.db
    .query("conversations")
    .withIndex("by_parent_conversation_id", (q: any) =>
      q.eq("parent_conversation_id", conversationId),
    )
    .order("desc")
    .take(CHILDREN_LIMIT);

  const subagentChildren = allChildren.filter(
    (c: any) => c.is_subagent || !c.parent_message_uuid,
  );
  const PREVIEW_LIMIT = 24;
  const firstMessagePreviews = new Map<string, string>();
  const previewChildren = subagentChildren
    .filter((child: any) => !child.parent_message_uuid)
    .slice(0, PREVIEW_LIMIT);
  await Promise.all(
    previewChildren.map(async (child: any) => {
      const firstMsg = await ctx.db
        .query("messages")
        .withIndex("by_conversation_id", (q: any) =>
          q.eq("conversation_id", child._id),
        )
        .first();
      if (firstMsg?.content) {
        const content =
          typeof firstMsg.content === "string" ? firstMsg.content : "";
        const cleaned = content.replace(/<[^>]+>/g, "").trim();
        firstMessagePreviews.set(child._id as string, cleaned.slice(0, 150));
      }
    }),
  );

  const children = allChildren
    .filter((conv: any) => !isNoiseTitle(conv.title))
    .map((conv: any) => ({
      _id: conv._id,
      title: conv.title || "New Session",
      is_subagent: conv.is_subagent || !conv.parent_message_uuid,
      first_message_preview: firstMessagePreviews.get(conv._id as string),
    }));

  const childByParentUuid = new Map<string, string>(
    allChildren
      .filter((c: any) => c.parent_message_uuid)
      .map((c: any) => [c.parent_message_uuid as string, c._id as string]),
  );
  for (const [uuid, childId] of childByParentUuid) {
    map[uuid] = childId;
  }

  // Build agent name -> child conversation ID map from stored subagent_description
  const agentNameMap: Record<string, string> = {};
  for (const child of subagentChildren) {
    if (child.subagent_description) {
      agentNameMap[child.subagent_description] = child._id as string;
    }
  }

  // Fallback: scan parent messages for Agent/Task tool calls to build UUID map and
  // fill agentNameMap for children without subagent_description (legacy data)
  const unmappedChildren = subagentChildren.filter(
    (c: any) =>
      !c.subagent_description && firstMessagePreviews.has(c._id as string),
  );
  if (unmappedChildren.length > 0) {
    const subagentMatchData = unmappedChildren.map((c: any) => ({
      _id: c._id as string,
      preview: firstMessagePreviews.get(c._id as string)!,
    }));

    const matchToolCall = (msg: any, tc: any) => {
      try {
        const inp = JSON.parse(tc.input);
        if (!inp.prompt) return;
        const childId = matchChildByPrompt(inp.prompt, subagentMatchData);
        if (!childId) return;
        if (inp.name) agentNameMap[inp.name] = childId;
        if (inp.description) agentNameMap[inp.description] = childId;
        if (msg.message_uuid) map[msg.message_uuid] = childId;
      } catch {}
    };

    for (const msg of messages) {
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.name === "Task" || tc.name === "Agent") matchToolCall(msg, tc);
        }
      }
    }

    const matchedChildIds = new Set([
      ...Object.values(map),
      ...Object.values(agentNameMap),
    ]);
    if (
      unmappedChildren.some((child: any) => !matchedChildIds.has(child._id))
    ) {
      const allParentMessages = await ctx.db
        .query("messages")
        .withIndex("by_conversation_role_timestamp", (q: any) =>
          q.eq("conversation_id", conversationId).eq("role", "assistant"),
        )
        .order("desc")
        .take(200);
      for (const msg of allParentMessages) {
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            if (tc.name === "Task" || tc.name === "Agent")
              matchToolCall(msg, tc);
          }
        }
      }
    }
  }

  return { children, map, agentNameEntries: Object.entries(agentNameMap) };
}

/**
 * The fork fields of a conversation the daemon creates as a fork of another
 * whose shared history its own transcript carries (a cloud agent's branch).
 * A branch the person never opened is no card of its own: its origin's card
 * stands for the task and its fork chips lead to it. It files where its origin
 * is filed (a task already dismissed or snoozed does not come back), else it
 * is born stashed; a message sent to it brings it back like any stash.
 */
export function daemonForkFields(
  origin: Pick<
    Doc<"conversations">,
    | "_id"
    | "inbox_dismissed_at"
    | "inbox_stashed_at"
    | "inbox_stash_hidden"
    | "inbox_snoozed_until"
  >,
  fork: { at_uuid: string; copied: number; cutoff?: number },
  now: number,
) {
  const triage = (
    [
      "inbox_dismissed_at",
      "inbox_stashed_at",
      "inbox_stash_hidden",
      "inbox_snoozed_until",
    ] as const
  ).filter((k) => origin[k] !== undefined && origin[k] !== null);
  return {
    forked_from: origin._id,
    fork_copied: fork.copied,
    ...(fork.cutoff !== undefined
      ? { fork_cutoff_timestamp: fork.cutoff }
      : {}),
    ...(origin.inbox_stashed_at ? {} : { inbox_stashed_at: now }),
    ...Object.fromEntries(triage.map((k) => [k, origin[k]])),
  };
}
