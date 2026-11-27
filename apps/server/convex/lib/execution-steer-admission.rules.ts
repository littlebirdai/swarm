import { bindingHasBatonCapability } from "./edge/baton-capabilities.rules";
import { STEER_BATON_CAPABILITY } from "@codecast/edge-contract";
import {
  TURN_PROJECTION_VERSION,
  TURN_STARTER_PROJECTION_VERSION,
} from "@codecast/session-contract/turn-projection";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { canSendProductMessage } from "../pendingMessages";
import { allowedAgentSteer } from "./agent-steer-grant.state";
import type { SendAdmission } from "./pending-message-enqueue.rules";
import { findClaim, takeoverForTurn } from "./claims";
import { fail } from "./execution-binding.validators";
import { byQueueOrder } from "./sessionQueue";
import {
  advanceNonterminalHead,
  executionBinding,
  executionHead,
  clearPendingFlagIfQuiet,
} from "./execution-binding.state";
import { assertActiveRunLease } from "./edge/runLease";
import {
  hasNonterminalAtEpoch,
  oldestNonterminal,
  pendingByIntent,
  queuedLegacyRows,
} from "./execution-queue.reads";

type Db = Pick<MutationCtx, "db">;
type Turn = NonNullable<Doc<"run_turn_projections">["open_turn"]>;

export function batonEnabled(
  binding: Pick<
    Doc<"execution_bindings">,
    "capabilities" | "edge_capabilities"
  > | null,
): boolean {
  return (
    process.env.SWARM_TURN_BATON === "1" &&
    bindingHasBatonCapability(binding, STEER_BATON_CAPABILITY) === true
  );
}

export async function readBatonTurn(
  ctx: Db,
  binding: Doc<"execution_bindings">,
) {
  const projection = await ctx.db
    .query("run_turn_projections")
    .withIndex("by_conversation_run", (q) =>
      q.eq("conversation_id", binding.conversation_id).eq("run", binding.epoch),
    )
    .unique();
  if (projection?.binding_id !== binding._id) return undefined;
  if (projection.projection_version === TURN_STARTER_PROJECTION_VERSION)
    return projection.status === "active" ? projection.open_turn : null;
  if (
    projection.projection_version === TURN_PROJECTION_VERSION &&
    projection.open_turn === null
  )
    return null;
}

export async function allocateLegacyQueuedRows(
  ctx: Db,
  head: Doc<"conversation_execution_heads">,
  binding: Doc<"execution_bindings">,
  now: number,
): Promise<number> {
  if (
    !canAllocateLegacy(head, binding) ||
    (await readBatonTurn(ctx, binding)) !== null
  )
    return head.next_conversation_sequence;
  return allocateQueuedRows(ctx, head, binding, now);
}

function canAllocateLegacy(
  head: Doc<"conversation_execution_heads">,
  binding: Doc<"execution_bindings">,
): boolean {
  return (
    head.active_delivery_attempt_id === undefined &&
    head.current_epoch === binding.epoch &&
    (head.admission_epoch ?? head.current_epoch) === binding.epoch &&
    binding.state === "ready"
  );
}

async function allocateQueuedRows(
  ctx: Db,
  head: Doc<"conversation_execution_heads">,
  binding: Doc<"execution_bindings">,
  now: number,
): Promise<number> {
  const first = head.next_conversation_sequence;
  const rows = (
    await Promise.all([
      queuedLegacyRows(ctx, head.conversation_id, "held"),
      queuedLegacyRows(ctx, head.conversation_id, "pending"),
    ])
  )
    .flat()
    .filter((row) => row.conversation_sequence === undefined)
    .sort(byQueueOrder);

  let next = first;
  for (const row of rows) {
    const id = row.client_id ?? crypto.randomUUID();
    const identities = await ctx.db
      .query("pending_messages")
      .withIndex("by_conversation_client_id", (q) =>
        q.eq("conversation_id", head.conversation_id).eq("client_id", id),
      )
      .take(2);
    if (
      !id.trim() ||
      id !== id.trim() ||
      identities.some((identity) => identity._id !== row._id)
    )
      fail(
        "EXECUTION_PROTOCOL_INVARIANT",
        "legacy queued row has no unique canonical client id",
      );
    await ctx.db.patch(row._id, {
      client_id: id,
      delivery_id: id,
      delivery_intent: "queue",
      delivery_protocol_version: head.protocol_version,
      execution_epoch: binding.epoch,
      conversation_sequence: next++,
      delivery_status: "pending",
    });
  }
  if (next !== first)
    await ctx.db.patch(head._id, {
      next_conversation_sequence: next,
      updated_at: now,
    });
  return next;
}

