import { ConvexError } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { checkConversationAccess } from "../privacy";

const CLAIM_ACCOUNT_PAGE = 100;
const CLAIM_ACCOUNT_PAGE_BYTES = 512 * 1024;
const CLAIM_CHECKPOINT_TTL_MS = 15 * 60 * 1000;
const CLAIM_CHECKPOINT_DELETE_BATCH = 16;
const FENCED_MOVE_REFUSAL =
  "This session uses fenced execution and cannot move to another device or account.";

type DeviceClaimScan = {
  cursor: string | null;
  skipped: number;
  fenced: boolean;
  previousSeen?: number;
};

export function fencedMoveRefusal(
  conversation: { execution_protocol_state?: string },
  mode: "return" | "throw" = "return",
): string | undefined {
  if (conversation.execution_protocol_state === undefined) return;
  if (mode === "throw") throw new ConvexError(FENCED_MOVE_REFUSAL);
  return FENCED_MOVE_REFUSAL;
}

function claimCheckpointPrefix(device: Id<"devices">) {
  return `device_claim_scan:${device}:`;
}

function claimCheckpoint(
  ctx: Pick<MutationCtx, "db">,
  device: Id<"devices">,
  previousUser: Id<"users">,
) {
  return ctx.db
    .query("system_config")
    .withIndex("by_key", (q) =>
      q.eq("key", claimCheckpointPrefix(device) + previousUser),
    )
    .unique();
}

export async function clearClaimCheckpoint(
  ctx: Pick<MutationCtx, "db">,
  device: Id<"devices">,
  previousUser: Id<"users">,
) {
  const checkpoint = await claimCheckpoint(ctx, device, previousUser);
  if (checkpoint) await ctx.db.delete(checkpoint._id);
}

export async function clearDeviceClaimCheckpoints(
  ctx: Pick<MutationCtx, "db" | "scheduler">,
  device: Id<"devices">,
): Promise<void> {
  const prefix = claimCheckpointPrefix(device);
  const checkpoints = await ctx.db
    .query("system_config")
    .withIndex("by_key", (q) =>
      q.gte("key", prefix).lt("key", prefix + "\uffff"),
    )
    .take(CLAIM_CHECKPOINT_DELETE_BATCH);
  for (const checkpoint of checkpoints) await ctx.db.delete(checkpoint._id);
  if (checkpoints.length === CLAIM_CHECKPOINT_DELETE_BATCH)
    await ctx.scheduler.runAfter(0, internal.devices.purgeClaimCheckpoints, {
      device,
    });
}

export async function scanDeviceRows(
  ctx: Pick<MutationCtx, "db">,
  callerId: Id<"users">,
  destination: { _id: Id<"devices">; device_id: string },
  previous: { userId: Id<"users">; lastSeen?: number },
  now: number,
) {
  const checkpoint = await claimCheckpoint(
    ctx,
    destination._id,
    previous.userId,
  );
  const saved: DeviceClaimScan | undefined =
    checkpoint && now - checkpoint.updated_at < CLAIM_CHECKPOINT_TTL_MS
      ? JSON.parse(checkpoint.value)
      : undefined;
  const scan =
    saved && saved.previousSeen === previous.lastSeen
      ? saved
      : {
          cursor: null,
          skipped: 0,
          fenced: false,
          previousSeen: previous.lastSeen,
        };
  const { page, isDone, continueCursor } = await ctx.db
    .query("conversations")
    .withIndex("by_owner_device", (q) =>
      q
        .eq("user_id", previous.userId)
        .eq("owner_device_id", destination.device_id),
    )
    .paginate({
      cursor: scan.cursor,
      numItems: CLAIM_ACCOUNT_PAGE,
      maximumBytesRead: CLAIM_ACCOUNT_PAGE_BYTES,
    });
  const caller = await ctx.db.get(callerId);
  const rows = [];
  for (const conversation of page) {
    if (fencedMoveRefusal(conversation)) {
      scan.fenced = true;
    } else {
      const access = await checkConversationAccess(ctx, callerId, conversation);
      if (
        access === "owner" ||
        (access === "team" && caller && !caller.is_bot)
      ) {
        rows.push(conversation);
        continue;
      }
    }
    scan.skipped++;
  }
  if (isDone) {
    if (checkpoint) await ctx.db.delete(checkpoint._id);
  } else {
    scan.cursor = continueCursor;
    const row = { value: JSON.stringify(scan), updated_at: now };
    if (checkpoint) await ctx.db.patch(checkpoint._id, row);
    else
      await ctx.db.insert("system_config", {
        key: claimCheckpointPrefix(destination._id) + previous.userId,
        ...row,
      });
  }
  return {
    rows,
    more: !isDone,
    skipped: scan.skipped,
    refusal: isDone && scan.fenced ? FENCED_MOVE_REFUSAL : undefined,
  };
}
