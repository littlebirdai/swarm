import { query } from "./functions";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Id } from "./_generated/dataModel";
import { isRunLog } from "./inboxFilters";
import { isImportNotice } from "./userMessagesFilter";
import { createTeamFeedFilter, resolveVisibilityMode } from "./privacy";
import { currentMembershipVisibility } from "./teamVisibility";
import { batchScanConversations, paginateTeamFeed } from "./feedPagination";
import { liveConversationIdSet } from "./lib/liveSessions";
import { handoffLinkDetails } from "./lib/conversationChildHelpers";
import {
  resolveActingAuthor,
  resolveInboxTeamScope,
} from "./lib/conversationHelpers";

export const listConversations = query({
  args: {
    filter: v.union(v.literal("my"), v.literal("team")),
    limit: v.optional(v.number()),
    cursor: v.optional(v.string()),
    include_message_previews: v.optional(v.boolean()),
    memberId: v.optional(v.id("users")),
    activeTeamId: v.optional(v.id("teams")),
    subagentFilter: v.optional(
      v.union(v.literal("main"), v.literal("subagent")),
    ),
    directoryFilter: v.optional(v.string()),
    timeFilter: v.optional(v.union(v.literal("long"), v.literal("active"))),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return { conversations: [], nextCursor: null };
    }
    const user = await ctx.db.get(userId);
    if (!user) {
      return { conversations: [], nextCursor: null };
    }

    const limit = Math.min(args.limit ?? 20, 1000);
    const includeMessagePreviews = args.include_message_previews ?? false;
    const cursorTimestamp = args.cursor ? parseInt(args.cursor, 10) : null;

    const requestedTeamId =
      args.filter === "team"
        ? args.activeTeamId || user.active_team_id
        : undefined;
    const effectiveTeamId = requestedTeamId
      ? ((await resolveInboxTeamScope(ctx, userId, requestedTeamId)) ??
        undefined)
      : undefined;
    if (args.filter === "team" && !effectiveTeamId) {
      return { conversations: [], nextCursor: null };
    }

    const teamUsers =
      args.filter === "team" && effectiveTeamId
        ? await ctx.db
            .query("users")
            .withIndex("by_team_id", (q) => q.eq("team_id", effectiveTeamId))
            .collect()
        : [];

    const feedFilter =
      args.filter === "team" && effectiveTeamId
        ? await createTeamFeedFilter(ctx, effectiveTeamId)
        : null;

    const additionalUsers = await Promise.all(
      (feedFilter?.memberships ?? [])
        .filter(
          (m) =>
            !teamUsers.some((u) => u._id.toString() === m.user_id.toString()),
        )
        .map((m) => ctx.db.get(m.user_id)),
    );
    const allTeamUsers = [
      ...teamUsers,
      ...additionalUsers.filter((u): u is NonNullable<typeof u> => u !== null),
    ];
    const teamUserMap = new Map(allTeamUsers.map((u) => [u._id.toString(), u]));

    const now = Date.now();
    const fiveMinutesAgo = now - 5 * 60 * 1000;

    const liveConvIds = await liveConversationIdSet(ctx, userId, { now });

    const needsBatchScan = !!(
      args.subagentFilter ||
      args.directoryFilter ||
      args.timeFilter
    );

    const matchesFilters = (c: any): boolean => {
      if (isRunLog(c)) return false;
      if (args.subagentFilter) {
        const isSub = !!(c.parent_conversation_id && !c.parent_message_uuid);
        if (args.subagentFilter === "subagent" && !isSub) return false;
        if (args.subagentFilter === "main" && isSub) return false;
      }
      if (args.directoryFilter) {
        // Matched by the folder's name anywhere in the session's path, as the
        // web feed does (ActivityFeed), so a subfolder or a teammate's copy counts.
        const root = c.git_root || c.project_path;
        if (!root) return false;
        const filterName = args.directoryFilter
          .split("/")
          .filter(Boolean)
          .pop();
        const rootParts = root.split("/").filter(Boolean);
        if (!filterName || !rootParts.includes(filterName)) return false;
      }
      if (args.timeFilter === "active") {
        const isActive =
          c.status === "active" &&
          (c.updated_at > fiveMinutesAgo || liveConvIds.has(c._id.toString()));
        if (!isActive) return false;
      }
      if (args.timeFilter === "long") {
        if (c.updated_at - c.started_at < 20 * 60 * 1000) return false;
      }
      return true;
    };

    let conversations;
    // Set only by the team-merge path, which owns its own cursor protocol.
    let teamMergeNextCursor: string | null | undefined;
    // Examination floors of scans that stopped before exhausting their index
    // (read budget / per-member quota). The page cursor must never dip below an
    // unfinished scan's floor — rows in the unexamined gap would be skipped
    // forever (re-examining is safe, the client dedups; skipping is not) — and
    // a short page must not report end-of-history while a floor remains.
    const scanFloors: number[] = [];
    if (args.filter === "my") {
      // Always a filtered scan: run logs never list, so even an unfiltered
      // page can come back short mid-history.
      const scan = await batchScanConversations({
        fetchPage: (cursor, take) =>
          ctx.db
            .query("conversations")
            .withIndex("by_user_updated", (q) =>
              cursor
                ? q.eq("user_id", userId).lt("updated_at", cursor)
                : q.eq("user_id", userId),
            )
            .order("desc")
            .take(take),
        startCursor: cursorTimestamp,
        want: limit + 1,
        accept: matchesFilters,
        batchSize: needsBatchScan ? Math.min(limit * 3, 50) : limit + 1,
      });
      conversations = scan.rows;
      if (!scan.exhausted && scan.oldestSeen != null)
        scanFloors.push(scan.oldestSeen);
    } else if (args.memberId) {
      // Filter by specific team member - use index for efficient pagination
      const targetMember = teamUserMap.get(args.memberId.toString());
      if (!targetMember) {
        return { conversations: [], nextCursor: null };
      }
      const visibility = feedFilter!.getVisibility(args.memberId.toString());
      if (visibility === "hidden") {
        return { conversations: [], nextCursor: null };
      }

      // One scan covers both the filtered and unfiltered cases: visibility
      // alone can drop rows, so even without extra filters a single take()
      // could return a short page mid-history.
      const scan = await batchScanConversations({
        fetchPage: (cursor, take) =>
          ctx.db
            .query("conversations")
            .withIndex("by_team_user_updated", (q) =>
              cursor
                ? q
                    .eq("team_id", effectiveTeamId!)
                    .eq("user_id", args.memberId!)
                    .lt("updated_at", cursor)
                : q
                    .eq("team_id", effectiveTeamId!)
                    .eq("user_id", args.memberId!),
            )
            .order("desc")
            .take(take),
        startCursor: cursorTimestamp,
        want: limit + 1,
        accept: (c) => feedFilter!.isVisible(c) && matchesFilters(c),
        batchSize: Math.min(limit * 3, 50),
      });
      conversations = scan.rows;
      if (!scan.exhausted && scan.oldestSeen != null)
        scanFloors.push(scan.oldestSeen);
    } else {
      // Query recent conversations from each visible team member and merge.
      // Pagination uses a composite per-member cursor (see feedPagination.ts):
      // each member resumes below what THEY already returned, so pages never
      // re-serve rows the client has, and one member's filtered-out band
      // (e.g. a swarm of subagent sessions) can't stall everyone else.
      const visibleMembers = (feedFilter?.memberships ?? []).filter((m) => {
        const visibility = currentMembershipVisibility(m as any);
        return visibility !== "hidden";
      });

      const maxTotalReads = 100;
      const perMemberFetch = Math.max(
        3,
        Math.min(
          Math.ceil(((limit + 1) * 2) / Math.max(visibleMembers.length, 1)),
          Math.floor(maxTotalReads / Math.max(visibleMembers.length, 1)),
        ),
      );
      const perMemberLimit = Math.max(
        3,
        Math.ceil((limit + 1) / Math.max(visibleMembers.length, 1)),
      );

      const page = await paginateTeamFeed({
        memberIds: visibleMembers.map((m) => m.user_id.toString()),
        cursor: args.cursor ?? null,
        limit,
        fetchPage: (memberId, cursor, take) =>
          ctx.db
            .query("conversations")
            .withIndex("by_team_user_updated", (q) =>
              cursor
                ? q
                    .eq("team_id", effectiveTeamId!)
                    .eq("user_id", memberId as Id<"users">)
                    .lt("updated_at", cursor)
                : q
                    .eq("team_id", effectiveTeamId!)
                    .eq("user_id", memberId as Id<"users">),
            )
            .order("desc")
            .take(take),
        accept: (c) => feedFilter!.isVisible(c) && matchesFilters(c),
        perMemberFetch,
        perMemberWant: perMemberLimit,
        maxBatches: 4,
      });
      conversations = page.rows;
      teamMergeNextCursor = page.nextCursor;
    }

    // The team merge computes its own composite continuation; the single-scan
    // paths ("my", memberId) continue from the page's last row, but never below
    // an unfinished scan's floor (those rows were never examined), and a short
    // page with a remaining floor is NOT end-of-history — null means the scan
    // truly ran its index dry.
    const hasMore =
      teamMergeNextCursor !== undefined
        ? teamMergeNextCursor != null
        : conversations.length > limit;
    const resultConversations =
      teamMergeNextCursor === undefined && hasMore
        ? conversations.slice(0, limit)
        : conversations;
    let nextCursor: string | null;
    if (teamMergeNextCursor !== undefined) {
      nextCursor = teamMergeNextCursor;
    } else {
      const pageCursor = hasMore
        ? resultConversations[resultConversations.length - 1].updated_at
        : null;
      const continuation =
        pageCursor != null ? [...scanFloors, pageCursor] : scanFloors;
      nextCursor =
        continuation.length > 0 ? String(Math.max(...continuation)) : null;
    }

    const conversationsWithUsers = await Promise.all(
      resultConversations.map(async (c) => {
        const conversationUser =
          c.user_id.toString() === userId.toString()
            ? user
            : teamUserMap.get(c.user_id.toString()) ||
              (await ctx.db.get(c.user_id));

        const visibilityMode = resolveVisibilityMode(
          c.team_visibility,
          feedFilter?.getVisibilityFor(c),
          args.filter === "team",
        );
        let authorName =
          (conversationUser as any)?.name ||
          (conversationUser as any)?.email?.split("@")[0] ||
          "Unknown";
        let authorAvatar =
          (conversationUser as any)?.image ||
          (conversationUser as any)?.github_avatar_url ||
          null;
        // An anchor renders under its bot identity even on the host's own row.
        const acting = await resolveActingAuthor(ctx, c);
        if (acting) {
          authorName = acting.name;
          authorAvatar = acting.avatar;
        }
        const projectName =
          (c.project_path || c.git_root)?.split("/").pop() || "unknown project";
        const durationMs = c.updated_at - c.started_at;
        const isActive =
          c.status === "active" &&
          (c.updated_at > fiveMinutesAgo || liveConvIds.has(c._id.toString()));
        const title = c.title || "New Session";

        if (visibilityMode === "minimal") {
          return {
            _id: c._id,
            user_id: c.user_id,
            visibility_mode: visibilityMode,
            author_name: authorName,
            author_avatar: authorAvatar,
            acting_user_id: c.acting_user_id ?? null,
            is_anchor: !!c.anchor_id,
            anchor_id: c.anchor_id ?? null,
            is_own: c.user_id.toString() === userId.toString(),
            is_active: isActive,
            updated_at: c.updated_at,
            started_at: c.started_at,
            duration_ms: durationMs,
            message_count: c.message_count,
            activity_summary: `1 agent in ${projectName}`,
            project_path: c.project_path || null,
            git_root: c.git_root || null,
            active_plan_id: c.active_plan_id || null,
            worktree_name: c.worktree_name || null,
            worktree_branch: c.worktree_branch || null,
            cloud_placement: c.cloud_placement || null,
            cloud_workspace: c.cloud_workspace || null,
            cloud_seed: c.cloud_seed ?? null,
            local_mirror: c.local_mirror ?? null,
            migration_batch_id: c.migration?.batch_id || null,
          };
        }

        if (visibilityMode === "summary") {
          return {
            _id: c._id,
            user_id: c.user_id,
            visibility_mode: visibilityMode,
            title,
            short_title: c.short_title || null,
            subtitle: c.subtitle || null,
            author_name: authorName,
            author_avatar: authorAvatar,
            acting_user_id: c.acting_user_id ?? null,
            is_anchor: !!c.anchor_id,
            anchor_id: c.anchor_id ?? null,
            is_own: c.user_id.toString() === userId.toString(),
            is_active: isActive,
            updated_at: c.updated_at,
            started_at: c.started_at,
            duration_ms: durationMs,
            message_count: c.message_count,
            project_path: c.project_path || null,
            git_root: c.git_root || null,
            tool_names: [],
            subagent_types: [],
            active_plan_id: c.active_plan_id || null,
            worktree_name: c.worktree_name || null,
            worktree_branch: c.worktree_branch || null,
            cloud_placement: c.cloud_placement || null,
            cloud_workspace: c.cloud_workspace || null,
            cloud_seed: c.cloud_seed ?? null,
            local_mirror: c.local_mirror ?? null,
            migration_batch_id: c.migration?.batch_id || null,
          };
        }

        if (!includeMessagePreviews) {
          const fullTitle = c.title || "New Session";
          return {
            _id: c._id,
            user_id: c.user_id,
            visibility_mode: visibilityMode,
            title: fullTitle,
            short_title: c.short_title || null,
            subtitle:
              visibilityMode === "full" || visibilityMode === "detailed"
                ? c.subtitle || null
                : null,
            // Row thumbnail (see schema.image_preview_url) — full/detailed
            // visibility only, so restricted teammates don't leak image URLs.
            image_preview_url:
              visibilityMode === "full" || visibilityMode === "detailed"
                ? (c.image_preview_url ?? null)
                : null,
            first_user_message: null,
            first_assistant_message: null,
            message_alternates: [],
            tool_names: [],
            subagent_types: [],
            agent_type: c.agent_type,
            model: c.model || null,
            slug: visibilityMode === "full" ? c.slug || null : null,
            started_at: c.started_at,
            updated_at: c.updated_at,
            duration_ms: durationMs,
            message_count: c.message_count,
            ai_message_count: 0,
            tool_call_count: 0,
            is_active: isActive,
            author_name: authorName,
            author_avatar: authorAvatar,
            acting_user_id: c.acting_user_id ?? null,
            is_anchor: !!c.anchor_id,
            anchor_id: c.anchor_id ?? null,
            is_own: c.user_id.toString() === userId.toString(),
            parent_conversation_id: c.parent_conversation_id || null,
            parent_message_uuid: c.parent_message_uuid || null,
            is_subagent: !!(
              c.is_subagent ||
              (c.parent_conversation_id && !c.parent_message_uuid)
            ),
            is_workflow_sub: c.is_workflow_sub || false,
            workflow_run_id: c.workflow_run_id || null,
            parent_title: null,
            latest_todos: undefined,
            project_path: c.project_path || null,
            git_root: c.git_root || null,
            git_branch: c.git_branch || null,
            git_remote_url: c.git_remote_url || null,
            // The header's prompt line: HEAD, distance from upstream, dirtiness
            // (conversations.updateGitState).
            git_commit_hash: c.git_commit_hash || null,
            git_ahead: c.git_ahead ?? null,
            git_behind: c.git_behind ?? null,
            git_dirty: c.git_dirty ?? null,
            is_favorite: c.is_favorite || false,
            profile_pinned_at: c.profile_pinned_at,
            fork_count: c.fork_count || 0,
            forked_from: c.forked_from || null,
            is_private: c.is_private,
            team_visibility: c.team_visibility || null,
            auto_shared: c.auto_shared || false,
            active_plan_id: c.active_plan_id || null,
            worktree_name: c.worktree_name || null,
            worktree_branch: c.worktree_branch || null,
            cloud_placement: c.cloud_placement || null,
            cloud_workspace: c.cloud_workspace || null,
            cloud_seed: c.cloud_seed ?? null,
            local_mirror: c.local_mirror ?? null,
            migration_batch_id: c.migration?.batch_id || null,
          };
        }

        // Only fetch first few messages for previews (keep reads minimal to stay under 16MB limit)
        const msgLimit = 3;
        const messages = await ctx.db
          .query("messages")
          .withIndex("by_conversation_id", (q) =>
            q.eq("conversation_id", c._id),
          )
          .order("asc")
          .take(msgLimit);

        let toolCallCount = 0;
        const toolNames: string[] = [];
        const subagentTypes: string[] = [];
        let aiMessageCount = 0;
        const messageAlternates: Array<{
          role: "user" | "assistant";
          content: string;
        }> = [];
        let latestTodos: { todos: any[]; timestamp: number } | undefined;

        for (const msg of messages) {
          if (msg.tool_calls) {
            toolCallCount += msg.tool_calls.length;
            for (const tc of msg.tool_calls) {
              if (toolNames.length < 5 && !toolNames.includes(tc.name)) {
                toolNames.push(tc.name);
              }
              if (tc.name === "Task" && tc.input) {
                try {
                  const input = JSON.parse(tc.input);
                  if (
                    input.subagent_type &&
                    !subagentTypes.includes(input.subagent_type)
                  ) {
                    subagentTypes.push(input.subagent_type);
                  }
                } catch {}
              }
              if (tc.name === "TodoWrite" && tc.input) {
                try {
                  const input = JSON.parse(tc.input);
                  if (input.todos) {
                    if (!latestTodos || msg.timestamp > latestTodos.timestamp) {
                      latestTodos = {
                        todos: input.todos,
                        timestamp: msg.timestamp,
                      };
                    }
                  }
                } catch {}
              }
            }
          }
          if (msg.role === "user") {
            const text = msg.content?.trim();
            // isImportNotice: context-only import banner must not become the
            // preview / first_user_message / fallback title.
            if (text && !isImportNotice(text)) {
              const truncated =
                text.length > 120 ? text.slice(0, 120) + "..." : text;
              messageAlternates.push({ role: "user", content: truncated });
            }
          }
          if (msg.role === "assistant") {
            aiMessageCount++;
            let text = msg.content?.trim();
            if (!text && msg.thinking) {
              text = msg.thinking.trim();
            }
            if (!text && msg.tool_calls && msg.tool_calls.length > 0) {
              const toolNames = msg.tool_calls.map((tc) => tc.name).join(", ");
              text = `[Using: ${toolNames}]`;
            }
            if (text) {
              const truncated =
                text.length > 120 ? text.slice(0, 120) + "..." : text;
              messageAlternates.push({ role: "assistant", content: truncated });
            }
          }
        }

        const firstUserMessage =
          messageAlternates.find((m) => m.role === "user")?.content || "";
        const firstAssistantMessage =
          messageAlternates.find((m) => m.role === "assistant")?.content || "";

        const fullTitle = c.title || firstUserMessage || "New Session";

        // spawned_by (visible child → its lead) joins the same parent
        // resolution so the "sub of"/"spawned by" row and title come free.
        let parentConversationId: string | null =
          c.parent_conversation_id || c.spawned_by_conversation_id || null;
        let parentTitle: string | null = null;
        if (!parentConversationId && c.parent_message_uuid) {
          const parentMsg = await ctx.db
            .query("messages")
            .withIndex("by_message_uuid", (q) =>
              q.eq("message_uuid", c.parent_message_uuid),
            )
            .first();
          if (parentMsg) {
            parentConversationId = parentMsg.conversation_id;
          }
        }
        if (parentConversationId) {
          const parentConv = await ctx.db.get(
            parentConversationId as Id<"conversations">,
          );
          if (parentConv) {
            parentTitle = parentConv.title || "New Session";
          }
        }

        return {
          _id: c._id,
          user_id: c.user_id,
          visibility_mode: visibilityMode,
          title: fullTitle,
          short_title: c.short_title || null,
          subtitle:
            visibilityMode === "full" || visibilityMode === "detailed"
              ? c.subtitle || null
              : null,
          first_user_message:
            visibilityMode === "full" ? firstUserMessage : null,
          first_assistant_message:
            visibilityMode === "full" ? firstAssistantMessage : null,
          message_alternates:
            visibilityMode === "full" ? messageAlternates : [],
          tool_names: toolNames,
          subagent_types: subagentTypes,
          agent_type: c.agent_type,
          model: c.model || null,
          slug: visibilityMode === "full" ? c.slug || null : null,
          started_at: c.started_at,
          updated_at: c.updated_at,
          duration_ms: durationMs,
          message_count: c.message_count,
          ai_message_count: aiMessageCount,
          tool_call_count: toolCallCount,
          is_active: isActive,
          author_name: authorName,
          author_avatar: authorAvatar,
          acting_user_id: c.acting_user_id ?? null,
          is_anchor: !!c.anchor_id,
          anchor_id: c.anchor_id ?? null,
          is_own: c.user_id.toString() === userId.toString(),
          parent_conversation_id:
            visibilityMode === "full" ? parentConversationId : null,
          spawned_by_conversation_id:
            visibilityMode === "full"
              ? c.spawned_by_conversation_id || null
              : null,
          handed_off_from_conversation_id:
            visibilityMode === "full"
              ? c.handed_off_from_conversation_id || null
              : null,
          handed_off_to_conversation_id:
            visibilityMode === "full"
              ? c.handed_off_to_conversation_id || null
              : null,
          handed_off_from_details:
            visibilityMode === "full"
              ? await handoffLinkDetails(
                  (id) => ctx.db.get(id),
                  c.handed_off_from_conversation_id,
                )
              : null,
          handed_off_to_details:
            visibilityMode === "full"
              ? await handoffLinkDetails(
                  (id) => ctx.db.get(id),
                  c.handed_off_to_conversation_id,
                )
              : null,
          parent_message_uuid: c.parent_message_uuid || null,
          is_subagent: !!(
            c.is_subagent ||
            (c.parent_conversation_id && !c.parent_message_uuid)
          ),
          is_workflow_sub: c.is_workflow_sub || false,
          workflow_run_id: c.workflow_run_id || null,
          parent_title: visibilityMode === "full" ? parentTitle : null,
          latest_todos: visibilityMode === "full" ? latestTodos : undefined,
          project_path: c.project_path || null,
          git_root: c.git_root || null,
          git_branch: c.git_branch || null,
          git_remote_url: c.git_remote_url || null,
          // The header's prompt line: HEAD, distance from upstream, dirtiness
          // (conversations.updateGitState).
          git_commit_hash: c.git_commit_hash || null,
          git_ahead: c.git_ahead ?? null,
          git_behind: c.git_behind ?? null,
          git_dirty: c.git_dirty ?? null,
          is_favorite: c.is_favorite || false,
          profile_pinned_at: c.profile_pinned_at,
          fork_count: c.fork_count || 0,
          forked_from: c.forked_from || null,
          is_private: c.is_private,
          team_visibility: c.team_visibility || null,
          auto_shared: c.auto_shared || false,
          active_plan_id: c.active_plan_id || null,
          worktree_name: c.worktree_name || null,
          worktree_branch: c.worktree_branch || null,
          cloud_placement: c.cloud_placement || null,
          cloud_workspace: c.cloud_workspace || null,
          cloud_seed: c.cloud_seed ?? null,
          local_mirror: c.local_mirror ?? null,
          migration_batch_id: c.migration?.batch_id || null,
        };
      }),
    );

    const sortedConvs = conversationsWithUsers.sort(
      (a, b) =>
        (b as { updated_at: number }).updated_at -
        (a as { updated_at: number }).updated_at,
    );

    const planIds = new Set<string>();
    for (const c of sortedConvs) {
      const pid = (c as any).active_plan_id;
      if (pid) planIds.add(pid.toString());
    }
    const planCache = new Map<
      string,
      { _id: string; short_id: string; title: string; status: string }
    >();
    for (const pid of planIds) {
      const p = await ctx.db.get(pid as any);
      if (p)
        planCache.set(pid, {
          _id: (p as any)._id,
          short_id: (p as any).short_id,
          title: (p as any).title,
          status: (p as any).status,
        });
    }
    const enriched = sortedConvs.map((c: any) => ({
      ...c,
      active_plan: c.active_plan_id
        ? planCache.get(c.active_plan_id.toString()) || null
        : null,
    }));

    return {
      conversations: enriched,
      nextCursor,
      hasSubagents: true,
    };
  },
});
