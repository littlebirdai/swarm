import { STEER_BATON_CAPABILITY } from "@codecast/edge-contract";
import {
  TURN_PROJECTION_VERSION,
  TURN_STARTER_PROJECTION_VERSION,
} from "@codecast/session-contract/turn-projection";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { canSendProductMessage } from "../pendingMessages";
import { findClaim } from "./claims";
import { fail } from "./execution-binding.validators";
import { byQueueOrder } from "./sessionQueue";
import { orderedNonterminalMessages } from "./executionQueue";
import {
  clearPendingFlagIfQuiet,
  fencedMessages,
  pendingRowsByStatus,
} from "./execution-binding.state";

type Db = Pick<MutationCtx, "db">;
type Turn = NonNullable<Doc<"run_turn_projections">["open_turn"]>;

export function batonEnabled(
  binding: Pick<Doc<"execution_bindings">, "capabilities"> | null,
): boolean {
  return (
    process.env.SWARM_TURN_BATON === "1" &&
    binding?.capabilities?.includes(STEER_BATON_CAPABILITY) === true
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
  const first = head.next_conversation_sequence;
  if (
    head.active_delivery_attempt_id !== undefined ||
    head.current_epoch !== binding.epoch ||
    (head.admission_epoch ?? head.current_epoch) !== binding.epoch ||
    binding.state !== "ready" ||
    (await readBatonTurn(ctx, binding)) !== null
  )
    return first;
  const rows = (
    await pendingRowsByStatus(ctx, head.conversation_id, ["held", "pending"])
  )
    .filter(
      (row) =>
        row.queued &&
        row.conversation_sequence === undefined &&
        row.delivery_protocol_version === undefined,
    )
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

export async function steerRefusal(
  ctx: Db,
  conversation: Doc<"conversations">,
  run: number,
  turn: Turn | null,
  activeClaim: Doc<"claims"> | null,
  message: Doc<"pending_messages">,
  now: number,
): Promise<string | undefined> {
  const expected = message.delivery_observed_turn;
  const baton = message.delivery_baton_token;
  if (
    !turn ||
    !expected ||
    expected.run !== run ||
    expected.id !== turn.id ||
    expected.start_event_seq !== turn.start_event_seq
  )
    return "stale-turn";
  if (
    !message.human ||
    message.from_conversation_id !== undefined ||
    message.origin !== undefined
  )
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

export async function sweepPendingSteers(
  ctx: Db,
  conversation: Doc<"conversations">,
  binding: Doc<"execution_bindings"> | null,
  head: Doc<"conversation_execution_heads">,
  messages: Doc<"pending_messages">[],
  now: number,
) {
  const enabled = batonEnabled(binding);
  const turn = enabled && binding ? await readBatonTurn(ctx, binding) : null;
  const run = head.current_epoch;
  if (
    turn === undefined ||
    run === undefined ||
    (!enabled && messages[0]?.delivery_intent !== "steer")
  )
    return { turn, messages, changed: false };

  const remaining: Doc<"pending_messages">[] = [];
  const resource = { id: conversation._id, kind: "steer" } as const;
  let claim: Doc<"claims"> | null | undefined;
  for (const message of messages) {
    if (
      message.execution_epoch !== run ||
      (!enabled && remaining.length > 0) ||
      message.delivery_intent !== "steer" ||
      message.delivery_status !== "pending" ||
      message.active_delivery_attempt_id !== undefined
    ) {
      remaining.push(message);
      continue;
    }
    if (claim === undefined)
      claim = turn ? await findClaim(ctx.db, resource) : null;
    const reason = await steerRefusal(
      ctx,
      conversation,
      run,
      turn,
      claim,
      message,
      now,
    );
    if (!reason) {
      remaining.push(message);
      continue;
    }
    await ctx.db.patch(message._id, {
      delivery_status: "rejected",
      status: "cancelled",
      delivery_disposition_reason: reason,
    });
  }
  const changed = remaining.length !== messages.length;
  if (changed) {
    await ctx.db.patch(head._id, {
      next_nonterminal_sequence:
        remaining[0]?.conversation_sequence ?? head.next_conversation_sequence,
      updated_at: now,
    });
    if (remaining.length === 0)
      await clearPendingFlagIfQuiet(ctx, conversation._id);
  }
  return { turn, messages: remaining, changed };
}

export async function oldestEligibleDelivery(
  ctx: Db,
  conversation: Doc<"conversations">,
  head: Doc<"conversation_execution_heads">,
  binding: Doc<"execution_bindings"> | null,
  now: number,
) {
  const enabled = batonEnabled(binding);
  const nextSequence =
    enabled && binding
      ? await allocateLegacyQueuedRows(ctx, head, binding, now)
      : head.next_conversation_sequence;
  const messages = orderedNonterminalMessages(
    await fencedMessages(ctx, conversation._id, head.next_nonterminal_sequence),
    head,
  );
  const admission = await sweepPendingSteers(
    ctx,
    conversation,
    binding,
    { ...head, next_conversation_sequence: nextSequence },
    messages,
    now,
  );
  const oldest = admission.messages[0];
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
  if (!enabled || oldest.execution_epoch !== head.current_epoch) return oldest;
  if (admission.turn === undefined) return;
  return admission.messages.find(
    (candidate) =>
      candidate.execution_epoch === head.current_epoch &&
      (candidate.delivery_intent === "steer") === (admission.turn !== null),
  );
}