export async function admitAgentSend(
  ctx: Db,
  conversation: Doc<"conversations">,
  senderId: Id<"conversations">,
  senderUserId: Id<"users">,
  explicitlyQueued: boolean,
): Promise<SendAdmission | undefined> {
  const head = await executionHead(ctx, conversation._id);
  const run = head?.current_epoch;
  if (run === undefined) return;
  const binding = (await executionBinding(
    ctx,
    conversation._id,
    run,
  )) as Doc<"execution_bindings"> | null;
  if (!binding?.required_capabilities.includes(STEER_BATON_CAPABILITY)) return;
  const queue = { delivery_intent: "queue" } as const;
  if (
    explicitlyQueued ||
    !batonEnabled(binding) ||
    head.device_move ||
    (head.admission_epoch ?? run) !== run ||
    binding.state !== "ready" ||
    binding.claim_id === undefined ||
    head.agent_steer_grant?.sender_id !== senderId
  )
    return queue;

  const [turn, lease, claim] = await Promise.all([
    readBatonTurn(ctx, binding),
    ctx.db
      .query("run_leases")
      .withIndex("by_conversation_claim", (q) =>
        q
          .eq("conversation_id", conversation._id)
          .eq("claim_id", binding.claim_id!),
      )
      .unique(),
    findClaim(ctx.db, { id: conversation._id, kind: "steer" }),
  ]);
  const now = Date.now();
  if (
    !turn ||
    turn.start_event_seq === undefined ||
    takeoverForTurn(claim, run, turn)?.state === "pending" ||
    lease?.binding_id !== binding._id ||
    lease.boot !== binding.daemon_boot_id ||
    lease.released_at !== undefined ||
    lease.expires_at <= now
  )
    return queue;

  const token = await allowedAgentSteer(
    ctx,
    conversation,
    senderId,
    senderUserId,
    turn,
    claim,
    now,
    head,
  );
  if (
    token === undefined ||
    !(await canSendProductMessage(ctx, senderUserId, conversation))
  )
    return queue;

  return {
    delivery_intent: "steer",
    delivery_observed_turn: {
      run,
      id: turn.id,
      start_event_seq: turn.start_event_seq,
    },
    delivery_baton_token: token,
  };
}

export async function steerRefusal(
  ctx: Db,
  conversation: Doc<"conversations">,
  head: Doc<"conversation_execution_heads">,
  turn: Turn | null,
  activeClaim: Doc<"claims"> | null,
  message: Doc<"pending_messages">,
  now: number,
): Promise<string | undefined> {
  const run = head.current_epoch;
  const expected = message.delivery_observed_turn;
  const baton = message.delivery_baton_token;
  if (
    !turn ||
    !expected ||
    run === undefined ||
    expected.run !== run ||
    expected.id !== turn.id ||
    expected.start_event_seq !== turn.start_event_seq
  )
    return "stale-turn";
  if (message.origin !== undefined) return "stale-steer-sender";
  if (takeoverForTurn(activeClaim, run, turn)?.state === "pending")
    return "stale-baton";
  if (!message.human && message.from_conversation_id !== undefined) {
    const token = await allowedAgentSteer(
      ctx,
      conversation,
      message.from_conversation_id,
      message.from_user_id,
      turn,
      activeClaim,
      now,
      head,
    );
    if (token === undefined || token !== baton) return "stale-agent-grant";
    if (!(await canSendProductMessage(ctx, message.from_user_id, conversation)))
      return "stale-steer-sender";
    return;
  }
  if (!message.human || message.from_conversation_id !== undefined)
    return "stale-steer-sender";
  const held =
    activeClaim?.holder !== undefined && activeClaim.lease_until > now
      ? activeClaim
      : null;
  const matches =
    baton === null
      ? !held &&
        !turn.baton_converted &&
        turn.starter?.kind === "person" &&
        turn.starter.id === message.from_user_id
      : held?.holder === message.from_user_id && held?.token === baton;
  if (!matches) return "stale-baton";
  if (!(await canSendProductMessage(ctx, message.from_user_id, conversation)))
    return "stale-steer-sender";
}

const steerSweepBatch = 64;

