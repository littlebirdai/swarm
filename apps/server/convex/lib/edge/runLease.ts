import { TURN_PROJECTION_VERSION } from "@codecast/session-contract/turn-projection";
import type { CanonicalEvent } from "@codecast/edge-contract";
import {
  activateEventRun,
  appendRunEvents,
  clearEventTurn,
  type AppendResult,
} from "./runEvents";
import { ConvexError } from "convex/values";
import { verifyDeviceApiToken } from "@platform/auth/convex";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";

const LEASE_MS = 30_000;
const RECEIPT_MS = 7 * 24 * 60 * 60_000;
const MAX_CLAIM_LENGTH = 128;
const RUN_LEASE_VERSION = 1 as const;

type Binding = Pick<
  Doc<"execution_bindings">,
  "_id" | "claim_id" | "conversation_id" | "daemon_boot_id" | "epoch" | "state"
>;
type Address = { bearer: string; conversation_id: string };
type Fence = Address & { run: number; fencing_token: string };

export function loadRunLeaseClaim(
  ctx: Pick<MutationCtx, "db">,
  conversationId: Id<"conversations">,
  claimId: string,
) {
  return ctx.db
    .query("run_leases")
    .withIndex("by_conversation_claim", (q) =>
      q.eq("conversation_id", conversationId).eq("claim_id", claimId),
    )
    .unique();
}

function remainingLease(
  binding: Binding,
  lease: Doc<"run_leases"> | null,
  now: number,
) {
  if (
    !lease ||
    lease.binding_id !== binding._id ||
    lease.boot !== binding.daemon_boot_id ||
    lease.released_at !== undefined
  )
    return 0;
  return Math.max(0, lease.expires_at - now);
}

export function isFreshTurnProjection(
  binding: Binding,
  lease: Doc<"run_leases"> | null,
  projection: Doc<"run_turn_projections"> | null,
  now: number,
): boolean {
  return (
    binding.state === "ready" &&
    lease !== null &&
    lease.claim_id === binding.claim_id &&
    remainingLease(binding, lease, now) > 0 &&
    projection?.binding_id === binding._id &&
    projection.run === binding.epoch &&
    projection.projection_version === TURN_PROJECTION_VERSION &&
    projection.status === "active"
  );
}

export async function assertActiveRunLease(
  ctx: Pick<MutationCtx, "db">,
  binding: Binding | null,
  fencingToken: string | undefined,
  now: number,
): Promise<void> {
  const claimId = binding?.state === "ready" ? binding.claim_id : undefined;
  if (claimId === undefined && fencingToken === undefined) return;
  const lease =
    binding && claimId !== undefined
      ? await loadRunLeaseClaim(ctx, binding.conversation_id, claimId)
      : null;
  if (
    !binding ||
    fencingToken === undefined ||
    lease?.fencing_token !== fencingToken ||
    remainingLease(binding, lease, now) === 0
  )
    throw new ConvexError({
      code: "STALE_RUN_LEASE",
      message: "The current run lease is required for this operation",
    });
}

export async function runForDeliverySettlement(
  ctx: Pick<QueryCtx, "db">,
  args: Address,
) {
  const auth = await verifyDeviceApiToken(ctx, args.bearer);
  if (!auth) return null;
  const conversationId = ctx.db.normalizeId(
    "conversations",
    args.conversation_id,
  );
  if (!conversationId) return null;
  const conversation = await ctx.db.get(conversationId);
  if (
    conversation?.user_id !== auth.userId ||
    conversation.execution_protocol_state !== "fenced" ||
    !conversation.owner_device_id
  )
    return null;
  const head = await ctx.db
    .query("conversation_execution_heads")
    .withIndex("by_conversation", (q) =>
      q.eq("conversation_id", conversationId),
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
      q.eq("conversation_id", conversationId).eq("epoch", run),
    )
    .unique();
  if (
    binding?.state !== "ready" ||
    binding.owner_user_id !== auth.userId ||
    binding.owner_device_id !== auth.deviceId
  )
    return null;
  return { head, binding, conversationDeviceId: conversation.owner_device_id };
}

export async function ownedRun(ctx: Pick<QueryCtx, "db">, args: Address) {
  const owned = await runForDeliverySettlement(ctx, args);
  return owned &&
    !owned.head.device_move &&
    owned.conversationDeviceId === owned.binding.owner_device_id
    ? owned
    : null;
}

