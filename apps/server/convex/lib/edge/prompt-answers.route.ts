import { bindingHasBatonCapability } from "./baton-capabilities.rules";
import {
  EDGE_PROTOCOL_VERSION as v1,
  STEER_BATON_CAPABILITY,
  parseCommandsNextResponse,
  type CommandsNextResponse,
  type CommandsResultResponse,
} from "@codecast/edge-contract";
import { TURN_STARTER_PROJECTION_VERSION } from "@codecast/session-contract/turn-projection";
import { verifyDeviceApiToken } from "@platform/auth/convex";
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { checkConversationAccess } from "../../privacy";
import {
  collaborativePromptAnswersEnabled,
  acceptsRoutineAnswer,
  currentPromptBinding,
  promptAnswerer,
  promptAuthority,
} from "./prompt-authority.rules";
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

async function openPromptTurn(
  ctx: Reader,
  conversation: Doc<"conversations">,
  expected?: { run: number; lease_id?: Id<"run_leases"> },
) {
  const current = await currentPromptBinding(ctx, conversation, expected?.run);
  if (!current) return null;
  const { head, binding, claimId } = current;
  const { conversation_id, epoch: run } = binding;
  const [lease, projection] = await Promise.all([
    expected?.lease_id
      ? ctx.db.get(expected.lease_id)
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
  const now = Date.now();
  if (
    !lease ||
    !isFreshTurnProjection(binding, lease, projection, now) ||
    !projection?.open_turn
  )
    return null;
  return {
    conversation,
    binding,
    lease,
    lease_remaining_ms: lease.expires_at - now,
    projectionVersion: projection.projection_version,
    turn: projection.open_turn,
    admitting:
      head.admission_epoch === undefined || head.admission_epoch === run,
  };
}

async function openPrompt(
  ctx: Reader,
  position: PromptTarget & { lease_id?: Id<"run_leases"> },
  owner?: Id<"users">,
) {
  const conversation = await ctx.db.get(position.conversation_id);
  if (!conversation || (owner !== undefined && conversation.user_id !== owner))
    return null;
  const opened = await openPromptTurn(ctx, conversation, position);
  return opened?.turn.id === position.turn_id &&
    opened.turn.prompt_ids.includes(position.prompt_id)
    ? opened
    : null;
}

function recordedAnswer(ctx: Reader, position: PromptPosition) {
  const { conversation_id, run, lease_id, turn_id, prompt_id } = position;
  return ctx.db
    .query("edge_prompt_answers")
    .withIndex("by_conversation_prompt", (q) =>
      q
        .eq("conversation_id", conversation_id)
        .eq("run", run)
        .eq("lease_id", lease_id)
        .eq("turn_id", turn_id)
        .eq("prompt_id", prompt_id),
    )
    .first();
}

type Opened = NonNullable<Awaited<ReturnType<typeof openPromptTurn>>>;

async function promptAccess(ctx: Reader, opened: Opened, promptId: string) {
  const authority = await promptAuthority(ctx, opened);
  const prompt = opened.turn.prompt_details?.find(
    ({ prompt_id }) => prompt_id === promptId,
  );
  return {
    answerer: authority
      ? promptAnswerer(authority, prompt)
      : opened.conversation.user_id,
    accepts: (answer: Doc<"edge_prompt_answers">["answer"]) =>
      !authority || acceptsRoutineAnswer(prompt, answer),
  };
}

export async function promptAddress(
  ctx: Reader,
  target: PromptTarget,
  actor: Id<"users">,
) {
  if (!fencedPromptAnswersEnabled()) return null;
  const opened = await openPrompt(
    ctx,
    target,
    collaborativePromptAnswersEnabled() ? undefined : actor,
  );
  if (
    !opened ||
    (await promptAccess(ctx, opened, target.prompt_id)).answerer !== actor
  )
    return null;
  const position = { ...target, lease_id: opened.lease._id };
  return (await recordedAnswer(ctx, position)) ? null : position;
}

function answererName(
  ctx: Reader,
  names: Map<Id<"users">, Promise<string | undefined>>,
  id: Id<"users">,
) {
  const name =
    names.get(id) ??
    ctx.db.get(id).then((user) => user?.name?.trim() || undefined);
  names.set(id, name);
  return name;
}

export async function answerablePromptAddresses(
  ctx: Reader,
  conversationId: Id<"conversations">,
  actor: Id<"users"> | null,
  maySteer: boolean,
) {
  if (!actor) return { prompts: [], turn: null };
  const conversation = await ctx.db.get(conversationId);
  if (conversation?.execution_protocol_state !== "fenced")
    return { prompts: [], turn: null };
  const mayAnswer = fencedPromptAnswersEnabled();
  if (
    (!mayAnswer && !maySteer) ||
    (conversation.user_id !== actor &&
      (!mayAnswer || !collaborativePromptAnswersEnabled()))
  )
    return { prompts: [], turn: null };
  const opened = await openPromptTurn(ctx, conversation);
  if (!opened) return { prompts: [], turn: null };
  const authority = mayAnswer ? await promptAuthority(ctx, opened) : null;
  if (
    conversation.user_id !== actor &&
    (!authority ||
      (await checkConversationAccess(ctx, actor, conversation)) === "denied")
  )
    return { prompts: [], turn: null };
  const {
    binding,
    lease,
    turn,
    admitting,
    projectionVersion,
    lease_remaining_ms,
  } = opened;
  const conversation_id = conversation._id;
  const candidates = (mayAnswer ? (turn.prompt_details ?? []) : []).filter(
    ({ kind, prompt_id, questions }) =>
      turn.prompt_ids.includes(prompt_id) &&
      (kind === "permission" || questions !== undefined),
  );
  const names = new Map<Id<"users">, Promise<string | undefined>>();
  const addresses = await Promise.all(
    candidates.map(async (prompt) => {
      const position = {
        conversation_id,
        run: binding.epoch,
        lease_id: lease._id,
        turn_id: turn.id,
        prompt_id: prompt.prompt_id,
      };
      if (await recordedAnswer(ctx, position)) return null;
      const user = authority ? promptAnswerer(authority, prompt) : undefined;
      const answerer =
        user && authority
          ? {
              can_answer: user === actor,
              name:
                (await answererName(ctx, names, user)) ??
                (user === authority.owner ? "Session owner" : "Baton holder"),
            }
          : undefined;
      return {
        ...position,
        _id: JSON.stringify([lease._id, turn.id, prompt.prompt_id]),
        kind: prompt.kind,
        ...(prompt.tool_call_id ? { tool_call_id: prompt.tool_call_id } : {}),
        questions: prompt.questions ?? [],
        ...(answerer && { answerer }),
      };
    }),
  );
  const prompts = addresses.filter((address) => address !== null);
  const observed_turn =
    maySteer &&
    conversation.user_id === actor &&
    admitting &&
    projectionVersion === TURN_STARTER_PROJECTION_VERSION &&
    bindingHasBatonCapability(binding, STEER_BATON_CAPABILITY) &&
    turn.starter &&
    turn.start_event_seq !== undefined
      ? {
          id: turn.id,
          run: binding.epoch,
          start_event_seq: turn.start_event_seq,
        }
      : undefined;
  return {
    prompts,
    turn: observed_turn
      ? { _id: conversation_id, observed_turn, lease_remaining_ms }
      : null,
  };
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
  const opened = await openPrompt(
    ctx,
    position,
    collaborativePromptAnswersEnabled() ? undefined : actor,
  );
  const access =
    opened && (await promptAccess(ctx, opened, position.prompt_id));
  if (!opened || access?.answerer !== actor)
    throw new ConvexError("STALE_OR_UNAUTHORIZED_PROMPT");
  if (await recordedAnswer(ctx, position))
    throw new ConvexError("PROMPT_ALREADY_ANSWERED");
  if (!access.accepts(answer)) throw new ConvexError("INVALID_PROMPT_ANSWER");
  const parsed = command("pending", position, actor, answer, opened.lease);
  if (!parsed.ok || JSON.stringify(answer).length > 16_384)
    throw new ConvexError("INVALID_PROMPT_ANSWER");
  return ctx.db.insert("edge_prompt_answers", {
    ...position,
    owner_user_id: opened.conversation.user_id,
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

export type FencedPromptState = {
  run: number;
  leaseId: Id<"run_leases">;
  hasOpenTurn: boolean;
  openPrompt: { kind: "question" | "permission"; prompt_id: string } | null;
  allOpenTurnPromptsAnswered: boolean;
  isAnswered: (turnId: string, promptId: string) => Promise<boolean>;
};

export async function readFencedPromptState(
  ctx: Reader,
  conversation: Doc<"conversations">,
): Promise<FencedPromptState | null> {
  const opened = await openPromptTurn(ctx, conversation);
  const current = opened
    ? { binding: opened.binding, lease: opened.lease }
    : await (async () => {
        const bound = await currentPromptBinding(ctx, conversation);
        if (!bound) return null;
        const lease = await ctx.db
          .query("run_leases")
          .withIndex("by_conversation_claim", (q) =>
            q
              .eq("conversation_id", conversation._id)
              .eq("claim_id", bound.claimId),
          )
          .unique();
        return lease ? { binding: bound.binding, lease } : null;
      })();
  if (!current) return null;

  const { binding, lease } = current;
  const isAnswered = async (turnId: string, promptId: string) =>
    Boolean(
      await recordedAnswer(ctx, {
        conversation_id: conversation._id,
        run: binding.epoch,
        lease_id: lease._id,
        turn_id: turnId,
        prompt_id: promptId,
      }),
    );

  if (!opened || opened.turn.prompt_ids.length === 0) {
    return {
      run: binding.epoch,
      leaseId: lease._id,
      hasOpenTurn: Boolean(opened),
      openPrompt: null,
      allOpenTurnPromptsAnswered: false,
      isAnswered,
    };
  }

  const details = new Map(
    (opened.turn.prompt_details ?? []).map((detail) => [
      detail.prompt_id,
      detail,
    ]),
  );
  let openPrompt: {
    kind: "question" | "permission";
    prompt_id: string;
  } | null = null;
  for (const promptId of opened.turn.prompt_ids) {
    if (await isAnswered(opened.turn.id, promptId)) continue;
    const detail = details.get(promptId);
    openPrompt = {
      kind: detail?.kind ?? "question",
      prompt_id: promptId,
    };
    break;
  }

  return {
    run: binding.epoch,
    leaseId: lease._id,
    hasOpenTurn: true,
    openPrompt,
    allOpenTurnPromptsAnswered: openPrompt === null,
    isAnswered,
  };
}
