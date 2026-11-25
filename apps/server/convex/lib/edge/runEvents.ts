import type {
  CanonicalEvent,
  EventsAppendResponse,
} from "@codecast/edge-contract";
import { projectTurn } from "@codecast/session-contract/turn-projection";
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

export async function activateEventRun(ctx: Db, binding: Epoch) {
  const cursor = await eventCursor(ctx, binding.conversation_id, binding.epoch);
  if (cursor) return cursor.last_event_seq;

  const prior =
    binding.epoch > 1
      ? await eventCursor(ctx, binding.conversation_id, binding.epoch - 1)
      : null;
  const base = prior?.last_event_seq ?? 0;
  const fields = runFields(binding);
  await ctx.db.insert("run_event_cursors", { ...fields, last_event_seq: base });
  await ctx.db.insert("run_turn_projections", {
    ...fields,
    status: "active",
    turn_ids: [],
    open_turn: null,
    received_at: Date.now(),
  });
  return base;
}

export async function clearEventTurn(ctx: Db, binding: Epoch) {
  const row = await turnProjection(ctx, binding);
  if (row && row.turn_ids.length > 0)
    await ctx.db.patch(row._id, {
      open_turn: null,
      turn_ids: [],
      received_at: Date.now(),
    });
}

export async function appendRunEvents(
  ctx: Db,
  binding: Doc<"execution_bindings">,
  events: readonly CanonicalEvent[],
  now: number,
): Promise<AppendResult> {
  const session = String(binding.conversation_id);
  const cursor = await eventCursor(ctx, binding.conversation_id, binding.epoch);
  const base =
    cursor?.last_event_seq ??
    (binding.epoch > 1
      ? ((await eventCursor(ctx, binding.conversation_id, binding.epoch - 1))
          ?.last_event_seq ?? 0)
      : 0);
  const suffix = events.filter(({ seq }) => seq > base);
  const first = suffix[0];
  if (!first) return { session, status: "appended", through_seq: base };
  if (first.seq !== base + 1)
    return { session, status: "gap", expected_seq: base + 1 };

  const row = await turnProjection(ctx, binding);
  const before = {
    status: row?.status ?? "active",
    turn_ids: row?.turn_ids ?? [],
    open_turn: row?.open_turn ?? null,
  } as const;
  const state = projectTurn(
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
    suffix,
  );
  const after = {
    status: state.status,
    turn_ids: [...state.turnIds],
    open_turn: state.openTurn && {
      id: state.openTurn.id,
      prompt_ids: [...state.openTurn.promptIds],
    },
  };
  if (!row) {
    await ctx.db.insert("run_turn_projections", {
      ...runFields(binding),
      ...after,
      received_at: now,
    });
  } else if (JSON.stringify(before) !== JSON.stringify(after)) {
    await ctx.db.patch(row._id, { ...after, received_at: now });
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
