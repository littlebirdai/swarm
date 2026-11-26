import { ConvexError } from "convex/values";
import { internal } from "../../_generated/api";
import type { Doc } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { forcedDeviceMoveEnabled } from "./device-move.state";
import {
  activateRecordedDeviceMove,
  assertSourceEnded,
  destinationBinding,
  loadRecordedDeviceMove,
  prepareRecordedDeviceMove,
  registeredBoot,
  retargetRecordedDeviceMove,
  type RecordedMoveAddress,
} from "./device-move-transition.state";

const MAX_ATTEMPTS = 10;
const MAX_BACKOFF_MS = 30_000;

type Move = NonNullable<Doc<"conversation_execution_heads">["device_move"]>;
type Driver = NonNullable<Move["driver"]>;
type Ticket = RecordedMoveAddress & { revision: number };
type StepResult =
  | { kind: "prepared" }
  | { kind: "retargeted"; moved: number; done: boolean }
  | { kind: "restored"; done: boolean }
  | { kind: "activated" };

async function driverHead(ctx: MutationCtx, args: RecordedMoveAddress) {
  const head = await ctx.db
    .query("conversation_execution_heads")
    .withIndex("by_conversation", (q) =>
      q.eq("conversation_id", args.conversation_id),
    )
    .unique();
  const move = head?.device_move;
  if (
    !head ||
    !move ||
    move.move_id !== args.move_id ||
    (move.phase === "aborting" && !move.replacement) ||
    head.protocol_state !== "fenced" ||
    head.current_epoch !== move.source_epoch
  )
    return null;
  return { head, move };
}

export async function startDeviceMoveDriver(
  ctx: MutationCtx,
  args: RecordedMoveAddress,
  ownerRequested = false,
): Promise<void> {
  const state = await driverHead(ctx, args);
  if (!state) return;
  const prior = state.move.driver;
  if (
    prior &&
    !(ownerRequested && state.move.forced && prior.step === "failed")
  )
    return;
  const { head, move } = state;
  if (
    move.forced
      ? !forcedDeviceMoveEnabled()
      : move.source_stopped_at === undefined && !move.source_replacement_boot_id
  )
    return;
  const driver: Driver = {
    ...prior,
    revision: prior ? prior.revision + 1 : 0,
    step: move.replacement
      ? "restore"
      : prior?.retargeted_at !== undefined
        ? "activate"
        : prior?.prepared_at !== undefined
          ? "retarget"
          : "prepare",
    retries: 0,
    moved: prior?.moved ?? 0,
    last_error: undefined,
    owner_retried: prior ? true : undefined,
  };
  await ctx.db.patch(head._id, {
    device_move: { ...move, driver },
    last_device_move: undefined,
  });
  await ctx.scheduler.runAfter(0, internal.edgeRunLease.driveMove, {
    conversation_id: args.conversation_id,
    move_id: args.move_id,
    revision: driver.revision,
  });
}

export async function runDeviceMoveStep(
  ctx: MutationCtx,
  args: Ticket,
): Promise<StepResult> {
  const state = await loadRecordedDeviceMove(ctx, args);
  const { move } = state;
  const driver = move.driver;
  if (
    !driver ||
    driver.revision !== args.revision ||
    (move.phase === "aborting" && !move.replacement)
  )
    throw new ConvexError("The device move changed");
  await assertSourceEnded(ctx, state);
  const now = Date.now();
  switch (driver.step) {
    case "prepare": {
      const boot = await registeredBoot(
        ctx,
        move.destination_runner_id,
        move.destination_device_id,
      );
      if (!boot)
        throw new ConvexError("Waiting for the destination daemon to connect");
      await prepareRecordedDeviceMove(ctx, state, boot.daemon_boot_id, now);
      return { kind: "prepared" };
    }
    case "restore": {
      if (!move.replacement)
        throw new ConvexError("The device move replacement changed");
      const { done } = await retargetRecordedDeviceMove(ctx, state, now);
      return { kind: "restored", done };
    }
    case "retarget": {
      const page = await retargetRecordedDeviceMove(ctx, state, now);
      return { kind: "retargeted", ...page };
    }
    case "activate": {
      const binding = await destinationBinding(ctx, state);
      if (
        binding.state !== "ready" ||
        !binding.runtime_id ||
        !binding.operation_id
      )
        throw new ConvexError(
          "Waiting for the destination runtime to be ready",
        );
      await activateRecordedDeviceMove(
        ctx,
        state,
        {
          daemon_boot_id: binding.daemon_boot_id,
          runtime_id: binding.runtime_id,
          operation_id: binding.operation_id,
        },
        now,
      );
      return { kind: "activated" };
    }
    case "failed":
      throw new ConvexError("The device move has failed");
  }
}

export async function driveDeviceMove(
  ctx: MutationCtx,
  args: Ticket,
): Promise<void> {
  const state = await driverHead(ctx, args);
  const driver = state?.move.driver;
  if (
    !state ||
    !driver ||
    driver.revision !== args.revision ||
    driver.step === "failed"
  )
    return;
  const now = Date.now();
  const next: Driver = { ...driver, revision: driver.revision + 1 };
  let delay = 0;
  try {
    const outcome: StepResult = await ctx.runMutation(
      internal.edgeRunLease.runMoveStep,
      args,
    );
    if (outcome.kind === "activated") return;
    next.retries = 0;
    next.last_error = undefined;
    if (outcome.kind === "prepared") {
      next.step = "retarget";
      next.prepared_at = now;
    } else if (outcome.kind === "restored") {
      if (outcome.done) next.step = "prepare";
    } else {
      next.moved += outcome.moved;
      if (outcome.done) {
        next.step = "activate";
        next.retargeted_at = now;
      }
    }
  } catch (error) {
    next.retries += 1;
    next.last_error =
      error instanceof ConvexError && typeof error.data === "string"
        ? error.data
        : "The server could not advance the device move";
    if (
      next.retries >= MAX_ATTEMPTS ||
      (state.move.forced && !forcedDeviceMoveEnabled())
    )
      next.step = "failed";
    delay = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** (next.retries - 1));
  }
  const head = await ctx.db.get(state.head._id);
  if (!head?.device_move || head.device_move.move_id !== args.move_id) return;
  await ctx.db.patch(head._id, {
    device_move: { ...head.device_move, driver: next },
    updated_at: now,
  });
  if (next.step !== "failed")
    await ctx.scheduler.runAfter(delay, internal.edgeRunLease.driveMove, {
      ...args,
      revision: next.revision,
    });
}
