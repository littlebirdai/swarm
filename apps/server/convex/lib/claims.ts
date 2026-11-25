import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

export type ClaimResource =
  | { kind: "steer"; id: Id<"conversations"> }
  | { kind: "terminal"; id: string };

type SteerAuthorization =
  | { mode: "lone" }
  | { mode: "second_request"; requester: Id<"users"> }
  | { mode: "contested" };

export type CallerAuthorizedClaim = {
  holder: Id<"users">;
  requestId: string;
  expectedToken: number;
} & (
  | (Extract<ClaimResource, { kind: "steer" }> & {
      steering: SteerAuthorization;
    })
  | Extract<ClaimResource, { kind: "terminal" }>
);

export type CallerAuthorizedClaimUse = {
  resource: ClaimResource;
  holder: Id<"users">;
  token: number;
};

export type CallerAuthorizedRevocation = {
  resource: ClaimResource;
  targetHolder: Id<"users">;
  token: number;
};

const LEASE_MS = { steer: 30_000, terminal: 20_000 } as const;

type Lease = { status: "held"; token: number; remainingMs: number };
type Refusal = {
  status: "free" | "stale_token" | "wrong_holder" | "expired";
};
type ClaimResult =
  | Lease
  | { status: "lone" | "inactive_request" | "token_exhausted" }
  | { status: "stale_request"; currentToken: number }
  | { status: "busy"; remainingMs: number };

function findClaim(ctx: MutationCtx, resource: ClaimResource) {
  return ctx.db
    .query("claims")
    .withIndex("by_kind_resource", (q) =>
      q.eq("kind", resource.kind).eq("resource_id", resource.id),
    )
    .unique();
}

export async function readClaimToken(
  ctx: MutationCtx,
  resource: ClaimResource,
): Promise<number> {
  return (await findClaim(ctx, resource))?.token ?? 0;
}

export async function claim(
  ctx: MutationCtx,
  input: CallerAuthorizedClaim,
): Promise<ClaimResult> {
  if (
    input.kind === "steer" &&
    (input.steering.mode === "lone" ||
      (input.steering.mode === "second_request" &&
        input.steering.requester === input.holder))
  ) {
    return { status: "lone" };
  }

  const row = await findClaim(ctx, input);
  const now = Date.now();
  const currentToken = row?.token ?? 0;
  if (
    row &&
    input.expectedToken === currentToken - 1 &&
    input.requestId === row.request_id
  ) {
    if (row.holder === undefined || row.lease_until <= now)
      return { status: "inactive_request" };
    if (row.holder === input.holder)
      return {
        status: "held",
        token: row.token,
        remainingMs: row.lease_until - now,
      };
  }
  if (input.expectedToken !== currentToken)
    return { status: "stale_request", currentToken };
  if (row?.holder !== undefined && row.lease_until > now)
    return { status: "busy", remainingMs: row.lease_until - now };
  if (currentToken === Number.MAX_SAFE_INTEGER)
    return { status: "token_exhausted" };

  const remainingMs = LEASE_MS[input.kind];
  const lease = {
    holder: input.holder,
    token: currentToken + 1,
    lease_until: now + remainingMs,
    request_id: input.requestId,
  };
  if (row) {
    await ctx.db.patch("claims", row._id, lease);
  } else if (input.kind === "steer") {
    await ctx.db.insert("claims", {
      ...lease,
      kind: input.kind,
      resource_id: input.id,
      purpose: "turn_baton",
    });
  } else {
    await ctx.db.insert("claims", {
      ...lease,
      kind: input.kind,
      resource_id: input.id,
      purpose: "typing_lease",
    });
  }
  return { status: "held", token: lease.token, remainingMs };
}

function checkHeldClaim(
  row: Doc<"claims"> | null,
  { holder, token }: CallerAuthorizedClaimUse,
  now: number,
): Lease | Refusal {
  if (!row || row.holder === undefined) return { status: "free" };
  if (row.token !== token) return { status: "stale_token" };
  if (row.holder !== holder) return { status: "wrong_holder" };
  if (row.lease_until <= now) return { status: "expired" };
  return { status: "held", token, remainingMs: row.lease_until - now };
}

export async function checkClaim(
  ctx: MutationCtx,
  input: CallerAuthorizedClaimUse,
): Promise<Lease | Refusal> {
  return checkHeldClaim(
    await findClaim(ctx, input.resource),
    input,
    Date.now(),
  );
}

export async function renew(
  ctx: MutationCtx,
  input: CallerAuthorizedClaimUse,
): Promise<Lease | Refusal> {
  const row = await findClaim(ctx, input.resource);
  const now = Date.now();
  const result = checkHeldClaim(row, input, now);
  if (!row || result.status !== "held") return result;

  const leaseUntil = Math.max(
    row.lease_until,
    now + LEASE_MS[input.resource.kind],
  );
  await ctx.db.patch("claims", row._id, { lease_until: leaseUntil });
  return { status: "held", token: row.token, remainingMs: leaseUntil - now };
}

async function clearHeldClaim(
  ctx: MutationCtx,
  input: CallerAuthorizedClaimUse,
): Promise<{ status: "cleared"; token: number } | Refusal> {
  const row = await findClaim(ctx, input.resource);
  if (!row) return { status: "free" };
  const result = checkHeldClaim(row, input, Date.now());
  if (result.status !== "held") return result;

  await ctx.db.patch("claims", row._id, { holder: undefined, lease_until: 0 });
  return { status: "cleared", token: row.token };
}

export function release(ctx: MutationCtx, input: CallerAuthorizedClaimUse) {
  return clearHeldClaim(ctx, input);
}

export function revoke(ctx: MutationCtx, input: CallerAuthorizedRevocation) {
  return clearHeldClaim(ctx, {
    resource: input.resource,
    holder: input.targetHolder,
    token: input.token,
  });
}
