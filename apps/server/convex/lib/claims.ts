import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader, MutationCtx } from "../_generated/server";

type ClaimKey = { kind: "steer" | "terminal"; id: Id<"conversations"> };
type SteerResource = { kind: "steer"; id: Id<"conversations"> };
type TerminalResource = {
  kind: "terminal";
  id: Id<"conversations">;
  paneInstance: number;
};

export type ClaimResource = SteerResource | TerminalResource;

type ClaimRequest = { requestId: string; expectedToken: number };
type SteerRequest =
  | { steering: { mode: "lone" } }
  | (ClaimRequest & {
      steering:
        | { mode: "second_request"; requester: Id<"users"> }
        | { mode: "contested" };
    });

export type CallerAuthorizedClaim = { holder: Id<"users"> } & (
  | (SteerResource & SteerRequest)
  | (TerminalResource & ClaimRequest)
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
  status: "free" | "stale_token" | "wrong_holder" | "expired" | "wrong_pane";
};
type ClaimResult =
  | Lease
  | {
      status:
        | "lone"
        | "inactive_request"
        | "token_exhausted"
        | "invalid_request"
        | "invalid_pane"
        | "wrong_pane";
    }
  | { status: "stale_request" | "pane_changed"; currentToken: number }
  | { status: "busy"; remainingMs: number };

function findClaim(db: DatabaseReader, resource: ClaimKey) {
  return db
    .query("claims")
    .withIndex("by_conversation_kind", (q) =>
      q.eq("conversation_id", resource.id).eq("kind", resource.kind),
    )
    .unique();
}

function isValidPaneInstance(instance: number): boolean {
  return Number.isSafeInteger(instance) && instance > 0;
}

export async function readClaimToken(
  db: DatabaseReader,
  resource: ClaimKey,
): Promise<number> {
  return (await findClaim(db, resource))?.token ?? 0;
}

export async function claim(
  ctx: MutationCtx,
  input: CallerAuthorizedClaim,
): Promise<ClaimResult> {
  const row = await findClaim(ctx.db, input);
  const now = Date.now();
  const currentToken = row?.token ?? 0;
  const remainingMs = row?.holder === undefined ? 0 : row.lease_until - now;
  const held = { status: "held", token: currentToken, remainingMs } as const;
  const busy = { status: "busy", remainingMs } as const;

  const turnRight =
    remainingMs <= 0
      ? ({ status: "lone" } as const)
      : row?.holder === input.holder
        ? held
        : busy;
  if (!("requestId" in input)) return turnRight;
  if (!input.requestId) return { status: "invalid_request" };
  if (input.kind === "terminal" && !isValidPaneInstance(input.paneInstance))
    return { status: "invalid_pane" };

  const currentPane = row?.pane_instance ?? 0;
  const pane = input.kind === "terminal" ? input.paneInstance : 0;
  if (pane < currentPane) return { status: "wrong_pane" };
  const newPane = row !== null && pane > currentPane;
  const stale = { status: "stale_request", currentToken } as const;
  if (row?.request_id === input.requestId) {
    if (row.request_holder !== input.holder) return stale;
    return remainingMs > 0 && !newPane ? held : { status: "inactive_request" };
  }
  if (
    input.kind === "steer" &&
    input.steering.mode === "second_request" &&
    input.steering.requester === input.holder
  )
    return turnRight;
  if (input.expectedToken !== currentToken) return stale;

  if (newPane) {
    await ctx.db.patch("claims", row._id, {
      pane_instance: pane,
      holder: undefined,
      lease_until: 0,
      request_id: input.requestId,
      request_holder: input.holder,
    });
    return { status: "pane_changed", currentToken };
  }
  if (remainingMs > 0) return busy;
  if (currentToken === Number.MAX_SAFE_INTEGER)
    return { status: "token_exhausted" };

  const duration = LEASE_MS[input.kind];
  const lease = {
    holder: input.holder,
    token: currentToken + 1,
    lease_until: now + duration,
    request_id: input.requestId,
    request_holder: input.holder,
  };
  if (row) {
    await ctx.db.patch("claims", row._id, lease);
  } else {
    await ctx.db.insert("claims", {
      ...lease,
      conversation_id: input.id,
      kind: input.kind,
      ...(input.kind === "terminal" ? { pane_instance: pane } : {}),
    });
  }
  return { status: "held", token: lease.token, remainingMs: duration };
}

function checkHeldClaim(
  row: Doc<"claims"> | null,
  { resource, holder, token }: CallerAuthorizedClaimUse,
  now: number,
): Lease | Refusal {
  if (
    resource.kind === "terminal" &&
    (!isValidPaneInstance(resource.paneInstance) ||
      (row && row.pane_instance !== resource.paneInstance))
  ) {
    return { status: "wrong_pane" };
  }
  if (!row || row.holder === undefined) return { status: "free" };
  if (row.token !== token) return { status: "stale_token" };
  if (row.holder !== holder) return { status: "wrong_holder" };
  if (row.lease_until <= now) return { status: "expired" };
  return { status: "held", token, remainingMs: row.lease_until - now };
}

export async function withHeldClaim<T>(
  ctx: MutationCtx,
  input: CallerAuthorizedClaimUse,
  write: (ctx: MutationCtx) => T | Promise<T>,
): Promise<(Lease & { value: T }) | Refusal> {
  const row = await findClaim(ctx.db, input.resource);
  const result = checkHeldClaim(row, input, Date.now());
  if (result.status !== "held") return result;
  return { ...result, value: await write(ctx) };
}

export async function renew(
  ctx: MutationCtx,
  input: CallerAuthorizedClaimUse,
): Promise<Lease | Refusal> {
  const row = await findClaim(ctx.db, input.resource);
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
  const row = await findClaim(ctx.db, input.resource);
  const result = checkHeldClaim(row, input, Date.now());
  if (result.status !== "held") return result;
  if (!row) return { status: "free" };

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