async function sweepPendingSteers(
  ctx: Db,
  conversation: Doc<"conversations">,
  head: Doc<"conversation_execution_heads">,
  turn: Turn | null | undefined,
  now: number,
  oldest?: Doc<"pending_messages">,
) {
  const run = head.current_epoch;
  if (turn === undefined || run === undefined)
    return { changed: false, advanced: false };

  const rows = await pendingByIntent(ctx, head, run, "steer", steerSweepBatch);
  let changed = false;
  let advanced = false;
  let firstSteer: Doc<"pending_messages"> | undefined;
  let claim: Doc<"claims"> | null | undefined;
  for (const message of rows) {
    if (
      message.active_delivery_attempt_id !== undefined ||
      (head.pending_policy === "cancel-unstarted" &&
        message.conversation_sequence! <= head.cancelled_through_sequence!)
    )
      continue;
    if (claim === undefined)
      claim = turn
        ? await findClaim(ctx.db, { id: conversation._id, kind: "steer" })
        : null;
    const reason = await steerRefusal(
      ctx,
      conversation,
      head,
      turn,
      claim,
      message,
      now,
    );
    if (!reason) {
      firstSteer ??= message;
      continue;
    }
    await ctx.db.patch(message._id, {
      delivery_status: "rejected",
      status: "cancelled",
      delivery_disposition_reason: reason,
    });
    changed = true;
    advanced ||= oldest === undefined || message._id === oldest._id;
  }
  if (advanced) {
    const next = await advanceNonterminalHead(ctx, head, now);
    if (next === head.next_conversation_sequence)
      await clearPendingFlagIfQuiet(ctx, conversation._id);
  }
  return { changed, advanced, firstSteer };
}

export async function canStopAfterDrain(
  ctx: Db,
  conversation: Doc<"conversations">,
  head: Doc<"conversation_execution_heads">,
  binding: Doc<"execution_bindings">,
  fencingToken: string | undefined,
  now: number,
): Promise<boolean> {
  const enabled = batonEnabled(binding);
  if (enabled && !fencingToken) return false;
  const oldest = enabled ? undefined : await oldestNonterminal(ctx, head);
  let changed = false;
  if (
    enabled ||
    (oldest?.execution_epoch === binding.epoch &&
      oldest?.delivery_intent === "steer")
  ) {
    await assertActiveRunLease(ctx, binding, fencingToken, now);
    const turn = enabled ? await readBatonTurn(ctx, binding) : null;
    ({ changed } = await sweepPendingSteers(
      ctx,
      conversation,
      head,
      turn,
      now,
    ));
  }
  if (!(await hasNonterminalAtEpoch(ctx, conversation._id, binding.epoch)))
    return true;
  if (enabled || changed) return false;
  fail(
    "EXECUTION_SUCCESSOR_WAITING_FOR_DRAIN",
    "drain-current cannot stop its only ready runtime while old-epoch messages remain",
  );
}

export async function oldestEligibleDelivery(
  ctx: Db,
  conversation: Doc<"conversations">,
  head: Doc<"conversation_execution_heads">,
  binding: Doc<"execution_bindings"> | null,
  now: number,
) {
  const enabled = batonEnabled(binding);
  const turn = enabled && binding ? await readBatonTurn(ctx, binding) : null;
  const nextSequence =
    enabled && binding && turn === null && canAllocateLegacy(head, binding)
      ? await allocateQueuedRows(ctx, head, binding, now)
      : head.next_conversation_sequence;
  const selectionHead =
    nextSequence === head.next_conversation_sequence
      ? head
      : { ...head, next_conversation_sequence: nextSequence };
  const beforeSweep = await oldestNonterminal(ctx, selectionHead);
  const admission =
    enabled || beforeSweep?.delivery_intent === "steer"
      ? await sweepPendingSteers(
          ctx,
          conversation,
          selectionHead,
          turn,
          now,
          beforeSweep,
        )
      : { changed: false, advanced: false };
  const oldest = admission.advanced
    ? await oldestNonterminal(ctx, selectionHead)
    : beforeSweep;
  if (!oldest) {
    if (!admission.changed && head.next_nonterminal_sequence !== nextSequence)
      await ctx.db.patch(head._id, {
        next_nonterminal_sequence: nextSequence,
        updated_at: now,
      });
    return;
  }
  if (
    !admission.changed &&
    oldest.conversation_sequence !== head.next_nonterminal_sequence
  )
    fail(
      "DELIVERY_SEQUENCE_HEAD_MISMATCH",
      `durable head ${head.next_nonterminal_sequence} differs from first nonterminal ${oldest.conversation_sequence}`,
    );
  if (
    oldest.execution_epoch !== head.current_epoch ||
    oldest.delivery_status !== "pending"
  )
    return oldest;
  if (!enabled) return oldest.delivery_intent === "steer" ? undefined : oldest;
  if (turn === undefined || head.current_epoch === undefined) return;
  if (turn) return admission.firstSteer;
  if (oldest.delivery_intent !== "steer") return oldest;

  const [[queue], [legacy]] = await Promise.all([
    pendingByIntent(ctx, selectionHead, head.current_epoch, "queue", 1),
    pendingByIntent(ctx, selectionHead, head.current_epoch, undefined, 1),
  ]);
  if (
    !queue ||
    (legacy && legacy.conversation_sequence! < queue.conversation_sequence!)
  )
    return legacy;
  return queue;
}
