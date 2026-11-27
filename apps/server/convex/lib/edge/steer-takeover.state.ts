import {
  bindingHasBatonCapability,
  steerBatonEnabled,
} from "./baton-capabilities.rules";
import {
  EDGE_PROTOCOL_VERSION as version,
  STEER_BATON_CAPABILITY,
  TAKEOVER_FENCE_CAPABILITY,
  type TakeoverAckRequest,
  type TakeoverAckResponse,
  type TakeoverFence,
} from "@codecast/edge-contract";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { findClaim, grantSteerTakeover, takeoverForTurn } from "../claims";
import { rejectClaimedSteer } from "../execution-delivery.attempts";
import { pendingByIntent } from "../execution-queue.reads";
import { isFreshTurnProjection, loadRunLeaseClaim } from "./runLease";

type Db = Pick<QueryCtx, "db">;
type Takeover = NonNullable<Doc<"claims">["takeover"]>;
type TurnAddress = { id: string; run: number; start_event_seq: number };
type Run = {
  head: Doc<"conversation_execution_heads">;
  binding: Doc<"execution_bindings">;
};

export async function readSteerContext(
  ctx: Db,
  { head, binding }: Run,
  now: number,
) {
  if (
    !steerBatonEnabled() ||
    !bindingHasBatonCapability(binding, STEER_BATON_CAPABILITY)
  )
    return null;
  const lease = binding.claim_id
    ? await loadRunLeaseClaim(ctx, binding.conversation_id, binding.claim_id)
    : null;
  const projection = await ctx.db
    .query("run_turn_projections")
    .withIndex("by_conversation_run", (q) =>
      q.eq("conversation_id", binding.conversation_id).eq("run", binding.epoch),
    )
    .unique();
  if (
    !lease ||
    !projection ||
    !isFreshTurnProjection(binding, lease, projection, now)
  )
    return null;
  const turn = projection.open_turn;
  const address =
    turn?.start_event_seq === undefined
      ? null
      : {
          id: turn.id,
          run: binding.epoch,
          start_event_seq: turn.start_event_seq,
        };
  const row = address
    ? await findClaim(ctx.db, { kind: "steer", id: binding.conversation_id })
    : null;
  const takeover = address
    ? takeoverForTurn(row, binding.epoch, address)
    : undefined;
  const claim = row?.holder && row.lease_until > now ? row : null;
  const implied =
    turn?.starter?.kind === "person" && !turn.baton_converted
      ? ctx.db.normalizeId("users", turn.starter.id)
      : null;
  return {
    head,
    binding,
    lease,
    projection,
    address,
    row,
    takeover,
    holder: claim?.holder ?? implied,
    batonToken: claim?.token ?? null,
    holderExpiresAt: claim?.lease_until ?? null,
  };
}

export async function readBrowserSteerContext(
  ctx: Db,
  conversation: Doc<"conversations">,
  now: number,
) {
  if (
    !steerBatonEnabled() ||
    conversation.execution_protocol_state !== "fenced" ||
    !conversation.owner_device_id
  )
    return null;
  const head = await ctx.db
    .query("conversation_execution_heads")
    .withIndex("by_conversation", (q) =>
      q.eq("conversation_id", conversation._id),
    )
    .unique();
  if (
    head?.current_epoch === undefined ||
    head.device_move ||
    (head.admission_epoch ?? head.current_epoch) !== head.current_epoch
  )
    return null;
  const binding = await ctx.db
    .query("execution_bindings")
    .withIndex("by_conversation_epoch", (q) =>
      q
        .eq("conversation_id", conversation._id)
        .eq("epoch", head.current_epoch!),
    )
    .unique();
  if (!binding || binding.owner_device_id !== conversation.owner_device_id)
    return null;
  return readSteerContext(ctx, { head, binding }, now);
}

type SteerContext = NonNullable<Awaited<ReturnType<typeof readSteerContext>>>;

function supportsTakeover(run: SteerContext) {
  return (
    bindingHasBatonCapability(run.binding, TAKEOVER_FENCE_CAPABILITY) === true
  );
}

export async function steerQueue(ctx: Db, { head, binding }: SteerContext) {
  const limit = 20;
  const queues = await Promise.all([
    pendingByIntent(ctx, head, binding.epoch, "queue", limit + 1),
    pendingByIntent(ctx, head, binding.epoch, undefined, limit + 1),
  ]);
  const rows = queues
    .flat()
    .sort((a, b) => a.conversation_sequence! - b.conversation_sequence!);
  return {
    items: rows
      .slice(0, limit)
      .map(({ _id, from_user_id }) => ({ id: _id, sender: from_user_id })),
    more: rows.length > limit,
  };
}

async function activeSteer(ctx: Db, head: Run["head"]) {
  if (!head.active_delivery_attempt_id) return null;
  const attempt = await ctx.db.get(head.active_delivery_attempt_id);
  if (
    !attempt ||
    (attempt.state !== "claimed" &&
      attempt.state !== "delivery-started" &&
      attempt.state !== "ambiguous")
  )
    return null;
  const message = await ctx.db.get(attempt.message_id);
  return message?.delivery_intent === "steer" ? { attempt, message } : null;
}

