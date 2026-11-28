import { query } from "./functions";
import { v } from "convex/values";
import { canOwnerOrTeamAccess } from "./privacy";
import {
  getAuthenticatedUserIdReadOnly,
  resolveConversationRef,
} from "./lib/conversationHelpers";

type TreeNode = {
  id: string;
  short_id?: string;
  title: string;
  message_count: number;
  parent_message_uuid?: string;
  started_at: number;
  status: string;
  agent_type?: string;
  is_current: boolean;
  // The prompt that started THIS branch: the first user message after the
  // fork point. Sibling forks share a title, so this is what actually
  // tells them apart in the branch map.
  branch_label?: string;
  // Messages on this branch after the fork point (the branch's own work,
  // excluding history inherited from the parent).
  branch_message_count?: number;
  children: TreeNode[];
};

export const getConversationTree = query({
  args: {
    conversation_id: v.string(),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserIdReadOnly(ctx, args.api_token);
    if (!userId) {
      return { error: "Unauthorized" };
    }

    const conv = await resolveConversationRef(
      ctx,
      args.conversation_id,
      userId,
    );
    if (!conv) {
      return { error: "Conversation not found" };
    }

    if (!(await canOwnerOrTeamAccess(ctx, userId, conv))) {
      return { error: "Access denied" };
    }

    // Walk up to find root. Every node of the tree is judged on its own, the
    // way the requested one was (and getAccessibleForkChildren judges forks):
    // a fork can be private where its origin is shared, and the other way
    // round. The walk stops below the first ancestor the caller cannot open,
    // and buildTree leaves out any branch they cannot open.
    let root = conv;
    const visited = new Set<string>([root._id.toString()]);
    while (root.forked_from) {
      const parent = await ctx.db.get(root.forked_from);
      if (!parent || visited.has(parent._id.toString())) break;
      if (!(await canOwnerOrTeamAccess(ctx, userId, parent))) break;
      visited.add(parent._id.toString());
      root = parent;
    }

    // Recursively build tree from root
    // First real user prompt out of a small message window, tags/whitespace
    // stripped. Slash-command wrappers (<command-message>…) reduce to their
    // inner text, which still reads usefully ("commit and deploy…").
    const firstUserPrompt = (
      msgs: Array<{ role: string; content?: unknown }>,
    ): string | undefined => {
      const clean = (s: string) =>
        s
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
      for (const m of msgs) {
        if (m.role === "user" && typeof m.content === "string") {
          const c = clean(m.content);
          if (c) return c.slice(0, 140);
        }
      }
      for (const m of msgs) {
        if (typeof m.content === "string") {
          const c = clean(m.content);
          if (c) return c.slice(0, 140);
        }
      }
      return undefined;
    };

    // Per-branch summary. For a fork we locate the fork point by its uuid (one
    // indexed lookup), then range-scan ONLY the divergent messages after it —
    // never the history copied down from the parent. For the root (no fork
    // point) we summarize from the top. Bounded by .take so a huge branch costs
    // a constant ~30 reads.
    const summarizeBranch = async (
      node: typeof root,
    ): Promise<{ label?: string; count?: number }> => {
      const hasForkPoint =
        !!node.parent_message_uuid &&
        node.parent_message_uuid !== "agent-switch";
      if (hasForkPoint) {
        const forkPoint = await ctx.db
          .query("messages")
          .withIndex("by_conversation_uuid", (q) =>
            q
              .eq("conversation_id", node._id)
              .eq("message_uuid", node.parent_message_uuid!),
          )
          .first();
        if (forkPoint) {
          const ts = forkPoint.timestamp;
          const head = await ctx.db
            .query("messages")
            .withIndex("by_conversation_timestamp", (q) =>
              q.eq("conversation_id", node._id).gt("timestamp", ts),
            )
            .order("asc")
            .take(30);
          // The count is message_count minus the inherited history. fork_copied
          // is the count copied down; fall back to the raw count for legacy
          // forks that predate the cursor.
          const count =
            typeof node.fork_copied === "number"
              ? Math.max(0, node.message_count - node.fork_copied)
              : node.message_count;
          return { label: firstUserPrompt(head), count };
        }
      }
      const head = await ctx.db
        .query("messages")
        .withIndex("by_conversation_timestamp", (q) =>
          q.eq("conversation_id", node._id),
        )
        .order("asc")
        .take(30);
      return { label: firstUserPrompt(head), count: node.message_count };
    };

    const buildTree = async (node: typeof root): Promise<TreeNode> => {
      const forks = await ctx.db
        .query("conversations")
        .withIndex("by_forked_from", (q) => q.eq("forked_from", node._id))
        .collect();
      const children: typeof forks = [];
      for (const fork of forks) {
        if (await canOwnerOrTeamAccess(ctx, userId, fork)) children.push(fork);
      }

      const [summary, childTrees] = await Promise.all([
        summarizeBranch(node),
        Promise.all(children.map((c) => buildTree(c))),
      ]);

      return {
        id: node._id.toString(),
        short_id: node.short_id,
        title: node.title || "New Session",
        message_count: node.message_count,
        parent_message_uuid: node.parent_message_uuid,
        started_at: node.started_at,
        status: node.status,
        agent_type: node.agent_type,
        is_current: node._id.toString() === conv!._id.toString(),
        branch_label: summary.label,
        branch_message_count: summary.count,
        children: childTrees,
      };
    };

    const tree = await buildTree(root);
    return { tree };
  },
});

export const getForkBranchMessages = query({
  args: {
    conversation_id: v.string(),
    api_token: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserIdReadOnly(ctx, args.api_token);
    if (!userId) {
      return { error: "Unauthorized" };
    }

    const conv = await resolveConversationRef(
      ctx,
      args.conversation_id,
      userId,
    );
    if (!conv) {
      return { error: "Conversation not found" };
    }

    if (!(await canOwnerOrTeamAccess(ctx, userId, conv))) {
      return { error: "Access denied" };
    }

    const allMessages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q) =>
        q.eq("conversation_id", conv!._id),
      )
      .order("asc")
      .collect();

    if (!conv.parent_message_uuid) {
      return { messages: allMessages, fork_point_uuid: null };
    }

    const forkPointIdx = allMessages.findIndex(
      (m) => m.message_uuid === conv!.parent_message_uuid,
    );

    if (forkPointIdx === -1) {
      return {
        messages: allMessages,
        fork_point_uuid: conv.parent_message_uuid,
      };
    }

    const divergentMessages = allMessages.slice(forkPointIdx + 1);
    return {
      messages: divergentMessages,
      fork_point_uuid: conv.parent_message_uuid,
    };
  },
});
