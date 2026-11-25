import { ConvexError } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { verifyApiToken } from "../../apiTokens";

const LEASE_MS = 30_000;
const RUN_LEASE_VERSION = 1 as const;

type Lease = Pick<
  Doc<"execution_bindings">,
  | "daemon_boot_id"
  | "lease_boot_id"
  | "lease_expires_at"
  | "lease_released_at"
  | "fencing_token"
>;
type Address = { bearer: string; conversation_id: Id<"conversations"> };
type Fence = Address & { run: number; fencing_token: string };

function remainingLease(binding: Lease, now: number): number {
  if (
    binding.fencing_token === undefined ||
    binding.lease_released_at !== undefined ||
    binding.lease_boot_id !== binding.daemon_boot_id
  )
    return 0;
  return Math.max(0, (binding.lease_expires_at ?? now) - now);
}

export function assertActiveRunLease(
  binding: Lease,
  fencingToken: string | undefined,
  now: number,
): void {
  if (binding.fencing_token === undefined) return;
  if (
    binding.fencing_token !== fencingToken ||
    remainingLease(binding, now) === 0
  )
    throw new ConvexError({
      code: "STALE_RUN_LEASE",
      message: "The current run lease is required for delivery",
    });
}

async function ownedRun(ctx: MutationCtx, args: Address) {
  const auth = await verifyApiToken(ctx, args.bearer);
  if (!auth) return null;
  const [token, conversation] = await Promise.all([
    ctx.db.get(auth.tokenId),
    ctx.db.get(args.conversation_id),
  ]);
  if (
    !token?.device_id ||
    conversation?.user_id !== auth.userId ||
    conversation.execution_protocol_state !== "fenced"
  )
    return null;
  const head = await ctx.db
    .query("conversation_execution_heads")
    .withIndex("by_conversation", (q) =>
      q.eq("conversation_id", args.conversation_id),
    )
    .unique();
  if (
    head?.owner_user_id !== auth.userId ||
    head.protocol_state !== "fenced" ||
    head.current_epoch === undefined
  )
    return null;
  const run = head.current_epoch;
  const binding = await ctx.db
    .query("execution_bindings")
    .withIndex("by_conversation_epoch", (q) =>
      q.eq("conversation_id", args.conversation_id).eq("epoch", run),
    )
    .unique();
  if (
    binding?.state !== "ready" ||
    binding.owner_user_id !== auth.userId ||
    binding.owner_device_id !== token.device_id
  )
    return null;
  return { head, binding };
}

const stale = { v: RUN_LEASE_VERSION, status: "stale" } as const;

export async function claimRunLease(
  ctx: MutationCtx,
  args: Address & { machine: string; boot: string; claim_id: string },
) {
  const owned = await ownedRun(ctx, args);
  if (
    !owned ||
    owned.binding.owner_device_id !== args.machine ||
    owned.binding.daemon_boot_id !== args.boot ||
    args.claim_id.length === 0
  )
    return stale;

  const { binding, head } = owned;
  const now = Date.now();
  const leaseMs = remainingLease(binding, now);
  let fencingToken = binding.fencing_token;
  if (binding.claim_id === args.claim_id) {
    if (leaseMs === 0) return stale;
  } else {
    if (head.run_claim_ids?.includes(args.claim_id)) return stale;
    if (leaseMs > 0)
      return {
        v: RUN_LEASE_VERSION,
        status: "busy",
        retry_after_ms: leaseMs,
      } as const;
    fencingToken = crypto.randomUUID();
    await ctx.db.patch(binding._id, {
      claim_id: args.claim_id,
      fencing_token: fencingToken,
      lease_boot_id: args.boot,
      lease_expires_at: now + LEASE_MS,
      lease_released_at: undefined,
    });
    await ctx.db.patch(head._id, {
      run_claim_ids: [...(head.run_claim_ids ?? []), args.claim_id],
    });
  }
  if (fencingToken === undefined) return stale;
  return {
    v: RUN_LEASE_VERSION,
    status: "granted",
    session: String(binding.conversation_id),
    run: binding.epoch,
    fencing_token: fencingToken,
    lease_ms: binding.claim_id === args.claim_id ? leaseMs : LEASE_MS,
    last_pane_instance: head.last_pane_instance ?? 0,
  } as const;
}

async function currentClaim(ctx: MutationCtx, args: Fence, now: number) {
  const owned = await ownedRun(ctx, args);
  if (
    !owned ||
    owned.binding.epoch !== args.run ||
    owned.binding.fencing_token !== args.fencing_token ||
    remainingLease(owned.binding, now) === 0
  )
    return null;
  return owned.binding;
}

export async function renewRunLease(ctx: MutationCtx, args: Fence) {
  const now = Date.now();
  const binding = await currentClaim(ctx, args, now);
  if (!binding) return stale;
  await ctx.db.patch(binding._id, { lease_expires_at: now + LEASE_MS });
  return {
    v: RUN_LEASE_VERSION,
    status: "renewed",
    lease_ms: LEASE_MS,
  } as const;
}

export async function releaseRunLease(ctx: MutationCtx, args: Fence) {
  const now = Date.now();
  const binding = await currentClaim(ctx, args, now);
  if (!binding) return stale;
  await ctx.db.patch(binding._id, { lease_released_at: now });
  return { v: RUN_LEASE_VERSION, status: "released" } as const;
}
