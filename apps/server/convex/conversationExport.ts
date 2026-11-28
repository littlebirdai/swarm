import { query, internalQuery } from "./functions";
import { v } from "convex/values";
import { approxMessageBytes } from "./userMessagesFilter";
import {
  READ_PAGE_SIZE,
  READ_STEP_BYTES,
  messageHasFindTerms,
  type ScanCursor,
} from "./lib/conversationRead";
import { parseSearchTerms as parseFindTerms } from "@codecast/search";
import { formatSlugAsTitle, isNonEmptyMessage } from "./lib/conversationBasics";
import {
  conversationHoldingMessage,
  foldChangesPayload,
  readableConversation,
  readableConversationAs,
  sameShortIdPayload,
  streamMessageRows,
} from "./lib/conversationExportHelpers";

export {
  readableConversation,
  readableConversationAs,
  streamMessageRows,
} from "./lib/conversationExportHelpers";

// Reactive tail of a conversation's recent messages, for `cast sessions -w
// --messages` via ConvexClient.onUpdate (live push, no polling). Bounded take on
// by_conversation_timestamp so a new message re-runs cheaply and pushes the
// updated tail; the CLI dedupes by message_uuid. api_token authed; resolves a
// short or full conversation id; same access check as every CLI read (readableConversation).
export const conversationMessagesForCLI = query({
  args: {
    api_token: v.string(),
    conversation_id: v.string(),
    limit: v.optional(v.number()),
    full_content: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const access = await readableConversation(
      ctx,
      args.api_token,
      args.conversation_id,
    );
    if ("error" in access) return { error: access.error };
    const { conv } = access;

    const limit = Math.min(Math.max(args.limit ?? 30, 1), 100);
    const recent = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q: any) =>
        q.eq("conversation_id", conv._id),
      )
      .order("desc")
      .take(limit * 2 + 20);
    const tail = recent.filter(isNonEmptyMessage).slice(0, limit).reverse();
    const inputCap = args.full_content ? 100000 : 500;
    const resultCap = args.full_content ? 100000 : 1000;

    return {
      conversation: {
        id: conv._id,
        title: conv.title || "New Session",
        message_count: conv.message_count || 0,
      },
      messages: tail.map((m: any) => ({
        role: m.role,
        content: m.content || "",
        timestamp: new Date(m.timestamp).toISOString(),
        message_uuid: m.message_uuid || undefined,
        tool_calls: m.tool_calls?.map((tc: any) => ({
          id: tc.id,
          name: tc.name,
          input: (tc.input || "").slice(0, inputCap),
        })),
        tool_results: m.tool_results?.map((tr: any) => ({
          tool_use_id: tr.tool_use_id,
          content: (tr.content || "").slice(0, resultCap),
          is_error: tr.is_error,
        })),
      })),
    };
  },
});

/**
 * One scan step of a read: the ids of the non-empty messages after `after`,
 * oldest first, or newest first for a tail read. `cursor` is absent once the
 * last row is read.
 */
export const scanConversationLines = internalQuery({
  args: {
    api_token: v.string(),
    conversation_id: v.string(),
    // Resume point: rows with this creation time, of which `skip` were already
    // scanned. Two rows can share a creation time, so the time alone is not enough.
    after: v.optional(
      v.object({ creation_time: v.number(), skip: v.number() }),
    ),
    newest_first: v.optional(v.boolean()),
    // Anchor on a message (its Convex _id, as in the web's `#msg-<id>` links).
    around_message_id: v.optional(v.string()),
    // Also return the conversation's materialized file changes (Edit/Write
    // calls plus disk-observed Bash changes); `cast diff` folds them into its tree.
    include_file_changes: v.optional(v.boolean()),
    // Also return which of `ids` hold this text (messageHasFindTerms).
    grep: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await readableConversation(
      ctx,
      args.api_token,
      args.conversation_id,
    );
    if ("error" in access) return { error: access.error };
    const after = args.after;
    // A short id with a message anchor (`cast read jx78gqj#<message>`, what
    // `cast search` prints) means the conversation holding that message, even
    // when a newer one shares the short id.
    const conv =
      !after && args.around_message_id
        ? await conversationHoldingMessage(
            ctx,
            access.user._id,
            args.conversation_id,
            args.around_message_id,
            access.conv,
          )
        : access.conv;
    const findTerms =
      args.grep !== undefined ? parseFindTerms(args.grep) : undefined;

    const ids: string[] = [];
    const matches: number[] = [];
    let anchorIndex: number | undefined;
    let firstUserMessage = "";
    let scanned = 0;
    const cursor = await streamMessageRows(
      ctx,
      conv._id,
      after,
      args.newest_first ? "desc" : "asc",
      (m) => {
        if (m._id === args.around_message_id) anchorIndex = ids.length;
        if (isNonEmptyMessage(m)) {
          if (findTerms?.length && messageHasFindTerms(m, findTerms))
            matches.push(ids.length);
          ids.push(m._id);
        }
        // The title falls back to the first user prompt among the first rows.
        if (
          !after &&
          !args.newest_first &&
          !firstUserMessage &&
          scanned < 10 &&
          m.role === "user" &&
          !m.tool_results?.length
        ) {
          const text = m.content?.trim();
          if (text)
            firstUserMessage =
              text.length > 120 ? `${text.slice(0, 120)}...` : text;
        }
        scanned++;
      },
    );

    return {
      ids,
      ...(findTerms ? { matches } : {}),
      anchor_index: anchorIndex,
      cursor,
      ...(after
        ? {}
        : {
            conversation: {
              id: conv._id,
              title:
                conv.title ||
                firstUserMessage ||
                (conv.slug ? formatSlugAsTitle(conv.slug) : null) ||
                "New Session",
              agent_type: conv.agent_type || "claude_code",
              project_path: conv.project_path || null,
              message_count: conv.message_count || 0,
              updated_at: new Date(conv.updated_at).toISOString(),
              ...(await sameShortIdPayload(
                ctx,
                access.user._id,
                args.conversation_id,
                conv,
              )),
            },
          }),
      ...(args.include_file_changes
        ? await foldChangesPayload(ctx, conv._id)
        : {}),
    };
  },
});

