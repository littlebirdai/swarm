import { STEER_BATON_CAPABILITY } from "@codecast/edge-contract";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { executionBinding, executionHead } from "./execution-binding.state";

export async function requestOwnedCodexResume(
  ctx: Pick<MutationCtx, "db">,
  conversation: Pick<Doc<"conversations">, "_id" | "execution_protocol_state">,
): Promise<boolean> {
  if (conversation.execution_protocol_state !== "fenced") return false;
  const head = await executionHead(ctx, conversation._id);
  const run = head?.current_epoch;
  if (run === undefined) return false;
  const binding = await executionBinding(ctx, conversation._id, run);
  if (!binding?.required_capabilities.includes(STEER_BATON_CAPABILITY))
    return false;
  if (!head.device_move && !head.pending_epoch && binding.state === "ready") {
    await ctx.db.patch(head._id, {
      resume_generation: (head.resume_generation ?? 0) + 1,
    });
  }
  return true;
}
