import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { pendingQueueRelinkBudget } from "./pending-queue-relink";
import { rehomeUndeliveredMessages } from "../pendingMessages";
import { handRoleTriggersToRunner } from "./agentTaskRows";

// A conversation changed runner (a cross-account move or a device claim):
// what waits on it follows, the messages not yet delivered and the role
// triggers that wake it, so the new runner's daemon serves both.
export async function followNewRunner(
  ctx: { db: any; scheduler?: MutationCtx["scheduler"] },
  conversationId: Id<"conversations">,
  runnerId: Id<"users">,
  budget = pendingQueueRelinkBudget(),
): Promise<void> {
  await rehomeUndeliveredMessages(ctx, conversationId, runnerId, budget);
  await handRoleTriggersToRunner(ctx, conversationId);
}