const stale = { v: RUN_LEASE_VERSION, status: "stale" } as const;

export async function claimRunLease(
  ctx: MutationCtx,
  args: Address & { machine: string; boot: string; claim_id: string },
) {
  if (!args.claim_id.trim() || args.claim_id.length > MAX_CLAIM_LENGTH)
    return stale;
  const owned = await ownedRun(ctx, args);
  if (
    !owned ||
    owned.binding.owner_device_id !== args.machine ||
    owned.binding.daemon_boot_id !== args.boot
  )
    return stale;

  const { binding, head } = owned;
  const now = Date.now();
  const requested = await loadRunLeaseClaim(
    ctx,
    binding.conversation_id,
    args.claim_id,
  );
  let leaseMs = LEASE_MS;
  let fencingToken: string;
  if (binding.claim_id === args.claim_id) {
    if (!requested) return stale;
    leaseMs = remainingLease(binding, requested, now);
    if (leaseMs === 0) return stale;
    fencingToken = requested.fencing_token;
  } else {
    if (requested) return stale;
    if (binding.claim_id !== undefined) {
      const active = await loadRunLeaseClaim(
        ctx,
        binding.conversation_id,
        binding.claim_id,
      );
      const retryAfter = remainingLease(binding, active, now);
      if (retryAfter > 0)
        return {
          v: RUN_LEASE_VERSION,
          status: "busy",
          retry_after_ms: retryAfter,
        } as const;
    }
    fencingToken = crypto.randomUUID();
    await ctx.db.insert("run_leases", {
      conversation_id: binding.conversation_id,
      owner_user_id: binding.owner_user_id,
      binding_id: binding._id,
      claim_id: args.claim_id,
      boot: args.boot,
      fencing_token: fencingToken,
      expires_at: now + LEASE_MS,
      retain_until: now + LEASE_MS + RECEIPT_MS,
    });
    if (binding.claim_id !== undefined) await clearEventTurn(ctx, binding, now);
    await ctx.db.patch(binding._id, { claim_id: args.claim_id });
  }
  return {
    v: RUN_LEASE_VERSION,
    status: "granted",
    session: String(binding.conversation_id),
    run: binding.epoch,
    fencing_token: fencingToken,
    lease_ms: leaseMs,
    last_pane_instance: head.last_pane_instance ?? 0,
    last_event_seq: await activateEventRun(ctx, binding, now),
  } as const;
}

async function currentClaim(
  ctx: MutationCtx,
  args: Fence,
  now: number,
  loadRun = ownedRun,
) {
  const owned = await loadRun(ctx, args);
  if (
    !owned ||
    owned.binding.epoch !== args.run ||
    owned.binding.claim_id === undefined
  )
    return null;
  const lease = await loadRunLeaseClaim(
    ctx,
    owned.binding.conversation_id,
    owned.binding.claim_id,
  );
  return lease?.fencing_token === args.fencing_token &&
    remainingLease(owned.binding, lease, now) > 0
    ? { binding: owned.binding, lease }
    : null;
}

export async function renewRunLease(ctx: MutationCtx, args: Fence) {
  const now = Date.now();
  const current = await currentClaim(ctx, args, now);
  if (!current) return stale;
  const { lease } = current;
  const expiresAt = now + LEASE_MS;
  await ctx.db.patch(lease._id, {
    expires_at: expiresAt,
    retain_until: expiresAt + RECEIPT_MS,
  });
  return {
    v: RUN_LEASE_VERSION,
    status: "renewed",
    lease_ms: LEASE_MS,
  } as const;
}

export async function releaseRunLease(ctx: MutationCtx, args: Fence) {
  const now = Date.now();
  const current = await currentClaim(ctx, args, now, runForDeliverySettlement);
  if (!current) return stale;
  const { binding, lease } = current;
  await ctx.db.patch(lease._id, { released_at: now });
  await clearEventTurn(ctx, binding, now);
  return { v: RUN_LEASE_VERSION, status: "released" } as const;
}

export async function appendClaimedEvents(
  ctx: MutationCtx,
  args: Fence & { events_json: string },
): Promise<AppendResult> {
  const now = Date.now();
  const current = await currentClaim(ctx, args, now);
  if (!current) return { session: args.conversation_id, status: "stale" };
  const events = JSON.parse(args.events_json) as readonly CanonicalEvent[];
  return appendRunEvents(ctx, current.binding, events, now);
}
