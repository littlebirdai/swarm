import type {
  CanonicalEvent,
  EdgeJson,
  EventsAppendResponse,
} from "@codecast/edge-contract";
import {
  projectTurn,
  TURN_PROJECTION_VERSION,
  type TurnProjection,
} from "@codecast/session-contract/turn-projection";
import { convexToJson } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";

type Db = Pick<MutationCtx, "db">;
type Epoch = Pick<
  Doc<"execution_bindings">,
  "_id" | "conversation_id" | "owner_user_id" | "epoch"
>;
export type AppendResult = Extract<
  EventsAppendResponse,
  { results: unknown }
>["results"][number];

function eventCursor(ctx: Db, conversation: Id<"conversations">, run: number) {
  return ctx.db
    .query("run_event_cursors")
    .withIndex("by_conversation_run", (q) =>
      q.eq("conversation_id", conversation).eq("run", run),
    )
    .unique();
}

async function previousEventSeq(ctx: Db, binding: Epoch) {
  const prior = await ctx.db
    .query("run_event_cursors")
    .withIndex("by_conversation_run", (q) =>
      q.eq("conversation_id", binding.conversation_id).lt("run", binding.epoch),
    )
    .order("desc")
    .first();
  return prior?.last_event_seq ?? 0;
}

function turnProjection(ctx: Db, binding: Epoch) {
  return ctx.db
    .query("run_turn_projections")
    .withIndex("by_conversation_run", (q) =>
      q.eq("conversation_id", binding.conversation_id).eq("run", binding.epoch),
    )
    .unique();
}

function runFields(binding: Epoch) {
  return {
    conversation_id: binding.conversation_id,
    owner_user_id: binding.owner_user_id,
    binding_id: binding._id,
    run: binding.epoch,
  };
}

export async function seedEventRun(
  ctx: Db,
  binding: Id<"execution_bindings">,
  conversation: Pick<Doc<"conversations">, "_id" | "user_id">,
  epoch: number,
  now: number,
) {
  if (process.env.CODECAST_EDGE_DELIVERY_V1 === "1")
    await activateEventRun(
      ctx,
      {
        _id: binding,
        conversation_id: conversation._id,
        owner_user_id: conversation.user_id,
        epoch,
      },
      now,
    );
}

export async function activateEventRun(ctx: Db, binding: Epoch, now: number) {
  const cursor = await eventCursor(ctx, binding.conversation_id, binding.epoch);
  if (cursor) return cursor.last_event_seq;

  const base = await previousEventSeq(ctx, binding);
  const fields = runFields(binding);
  await ctx.db.insert("run_event_cursors", { ...fields, last_event_seq: base });
  await ctx.db.insert("run_turn_projections", {
    ...fields,
    status: "active",
    projection_version: TURN_PROJECTION_VERSION,
    turn_ids: [],
    open_turn: null,
    received_at: now,
  });
  return base;
}

export async function clearEventTurn(
  ctx: Db,
  binding: Epoch,
  now: number,
  bootReset = false,
) {
  const row = await turnProjection(ctx, binding);
  if (
    row &&
    (row.turn_ids.length > 0 ||
      (bootReset && row.projection_version !== TURN_PROJECTION_VERSION))
  )
    await ctx.db.patch(row._id, {
      open_turn: null,
      turn_ids: [],
      received_at: now,
      ...(bootReset ? { projection_version: TURN_PROJECTION_VERSION } : {}),
    });
}

type OpenTurn = NonNullable<Doc<"run_turn_projections">["open_turn"]>;
type PromptDetails = NonNullable<OpenTurn["prompt_details"]>[number];
const MAX_QUESTIONS_PER_PROMPT = 32;
const MAX_QUESTION_ID_LENGTH = 256;
const MAX_PROMPT_DETAILS_BYTES = 32_768;

function questionDetails(value: EdgeJson): PromptDetails["questions"] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_QUESTIONS_PER_PROMPT
  )
    return;
  const questions: NonNullable<PromptDetails["questions"]> = [];
  const ids = new Set<string>();
  for (const question of value) {
    if (
      !question ||
      typeof question !== "object" ||
      Array.isArray(question) ||
      typeof question.id !== "string" ||
      question.id.length > MAX_QUESTION_ID_LENGTH ||
      !question.id.trim() ||
      typeof question.is_secret !== "boolean" ||
      ids.has(question.id)
    )
      return;
    ids.add(question.id);
    questions.push({ id: question.id, is_secret: question.is_secret });
  }
  if (new TextEncoder().encode(JSON.stringify(questions)).length <= 16_384)
    return questions;
}

