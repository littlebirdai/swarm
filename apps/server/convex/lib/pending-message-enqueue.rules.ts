import type { WakeCause } from "@codecast/hosted-assistant/assistant";
import { STEER_BATON_CAPABILITY } from "@codecast/edge-contract";
import { TURN_STARTER_PROJECTION_VERSION } from "@codecast/session-contract/turn-projection";
import { ConvexError, v, type Infer } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { claim, findClaim } from "./claims";

export const observedTurnValidator = v.object({
  id: v.string(),
  run: v.number(),
  start_event_seq: v.number(),
});

type ObservedTurn = Infer<typeof observedTurnValidator>;

export type PendingMessageEnqueueFields = {
  content: string;
  image_storage_id?: Id<"_storage">;
  image_storage_ids?: Id<"_storage">[];
  client_id?: string;
  // The sender's own conversation, so the cron can notify the sending session if this message
  // can't be delivered. Only meaningful for cross-user (team) sends; omitted for self-sends.
  from_conversation_id?: Id<"conversations">;
  // "scheduler" = machine-initiated (the daemon's task scheduler firing a
  // `cast trigger` injection). Every human send — web composer, cast send,
  // team send — leaves this unset.
  origin?: "scheduler";
  // A PERSON wrote this to the session: the web/mobile composer, the receipt
  // path, a doc review, a link collaborator's composer, `cast send` from a
  // plain terminal. Positive and caller-declared, so a path nobody marked
  // keeps today's behaviour. A session relaying to another session and a
  // trigger firing are not people, and neither are the machine notices
  // (account-switch "continue", undeliverable receipts, model/effort slash
  // commands) that leave `origin` unset.
  human?: boolean;
  // Sent from a signed-in person's web or phone composer, never through an
  // API token (schema pending_messages.channel). Set only through
  // composerChannel, when the composer's own submit hands over its words;
  // every other producer leaves it unset, which reads as a program
  // (lib/messageProvenance.ts).
  channel?: "composer";
  // With channel: what the person typed in the box (composerChannel).
  typed_text?: string;
  // A note the session reads on its NEXT turn, never a turn of its own: the
  // row is parked as "held" (the daemon and the retry cron read "pending"
  // only) and nothing about the conversation moves, so a session whose
  // prompt cache is gone is not woken, resurfaced or resurrected to read one
  // sentence. The next ordinary message into the session releases it, and
  // it delivers first because it is older.
  defer?: boolean;
  // A note for the session's own record, never a turn of its own, on ANY
  // session: parked as "held" like `defer`. For a line the session itself
  // caused, such as a role's own escalation divider, so the role is not
  // woken to read what it just wrote.
  hold?: boolean;
  // The composer's "Queue for later": held for the end of the agent's
  // turn in the session's shared queue (schema pending_messages.queued).
  queue?: boolean;
  observed_turn?: ObservedTurn;
  // Work a session hands another out of sight: a flow run's brief to the
  // session it runs for (flows.md FL4). A hidden stash and a snooze survive
  // it, as they survive a trigger's wake; everything else wakes as for any send.
  quiet?: boolean;
  // Why a hosted conversation wakes for this row, when the caller knows
  // better than the origin says (an answered approval). Ignored for every
  // other conversation.
  wake_cause?: WakeCause;
};

export type SendAdmission =
  | { delivery_intent: "queue" }
  | {
      delivery_intent: "steer";
      delivery_observed_turn: ObservedTurn;
      delivery_baton_token: number | null;
    };

const queue = { delivery_intent: "queue" } as const;
const staleTurn = () =>
  new ConvexError({
    code: "STALE_TURN",
    message:
      "The observed turn could not be verified. Send as queue to deliver after the current turn.",
  });

export async function admitFencedHumanSend(
  ctx: Pick<MutationCtx, "db">,
  conversationId: Id<"conversations">,
  sender: Id<"users">,
  clientId: string,
  observed?: ObservedTurn,
): Promise<SendAdmission | undefined> {
  const head = await ctx.db
    .query("conversation_execution_heads")
    .withIndex("by_conversation", (q) =>
      q.eq("conversation_id", conversationId),
    )
    .unique();
  const admissionRun = head?.admission_epoch ?? head?.current_epoch;
  const run = observed ? head?.current_epoch : admissionRun;
  if (observed && admissionRun !== run) throw staleTurn();
  if (observed && observed.run !== run) throw staleTurn();
  if (!head || run === undefined) return;
  const binding = await ctx.db
    .query("execution_bindings")
    .withIndex("by_conversation_epoch", (q) =>
      q.eq("conversation_id", conversationId).eq("epoch", run),
    )
    .unique();
  if (!binding?.capabilities?.includes(STEER_BATON_CAPABILITY)) return;
  if (!observed) return queue;

  const claimId = binding.claim_id;
  const [projection, lease] = await Promise.all([
    ctx.db
      .query("run_turn_projections")
      .withIndex("by_conversation_run", (q) =>
        q.eq("conversation_id", conversationId).eq("run", run),
      )
      .unique(),
    claimId === undefined
      ? null
      : ctx.db
          .query("run_leases")
          .withIndex("by_conversation_claim", (q) =>
            q.eq("conversation_id", conversationId).eq("claim_id", claimId),
          )
          .unique(),
  ]);
  const now = Date.now();
  const turn = projection?.open_turn;
  if (
    binding.state !== "ready" ||
    projection?.status !== "active" ||
    projection.binding_id !== binding._id ||
    projection.projection_version !== TURN_STARTER_PROJECTION_VERSION ||
    lease?.binding_id !== binding._id ||
    lease.boot !== binding.daemon_boot_id ||
    lease.released_at !== undefined ||
    lease.expires_at <= now ||
    !turn?.starter ||
    observed.id !== turn.id ||
    observed.start_event_seq !== turn.start_event_seq
  )
    throw staleTurn();

  const resource = { id: conversationId, kind: "steer" } as const;
  const current = await findClaim(ctx.db, resource);
  const starter =
    turn.starter.kind === "person"
      ? ctx.db.normalizeId("users", turn.starter.id)
      : null;
  const steer = (token: number | null): SendAdmission => ({
    delivery_intent: "steer",
    delivery_observed_turn: observed,
    delivery_baton_token: token,
  });

  if (current?.holder !== undefined && current.lease_until > now) {
    if (!turn.baton_converted)
      await ctx.db.patch(projection._id, {
        open_turn: { ...turn, baton_converted: true },
      });
    return current.holder === sender ? steer(current.token) : queue;
  }

  const implied = starter !== null && !turn.baton_converted;
  if (implied && starter === sender) return steer(null);
  if (!implied && head.active_delivery_attempt_id !== undefined) return queue;
  const result = await claim(ctx, {
    ...resource,
    holder: implied ? starter : sender,
    requestId: JSON.stringify([
      run,
      observed.start_event_seq,
      sender,
      clientId,
    ]),
    expectedToken: current?.token ?? 0,
    steering: implied
      ? { mode: "second_request", requester: sender }
      : { mode: "contested" },
  });
  if (result.status !== "held") return queue;
  if (!turn.baton_converted)
    await ctx.db.patch(projection._id, {
      open_turn: { ...turn, baton_converted: true },
    });
  return implied ? queue : steer(result.token);
}
