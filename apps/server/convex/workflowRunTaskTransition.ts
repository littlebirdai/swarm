import { v } from "convex/values";
import { mutation } from "./functions";
import { verifyApiToken } from "./apiTokens";
import { canAccessTask } from "./lib/access";
import { moveTaskStatus } from "./tasks";

export const transitionTaskFromCli = mutation({
  args: {
    api_token: v.string(),
    run_id: v.id("workflow_runs"),
    short_id: v.optional(v.string()),
    status: v.union(
      v.literal("open"),
      v.literal("in_progress"),
      v.literal("in_review"),
      v.literal("done"),
      v.literal("dropped"),
    ),
    execution_status: v.optional(
      v.union(
        v.literal("blocked"),
        v.literal("needs_context"),
        v.literal("done"),
        v.literal("done_with_concerns"),
      ),
    ),
    execution_concerns: v.optional(v.string()),
    verification_evidence: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");
    const run = await ctx.db.get(args.run_id);
    if (!run || String(run.user_id) !== String(auth.userId) || !run.task_id) {
      throw new Error("Workflow run task not found");
    }
    const task = await ctx.db.get(run.task_id);
    if (!task || !(await canAccessTask(ctx, auth.userId, task))) {
      throw new Error("Task not found");
    }
    if (args.short_id && task.short_id !== args.short_id) {
      throw new Error("Task does not match workflow run");
    }
    const extra: Record<string, any> = {};
    if (args.execution_status !== undefined) {
      extra.execution_status = args.execution_status;
    }
    if (args.execution_concerns !== undefined) {
      extra.execution_concerns = args.execution_concerns;
    }
    if (args.verification_evidence !== undefined) {
      extra.verification_evidence = args.verification_evidence;
    }
    await moveTaskStatus(ctx, task, args.status, {
      actorUserId: auth.userId,
      actorType: "system",
      now: Date.now(),
      ...(Object.keys(extra).length ? { extra } : {}),
    });
    return { success: true, status: args.status };
  },
});