/**
 * One fetch step of a read: the messages behind `ids`, numbered from
 * `first_line`, until READ_PAGE_SIZE rows or READ_STEP_BYTES are read.
 * `consumed` says how many ids it covered, so the caller asks for the rest.
 */
export const readConversationLines = internalQuery({
  args: {
    api_token: v.string(),
    conversation_id: v.string(),
    ids: v.array(v.string()),
    first_line: v.number(),
    // Each id's own line, for ids that are not consecutive lines (a --grep read).
    lines: v.optional(v.array(v.number())),
    full_content: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const access = await readableConversation(
      ctx,
      args.api_token,
      args.conversation_id,
    );
    if ("error" in access) return { error: access.error };
    const { conv } = access;
    const fullContent = args.full_content === true;
    const cap = (text: string | undefined, max: number) =>
      fullContent || !text || text.length <= max
        ? text
        : `${text.slice(0, max)}...`;

    const messages = [];
    let consumed = 0;
    let bytes = 0;
    for (const raw of args.ids.slice(0, READ_PAGE_SIZE)) {
      if (consumed > 0 && bytes >= READ_STEP_BYTES) break;
      const line = args.lines?.[consumed] ?? args.first_line + consumed;
      consumed++;
      const id = ctx.db.normalizeId("messages", raw);
      const m = id ? await ctx.db.get(id) : null;
      // A row deleted since the scan keeps its line number but shows nothing.
      if (!m || m.conversation_id !== conv._id) continue;
      bytes += approxMessageBytes(m as any);
      messages.push({
        // The message's Convex _id — the anchor the web's `#msg-<id>` deep links
        // use, so `cast link` can mint a resolvable permalink to a line that
        // `cast read` just showed.
        id: m._id,
        line,
        role: m.role,
        content: m.content || "",
        timestamp: new Date(m.timestamp).toISOString(),
        message_uuid: m.message_uuid || undefined,
        tool_calls: m.tool_calls?.map((tc) => ({
          id: tc.id,
          name: tc.name,
          input: cap(tc.input, 500),
        })),
        tool_results: m.tool_results?.map((tr) => ({
          tool_use_id: tr.tool_use_id,
          content: cap(tr.content, 1000),
          is_error: tr.is_error,
        })),
      });
    }
    return { messages, consumed };
  },
});

export const exportConversationMessagesPage = query({
  args: {
    api_token: v.string(),
    conversation_id: v.string(),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const access = await readableConversation(
      ctx,
      args.api_token,
      args.conversation_id,
    );
    if ("error" in access) return { error: access.error };
    const { conv } = access;

    // The cursor is a JSON resume point from streamMessageRows. Pages stop at
    // READ_STEP_BYTES as well as at `limit`, because one page of image rows
    // can otherwise exceed the 64 MB heap.
    let after: ScanCursor | undefined;
    if (args.cursor) {
      try {
        const parsed = JSON.parse(args.cursor);
        if (
          typeof parsed?.creation_time !== "number" ||
          typeof parsed?.skip !== "number"
        )
          throw new Error();
        after = { creation_time: parsed.creation_time, skip: parsed.skip };
      } catch {
        return { error: "Invalid cursor" };
      }
    }
    const pageSize = Math.max(1, Math.min(args.limit ?? 500, 1000));
    const messages: any[] = [];
    let read = 0;
    const next = await streamMessageRows(ctx, conv._id, after, "asc", (m) => {
      read++;
      if (isNonEmptyMessage(m)) {
        messages.push({
          role: m.role,
          content: m.content || "",
          thinking: m.thinking || undefined,
          timestamp: new Date(m.timestamp).toISOString(),
          message_uuid: m.message_uuid || undefined,
          tool_calls: m.tool_calls,
          tool_results: m.tool_results,
          subtype: m.subtype || undefined,
        });
      }
      return read >= pageSize;
    });

    return {
      conversation: {
        id: conv._id,
        title: conv.title || "New Session",
        session_id: conv.session_id,
        agent_type: conv.agent_type,
        project_path: conv.project_path || null,
        git_root: conv.git_root || null,
        git_remote_url: conv.git_remote_url || null,
        model: conv.model || null,
        message_count: conv.message_count || 0,
        started_at: new Date(conv.started_at).toISOString(),
        updated_at: new Date(conv.updated_at).toISOString(),
      },
      messages,
      next_cursor: next ? JSON.stringify(next) : null,
      done: !next,
    };
  },
});
