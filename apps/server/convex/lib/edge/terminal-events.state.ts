import type { CanonicalEvent } from "@codecast/edge-contract";
import type { Doc } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { executionHead } from "../execution-binding.state";

const TERMINAL_PANES_PER_RUN = 128;
const TERMINAL_PANE_RETENTION_MS = 7 * 24 * 60 * 60_000;

type Pane = Doc<"run_terminal_panes">;
type Fields = Pick<
  Pane,
  | "conversation_id"
  | "owner_user_id"
  | "run"
  | "pane_instance"
  | "started"
  | "ended"
>;
type Binding = Pick<
  Doc<"execution_bindings">,
  "conversation_id" | "owner_user_id"
>;

export async function retainTerminalEvents(
  ctx: Pick<MutationCtx, "db">,
  binding: Binding,
  events: readonly CanonicalEvent[],
  now: number,
): Promise<number | undefined> {
  const changes = new Map<string, { old: Pane | null; fields: Fields }>();
  let high = 0;
  for (const event of events) {
    if (event.kind !== "terminal.started" && event.kind !== "terminal.ended")
      continue;
    const { pane_instance } = event.body;
    const run =
      event.kind === "terminal.started" ? event.run : event.body.started_run;
    if (run > event.run) return event.seq;
    const key = `${run}:${pane_instance}`;
    let change = changes.get(key);
    if (!change) {
      const old = await ctx.db
        .query("run_terminal_panes")
        .withIndex("by_conversation_run_pane", (q) =>
          q
            .eq("conversation_id", binding.conversation_id)
            .eq("run", run)
            .eq("pane_instance", pane_instance),
        )
        .unique();
      const fields = {
        conversation_id: binding.conversation_id,
        owner_user_id: binding.owner_user_id,
        run,
        pane_instance,
        started: old?.started,
        ended: old?.ended,
      };
      change = { old, fields };
      changes.set(key, change);
    }
    const { at, seq, source, turn } = event;
    if (event.kind === "terminal.started") {
      if (change.fields.ended) return seq;
      const { actor, tool_call_id } = event.body;
      const old = change.fields.started;
      if (
        old &&
        (old.turn !== turn ||
          old.actor.id !== actor.id ||
          old.actor.kind !== actor.kind ||
          old.tool_call_id !== tool_call_id)
      )
        return seq;
      change.fields.started ??= { at, seq, source, turn, actor, tool_call_id };
    } else {
      change.fields.ended ??= {
        at,
        seq,
        source,
        turn,
        run: event.run,
        outcome: event.body.outcome,
      };
    }
    high = Math.max(high, pane_instance);
  }
  if (!changes.size) return;
  const retain_until = now + TERMINAL_PANE_RETENTION_MS;
  const addedByRun = new Map<number, number>();
  for (const { old, fields } of changes.values()) {
    if (!old) {
      await ctx.db.insert("run_terminal_panes", { ...fields, retain_until });
      addedByRun.set(fields.run, (addedByRun.get(fields.run) ?? 0) + 1);
    } else if (old.started !== fields.started || old.ended !== fields.ended) {
      await ctx.db.patch(old._id, {
        started: fields.started,
        ended: fields.ended,
        retain_until,
      });
    }
  }
  for (const [run, added] of addedByRun) {
    const panes = await ctx.db
      .query("run_terminal_panes")
      .withIndex("by_conversation_run_pane", (q) =>
        q.eq("conversation_id", binding.conversation_id).eq("run", run),
      )
      .order("desc")
      .take(TERMINAL_PANES_PER_RUN + added);
    for (const pane of panes.slice(TERMINAL_PANES_PER_RUN))
      await ctx.db.delete(pane._id);
  }
  const head = await executionHead(ctx, binding.conversation_id);
  if (head && high > (head.last_pane_instance ?? 0))
    await ctx.db.patch(head._id, { last_pane_instance: high });
}
