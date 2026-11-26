import {
  EDGE_PROTOCOL_VERSION as v1,
  parseCommandsNextResponse,
  type CommandsNextResponse,
  type CommandsResultResponse,
} from "@codecast/edge-contract";
import { verifyDeviceApiToken } from "@platform/auth/convex";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { isConversationSafetyBlocked } from "../../conversationSafety";
import { isFreshTurnProjection, ownedRun } from "./runLease";

type PromptPosition = {
  conversation_id: Id<"conversations">;
  run: number;
  lease_id: Id<"run_leases">;
  turn_id: string;
  prompt_id: string;
};

type Reader = Pick<QueryCtx, "db">;
type Device = { bearer: string; machine: string; boot: string };
type Next = Extract<CommandsNextResponse, { status: "empty" | "command" }>;
type Result = Extract<
  CommandsResultResponse,
  { status: "recorded" | "duplicate" | "stale" }
>;

export function fencedPromptAnswersEnabled() {
  return (
    process.env.CODECAST_FENCED_EXECUTION_V1 === "1" &&
    process.env.CODECAST_EDGE_DELIVERY_V1 === "1"
  );
}

type PromptTarget = Omit<PromptPosition, "lease_id">;

async function openPrompt(
  ctx: Reader,
  position: PromptTarget & { lease_id?: Id<"run_leases"> },
  owner: Id<"users">,
) {
  const { conversation_id, run, lease_id, turn_id, prompt_id } = position;
  const conversation = await ctx.db.get(conversation_id);
  if (
    conversation?.user_id !== owner ||
    conversation.execution_protocol_state !== "fenced" ||
    !conversation.owner_device_id ||
    isConversationSafetyBlocked(conversation)
  )
    return null;
  const head = await ctx.db
    .query("conversation_execution_heads")
    .withIndex("by_conversation", (q) =>
      q.eq("conversation_id", conversation_id),
    )
    .unique();
  if (
    head?.owner_user_id !== owner ||
    head.protocol_state !== "fenced" ||
    head.current_epoch !== run
  )
    return null;
  const binding = await ctx.db
    .query("execution_bindings")
    .withIndex("by_conversation_epoch", (q) =>
      q.eq("conversation_id", conversation_id).eq("epoch", run),
    )
    .unique();
  if (
    !binding ||
    !binding.claim_id ||
    binding.owner_user_id !== owner ||
    binding.owner_device_id !== conversation.owner_device_id
  )
    return null;
  const claimId = binding.claim_id;
  const [lease, projection] = await Promise.all([
    lease_id
      ? ctx.db.get(lease_id)
      : ctx.db
          .query("run_leases")
          .withIndex("by_conversation_claim", (q) =>
            q.eq("conversation_id", conversation_id).eq("claim_id", claimId),
          )
          .unique(),
    ctx.db
      .query("run_turn_projections")
      .withIndex("by_conversation_run", (q) =>
        q.eq("conversation_id", conversation_id).eq("run", run),
      )
      .unique(),
  ]);
  if (
    !lease ||
    !isFreshTurnProjection(binding, lease, projection, Date.now()) ||
    projection?.open_turn?.id !== turn_id ||
    !projection.open_turn.prompt_ids.includes(prompt_id)
  )
    return null;
  return { binding, lease };
}

function recordedAnswer(
  ctx: Reader,
  position: PromptPosition,
  actor: Id<"users">,
) {
  const { conversation_id, run, lease_id, turn_id, prompt_id } = position;
  return ctx.db
    .query("edge_prompt_answers")
    .withIndex("by_conversation_prompt", (q) =>
      q
        .eq("conversation_id", conversation_id)
        .eq("run", run)
        .eq("lease_id", lease_id)
        .eq("turn_id", turn_id)
        .eq("prompt_id", prompt_id)
        .eq("actor_user_id", actor),
    )
    .unique();
}

export async function promptAddress(
  ctx: Reader,
  target: PromptTarget,
  actor: Id<"users">,
) {
  if (!fencedPromptAnswersEnabled()) return null;
  const opened = await openPrompt(ctx, target, actor);
  if (!opened) return null;
  const position = { ...target, lease_id: opened.lease._id };
  return (await recordedAnswer(ctx, position, actor)) ? null : position;
}

