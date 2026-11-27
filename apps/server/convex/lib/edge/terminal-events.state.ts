import type { CanonicalEvent } from "@codecast/edge-contract";
import type { Doc } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { executionHead } from "../execution-binding.state";

export const terminalEventsEnabled = () =>
  process.env.CODECAST_EDGE_TERMINAL_EVENTS === "1";

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
  for (const { old, fields } of changes.values()) {
    if (!old) await ctx.db.insert("run_terminal_panes", fields);
    else if (old.started !== fields.started || old.ended !== fields.ended)
      await ctx.db.patch(old._id, {
        started: fields.started,
        ended: fields.ended,
      });
  }
  const head = await executionHead(ctx, binding.conversation_id);
  if (head && high > (head.last_pane_instance ?? 0))
    await ctx.db.patch(head._id, { last_pane_instance: high });
}