function projectPromptTurn(
  initial: TurnProjection,
  previousDetails: readonly PromptDetails[],
  events: readonly CanonicalEvent[],
) {
  let state = initial;
  const details = new Map(
    previousDetails.map((prompt) => [prompt.prompt_id, prompt]),
  );
  const setDetails = (prompt: PromptDetails) => {
    const proposed = new Map(details).set(prompt.prompt_id, prompt);
    const bytes = new TextEncoder().encode(
      JSON.stringify([...proposed.values()]),
    );
    if (bytes.length <= MAX_PROMPT_DETAILS_BYTES)
      details.set(prompt.prompt_id, prompt);
  };
  for (const event of events) {
    const before = state.openTurn;
    switch (event.kind) {
      case "context": {
        const { data } = event.body;
        if (
          !before ||
          before.id !== event.turn ||
          !data ||
          typeof data !== "object" ||
          Array.isArray(data) ||
          typeof data.prompt_id !== "string"
        )
          break;
        const prompt = details.get(data.prompt_id);
        if (prompt?.kind !== "question" || prompt.questions) break;
        const questions = questionDetails(data.questions);
        if (questions) setDetails({ ...prompt, questions });
        break;
      }
      case "session.started":
      case "session.ended":
      case "turn.started":
      case "turn.ended":
      case "prompt.opened":
      case "prompt.settled": {
        state = projectTurn(state, [event]);
        const after = state.openTurn;
        if (before?.id !== after?.id) details.clear();
        if (event.kind === "prompt.opened") {
          const { prompt_id, kind, tool_call_id } = event.body;
          if (
            (kind === "question" || kind === "permission") &&
            !before?.promptIds.includes(prompt_id) &&
            after?.promptIds.includes(prompt_id)
          )
            setDetails({
              prompt_id,
              kind,
              ...(tool_call_id ? { tool_call_id } : {}),
            });
        } else if (
          event.kind === "prompt.settled" &&
          !after?.promptIds.includes(event.body.prompt_id)
        ) {
          details.delete(event.body.prompt_id);
        }
        break;
      }
    }
  }
  const promptDetails = [...details.values()];
  return {
    status: state.status,
    turn_ids: [...state.turnIds],
    open_turn: state.openTurn && {
      id: state.openTurn.id,
      prompt_ids: [...state.openTurn.promptIds],
      ...(promptDetails.length ? { prompt_details: promptDetails } : {}),
    },
  };
}

export async function appendRunEvents(
  ctx: Db,
  binding: Doc<"execution_bindings">,
  events: readonly CanonicalEvent[],
  now: number,
): Promise<AppendResult> {
  const session = String(binding.conversation_id);
  const cursor = await eventCursor(ctx, binding.conversation_id, binding.epoch);
  const base = cursor?.last_event_seq ?? (await previousEventSeq(ctx, binding));
  const suffix = events.filter(({ seq }) => seq > base);
  const first = suffix[0];
  if (!first) return { session, status: "appended", through_seq: base };
  if (first.seq !== base + 1)
    return { session, status: "gap", expected_seq: base + 1 };

  const row = await turnProjection(ctx, binding);
  if (!row || row.projection_version === TURN_PROJECTION_VERSION) {
    const before = {
      status: row?.status ?? "active",
      turn_ids: row?.turn_ids ?? [],
      open_turn: row?.open_turn ?? null,
    } as const;
    const after = projectPromptTurn(
      {
        session,
        run: binding.epoch,
        status: before.status,
        eventSeq: base,
        turnIds: before.turn_ids,
        openTurn: before.open_turn && {
          id: before.open_turn.id,
          promptIds: before.open_turn.prompt_ids,
        },
      },
      before.open_turn?.prompt_details ?? [],
      suffix,
    );
    if (!row) {
      await ctx.db.insert("run_turn_projections", {
        ...runFields(binding),
        ...after,
        projection_version: TURN_PROJECTION_VERSION,
        received_at: now,
      });
    } else if (
      JSON.stringify(convexToJson(before)) !==
      JSON.stringify(convexToJson(after))
    ) {
      await ctx.db.patch(row._id, { ...after, received_at: now });
    }
  }

  const through_seq = suffix.at(-1)!.seq;
  if (cursor) await ctx.db.patch(cursor._id, { last_event_seq: through_seq });
  else
    await ctx.db.insert("run_event_cursors", {
      ...runFields(binding),
      last_event_seq: through_seq,
    });

  return { session, status: "appended", through_seq };
}