export async function startSteerTakeover(
  ctx: Pick<MutationCtx, "db">,
  run: SteerContext,
  owner: Id<"users">,
  expected: TurnAddress,
  expectedHolder: Id<"users">,
  expectedToken: number | null,
  now: number,
) {
  const { address, holder, batonToken, row, projection } = run;
  if (
    !supportsTakeover(run) ||
    !address ||
    address.id !== expected.id ||
    address.run !== expected.run ||
    address.start_event_seq !== expected.start_event_seq
  )
    return { status: "stale" } as const;
  const previous = run.takeover;
  if (
    previous?.owner === owner &&
    previous.previous_holder === expectedHolder &&
    previous.baton_token === expectedToken &&
    (previous.state === "pending" || row?.token === previous.new_baton_token)
  )
    return {
      status: previous.state === "pending" ? "pending" : "granted",
      fence_id: previous.id,
    } as const;
  if (previous?.state === "pending") return { status: "stale" } as const;
  if (
    holder !== expectedHolder ||
    batonToken !== expectedToken ||
    holder === owner
  )
    return { status: "stale" } as const;
  const lastToken = row?.token ?? 0;
  if (!Number.isSafeInteger(lastToken + 1))
    return { status: "refused" } as const;
  const active = await activeSteer(ctx, run.head);
  const inFlight =
    active?.attempt.state !== "claimed" ? active?.message : undefined;
  if (
    inFlight &&
    (inFlight.delivery_observed_turn?.id !== address.id ||
      inFlight.delivery_observed_turn?.start_event_seq !==
        address.start_event_seq ||
      inFlight.delivery_baton_token !== batonToken)
  )
    return { status: "refused" } as const;
  if (active?.attempt.state === "claimed")
    await rejectClaimedSteer(
      ctx,
      run.head,
      active.message,
      active.attempt,
      "stale-baton",
      now,
    );
  const takeover = {
    id: crypto.randomUUID(),
    run: address.run,
    turn: address.id,
    start_event_seq: address.start_event_seq,
    owner,
    previous_holder: holder,
    baton_token: batonToken,
    new_baton_token: lastToken + 1,
    state: inFlight ? "pending" : "granted",
  } satisfies Takeover;
  const claimId =
    row?._id ??
    (await ctx.db.insert("claims", {
      kind: "steer",
      conversation_id: run.binding.conversation_id,
      token: lastToken,
      lease_until: 0,
    }));
  if (inFlight) await ctx.db.patch(claimId, { takeover });
  else await grantSteerTakeover(ctx, claimId, takeover, now);
  const turn = projection.open_turn;
  if (!inFlight && turn && !turn.baton_converted)
    await ctx.db.patch(projection._id, {
      open_turn: { ...turn, baton_converted: true },
    });
  return { status: takeover.state, fence_id: takeover.id } as const;
}

export async function takeoverPermit(
  ctx: Pick<MutationCtx, "db">,
  run: SteerContext | null,
  fencing_token: string,
): Promise<TakeoverFence | undefined> {
  if (!run?.row || !supportsTakeover(run)) return;
  const takeover = run.takeover;
  if (!takeover || takeover.state === "recorded") return;
  if (takeover.state === "pending" && !takeover.handed_out)
    await ctx.db.patch(run.row._id, {
      takeover: { ...takeover, handed_out: true },
    });
  return {
    v: version,
    status: "takeover_fence",
    session: run.binding.conversation_id,
    run: takeover.run,
    fence_id: takeover.id,
    turn: takeover.turn,
    baton_token: takeover.baton_token,
    new_baton_token: takeover.new_baton_token,
    fencing_token,
  };
}

export async function acknowledgeSteerTakeover(
  ctx: Pick<MutationCtx, "db">,
  run: SteerContext | null,
  ack: TakeoverAckRequest,
  now: number,
): Promise<TakeoverAckResponse> {
  const stale = { v: version, status: "stale" } as const;
  if (!run || !supportsTakeover(run) || !run.row) return stale;
  const { row, takeover } = run;
  if (
    !takeover ||
    takeover.id !== ack.fence_id ||
    takeover.turn !== ack.turn ||
    takeover.baton_token !== ack.baton_token
  )
    return stale;
  if (takeover.state === "recorded") return { v: version, status: "duplicate" };
  if (takeover.state === "pending") {
    const active = await activeSteer(ctx, run.head);
    if (active) return stale;
  }
  if (takeover.state === "pending" && takeover.owner) {
    await grantSteerTakeover(
      ctx,
      row._id,
      { ...takeover, owner: takeover.owner, state: "recorded" },
      now,
    );
    const turn = run.projection.open_turn;
    if (turn && !turn.baton_converted)
      await ctx.db.patch(run.projection._id, {
        open_turn: { ...turn, baton_converted: true },
      });
  } else {
    await ctx.db.patch(row._id, {
      takeover: { ...takeover, state: "recorded" },
    });
  }
  return { v: version, status: "recorded" };
}
