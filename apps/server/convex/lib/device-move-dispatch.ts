import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

type MoveDispatchContext = Partial<Pick<MutationCtx, "runMutation">>;

// A device move ("Run here" / "Move to <remote>"), from the store's
// moveSessionToDevice, which painted the sessionCommands row keyed by
// requestId. A remote destination is a move_to_device on the source daemon
// (it transfers the worktree, then resumes there); a local one re-homes the
// session and resumes it on that device, or brings it back from a cloud host
// as a real move (sessionMigrations.runHere). Both writers carry the request id.
export async function moveSessionToDevice(
  ctx: MoveDispatchContext,
  _userId: Id<"users">,
  [requestId, convId, toDeviceId, toRemote]: [string, string, string, boolean],
) {
  return toRemote
    ? await ctx.runMutation!(api.devices.moveToRemote, {
        conversation_id: convId,
        to_device_id: toDeviceId,
        request_id: requestId,
      })
    : await ctx.runMutation!(api.sessionMigrations.runHere, {
        conversation_id: convId,
        device_id: toDeviceId,
        request_id: requestId,
      });
}

export async function forceSessionMove(
  ctx: MoveDispatchContext,
  _userId: Id<"users">,
  [
    ,
    conversation_id,
    expected_source_epoch,
    destination_device_id,
    ,
    acknowledge_source_may_still_run,
  ]: [string, Id<"conversations">, number, string, string, true],
) {
  return ctx.runMutation!(api.edgeRunLease.forceMove, {
    conversation_id,
    expected_source_epoch,
    destination_device_id,
    acknowledge_source_may_still_run,
  });
}
