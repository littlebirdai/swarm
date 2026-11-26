import type { PaginationOptions } from "convex/server";
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

export async function readOwnedPromptCards(
  ctx: QueryCtx,
  conversationId: Id<"conversations">,
  pagination: PaginationOptions,
) {
  const permissions =
    pagination.cursor === null
      ? await ctx.db
          .query("pending_permissions")
          .withIndex("by_conversation_status", (q) =>
            q.eq("conversation_id", conversationId).eq("status", "pending"),
          )
          .collect()
      : [];
  const questions = await ctx.db
    .query("messages")
    .withIndex("by_conversation_uuid", (q) =>
      q
        .eq("conversation_id", conversationId)
        .gte("message_uuid", "owned-prompt:")
        .lt("message_uuid", "owned-prompt;"),
    )
    .paginate({
      cursor: pagination.cursor,
      numItems: Math.min(pagination.numItems, 64),
    });
  const page = permissions.flatMap((row) =>
    row.fenced_prompt_id && row.fenced_prompt_turn_id
      ? [
          {
            kind: "permission" as const,
            id: row.fenced_prompt_id,
            turn: row.fenced_prompt_turn_id,
            rowId: row._id,
          },
        ]
      : [],
  );
  const openQuestions = await Promise.all(
    questions.page.map(async (row) => {
      if (row.role !== "assistant") return null;
      const call = row.tool_calls?.find(
        ({ name }) => name === "AskUserQuestion",
      );
      if (!call || !row.message_uuid) return null;
      let input: { fencedTurnId?: unknown } | null;
      try {
        input = JSON.parse(call.input);
      } catch {
        return null;
      }
      if (typeof input?.fencedTurnId !== "string") return null;
      const run = call.id.split(":", 1)[0];
      if (
        row.message_uuid !==
        `owned-prompt:${run}:${input.fencedTurnId}:${call.id}`
      )
        return null;
      const closed = await ctx.db
        .query("messages")
        .withIndex("by_conversation_uuid", (q) =>
          q
            .eq("conversation_id", conversationId)
            .eq("message_uuid", `${row.message_uuid}-closed`),
        )
        .first();
      return closed
        ? null
        : {
            kind: "question" as const,
            id: call.id,
            turn: input.fencedTurnId,
            messageUuid: row.message_uuid,
          };
    }),
  );
  return {
    page: [...page, ...openQuestions.filter((row) => row !== null)],
    isDone: questions.isDone,
    continueCursor: questions.continueCursor,
  };
}