function command(
  id: string,
  position: PromptPosition,
  actor: string,
  answer: Doc<"edge_prompt_answers">["answer"],
  lease: Doc<"run_leases">,
) {
  return parseCommandsNextResponse({
    v: v1,
    status: "command",
    command_id: id,
    name: "prompt_answer",
    claim: {
      session: String(position.conversation_id),
      run: position.run,
      fencing_token: lease.fencing_token,
    },
    expected: {
      kind: "prompt",
      run: position.run,
      prompt_id: position.prompt_id,
    },
    args: { by: { kind: "person", id: actor }, answer },
  });
}

export async function queuePromptAnswer(
  ctx: MutationCtx,
  position: PromptPosition,
  actor: Id<"users">,
  answer: Doc<"edge_prompt_answers">["answer"],
): Promise<Id<"edge_prompt_answers">> {
  if (!fencedPromptAnswersEnabled())
    throw new ConvexError("FENCED_PROMPT_ANSWERS_DISABLED");
  const opened = await openPrompt(ctx, position, actor);
  if (!opened) throw new ConvexError("STALE_OR_UNAUTHORIZED_PROMPT");
  if (await recordedAnswer(ctx, position, actor))
    throw new ConvexError("PROMPT_ALREADY_ANSWERED");
  const parsed = command("pending", position, actor, answer, opened.lease);
  if (!parsed.ok || JSON.stringify(answer).length > 16_384)
    throw new ConvexError("INVALID_PROMPT_ANSWER");
  return ctx.db.insert("edge_prompt_answers", {
    ...position,
    owner_user_id: actor,
    actor_user_id: actor,
    device_id: opened.binding.owner_device_id,
    boot: opened.binding.daemon_boot_id,
    answer,
  });
}

export async function nextPromptAnswer(
  ctx: MutationCtx,
  args: Device,
): Promise<Next> {
  const empty = { v: v1, status: "empty" } as const;
  if (!fencedPromptAnswersEnabled()) return empty;
  const auth = await verifyDeviceApiToken(ctx, args.bearer);
  if (!auth || auth.deviceId !== args.machine) return empty;
  const rows = await ctx.db
    .query("edge_prompt_answers")
    .withIndex("by_device_boot_pending", (q) =>
      q
        .eq("owner_user_id", auth.userId)
        .eq("device_id", args.machine)
        .eq("boot", args.boot)
        .eq("finished_at", undefined),
    )
    .take(32);
  for (const row of rows) {
    const opened = await openPrompt(ctx, row, auth.userId);
    if (
      opened?.binding.daemon_boot_id === args.boot &&
      opened.binding.owner_device_id === args.machine
    ) {
      const parsed = command(
        row._id,
        row,
        row.actor_user_id,
        row.answer,
        opened.lease,
      );
      if (parsed.ok && parsed.value.status === "command") return parsed.value;
    }
    await ctx.db.patch(row._id, { finished_at: Date.now() });
  }
  return empty;
}

export async function finishPromptAnswer(
  ctx: MutationCtx,
  args: Device & {
    command_id: string;
    claim?: { session: string; run: number; fencing_token: string };
  },
): Promise<Result> {
  const stale = { v: v1, status: "stale" } as const;
  if (!fencedPromptAnswersEnabled() || !args.claim) return stale;
  const id = ctx.db.normalizeId("edge_prompt_answers", args.command_id);
  const row = id && (await ctx.db.get(id));
  if (
    !row ||
    row.device_id !== args.machine ||
    row.boot !== args.boot ||
    String(row.conversation_id) !== args.claim.session ||
    row.run !== args.claim.run
  )
    return stale;
  const run = await ownedRun(ctx, {
    bearer: args.bearer,
    conversation_id: args.claim.session,
  });
  const lease = await ctx.db.get(row.lease_id);
  if (
    !run ||
    run.binding.owner_user_id !== row.owner_user_id ||
    run.binding.owner_device_id !== args.machine ||
    run.binding.daemon_boot_id !== args.boot ||
    run.binding.epoch !== row.run ||
    !lease ||
    lease.binding_id !== run.binding._id ||
    lease.claim_id !== run.binding.claim_id ||
    lease.boot !== args.boot ||
    lease.released_at !== undefined ||
    lease.expires_at <= Date.now() ||
    lease.fencing_token !== args.claim.fencing_token
  )
    return stale;
  if (row.finished_at !== undefined) return { v: v1, status: "duplicate" };
  await ctx.db.patch(row._id, { finished_at: Date.now() });
  return { v: v1, status: "recorded" };
}
