import { bindingHasBatonCapability } from "./baton-capabilities.rules";
import { STEER_BATON_CAPABILITY } from "@codecast/edge-contract";
import { TURN_STARTER_PROJECTION_VERSION } from "@codecast/session-contract/turn-projection";
import type { Doc, Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { isConversationSafetyBlocked } from "../../conversationSafety";
import { redactSecrets } from "../../redact";
import { canSendProductMessage } from "../../pendingMessages";
import { findClaim } from "../claims";

type Turn = NonNullable<Doc<"run_turn_projections">["open_turn"]>;
type Prompt = NonNullable<Turn["prompt_details"]>[number];
type OpenedPrompt = {
  conversation: Doc<"conversations">;
  binding: Doc<"execution_bindings">;
  projectionVersion: Doc<"run_turn_projections">["projection_version"];
  turn: Turn;
};

export function collaborativePromptAnswersEnabled() {
  return process.env.SWARM_TURN_BATON === "1";
}

export async function currentPromptBinding(
  ctx: Pick<QueryCtx, "db">,
  conversation: Doc<"conversations">,
  expectedRun?: number,
) {
  const { _id: conversation_id, user_id: owner } = conversation;
  if (
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
    head.current_epoch === undefined ||
    (expectedRun !== undefined && head.current_epoch !== expectedRun) ||
    head.device_move !== undefined
  )
    return null;
  const run = head.current_epoch;
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
  return { head, binding, claimId: binding.claim_id };
}

function supportsPromptBaton(binding: Doc<"execution_bindings"> | undefined) {
  return bindingHasBatonCapability(binding, STEER_BATON_CAPABILITY);
}

export async function sharedPromptPermissionsEnabled(
  ctx: Pick<QueryCtx, "db">,
  conversation: Doc<"conversations">,
) {
  if (!collaborativePromptAnswersEnabled()) return false;
  return supportsPromptBaton(
    (await currentPromptBinding(ctx, conversation))?.binding,
  );
}

export async function promptAuthority(
  ctx: Pick<QueryCtx, "db">,
  opened: OpenedPrompt,
) {
  const { conversation, binding, projectionVersion, turn } = opened;
  if (!collaborativePromptAnswersEnabled() || !supportsPromptBaton(binding))
    return null;
  const owner = conversation.user_id;
  let holder: Id<"users"> | null = null;
  if (projectionVersion === TURN_STARTER_PROJECTION_VERSION) {
    const claim = await findClaim(ctx.db, {
      id: conversation._id,
      kind: "steer",
    });
    const implied =
      !turn.baton_converted && turn.starter?.kind === "person"
        ? ctx.db.normalizeId("users", turn.starter.id)
        : null;
    const current =
      claim?.holder && claim.lease_until > Date.now() ? claim.holder : implied;
    if (current && (await canSendProductMessage(ctx, current, conversation)))
      holder = current;
  }
  return { owner, holder };
}

function isRoutineQuestion(
  prompt: Prompt | undefined,
): prompt is Prompt & { questions: NonNullable<Prompt["questions"]> } {
  return (
    prompt?.kind === "question" &&
    prompt.routine_question === true &&
    !!prompt.questions?.length &&
    prompt.questions.every(({ is_secret }) => !is_secret)
  );
}

export function acceptsRoutineAnswer(
  prompt: Prompt | undefined,
  answer: Doc<"edge_prompt_answers">["answer"],
) {
  if (!isRoutineQuestion(prompt) || answer === null) return true;
  if (typeof answer !== "object" || !("answers" in answer)) return false;
  const questionIds = new Set(prompt.questions.map(({ id }) => id));
  return Object.keys(answer.answers).every((id) => questionIds.has(id));
}

export function promptAnswerer(
  authority: NonNullable<Awaited<ReturnType<typeof promptAuthority>>>,
  prompt: Prompt | undefined,
) {
  return isRoutineQuestion(prompt)
    ? (authority.holder ?? authority.owner)
    : authority.owner;
}

export function sharedPermissionRows(
  permissions: Doc<"pending_permissions">[],
  proposer: boolean,
  fenced: boolean,
) {
  return permissions
    .filter((permission) => proposer || (fenced && permission.fenced_prompt_id))
    .map((permission) => ({
      _id: permission._id,
      _creationTime: permission._creationTime,
      conversation_id: permission.conversation_id,
      session_id: permission.session_id,
      tool_name: permission.tool_name,
      arguments_preview: proposer
        ? redactSecrets(permission.arguments_preview)
        : "",
      status: permission.status,
      created_at: permission.created_at,
      ...(fenced &&
        permission.fenced_prompt_id && {
          fenced_prompt_id: permission.fenced_prompt_id,
          fenced_prompt_turn_id: permission.fenced_prompt_turn_id,
        }),
    }));
}
