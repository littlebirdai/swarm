import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { internal } from "../_generated/api";
import {
  armedTriggerKindFor,
  armedTriggerKindOf,
  type ArmedTriggerKind,
} from "../dormancy";
import { internalMutation } from "../functions";
import { runParentOf } from "@codecast/triggers/triggerLifecycle";
import { hostedHomeStamp } from "../assistant/routines";
import { nextCadenceRun } from "@platform/assistant/cadence";
import { getDocumentSize, v } from "convex/values";
export const RETIRED_TRIGGER_HOME = Symbol();
export type TaskCtx = {
  db: any;
  [RETIRED_TRIGGER_HOME]?: Id<"conversations">;
  scheduler?: {
    runAfter: (delayMs: number, fn: any, args: any) => Promise<unknown>;
  };
};
export async function refreshArmedTriggerKind(
  ctx: TaskCtx,
  conversationId: Id<"conversations">,
): Promise<void> {
  const tasks = await tasksOriginatedBy(ctx, conversationId);
  const conv = await ctx.db.get(conversationId);
  await writeArmedTriggerKind(ctx, conv, armedTriggerKindFor(tasks));
  for await (const { row, state } of activeCancellations(
    ctx.db,
    conversationId,
  )) {
    const boundary = state.seenThrough;
    if (boundary === null) continue;
    const kind = armedTriggerKindFor(
      tasks.filter((task) => task._creationTime <= boundary),
    );
    if (kind !== state.kind) await writeSweep(ctx, row._id, { ...state, kind });
  }
}
export async function writeArmedTriggerKind(
  ctx: TaskCtx,
  conv: Doc<"conversations"> | null,
  kind: ArmedTriggerKind,
): Promise<void> {
  if (!conv) return;
  if ((conv.armed_trigger_kind ?? "none") === kind) return;
  await ctx.db.patch(conv._id, { armed_trigger_kind: kind });
}
type TriggerRestamp = (task: Doc<"agent_tasks">) => Promise<void>;
export async function patchTask(
  ctx: TaskCtx,
  task: Doc<"agent_tasks">,
  patch: Record<string, any>,
  restamp?: TriggerRestamp,
) {
  if ("originating_conversation_id" in patch) {
    patch = {
      ...patch,
      hosted_home: await hostedHomeStamp(
        ctx,
        patch.originating_conversation_id,
      ),
    };
  }
  await ctx.db.patch(task._id, patch);
  if (restamp) await restamp(task);
  else if (task.originating_conversation_id)
    await refreshArmedTriggerKind(ctx, task.originating_conversation_id);
  const next = { ...task, ...patch };
  if (("run_at" in patch || "status" in patch) && next.status === "scheduled")
    await scheduleProjectFire(ctx, next, next.run_at);
}

/** A project trigger whose runs are turns in the project's main session: the
 *  server fires it (projectSources.fireProjectTrigger), never a daemon. */
export function projectRunsInline(
  task: Pick<Doc<"agent_tasks">, "project_id" | "project_spawn">,
): boolean {
  return !!task.project_id && !task.project_spawn;
}

/** Wake the server firing for an inline project trigger at its run_at. Every
 *  arming path reaches it (patchTask, insertTask, matchTaskTriggers); the
 *  firing reads the row again, so an outrun wake does nothing. */
export async function scheduleProjectFire(
  ctx: TaskCtx,
  task: Pick<Doc<"agent_tasks">, "_id" | "project_id" | "project_spawn">,
  runAt: number | undefined,
): Promise<void> {
  if (!projectRunsInline(task) || runAt === undefined || !ctx.scheduler) return;
  await ctx.scheduler.runAfter(
    Math.max(0, runAt - Date.now()),
    internal.projectSources.fireProjectTrigger,
    { task_id: task._id },
  );
}

// A recurring trigger keeps a cadence: slots one interval apart. run_at is when
// the daemon may next claim the row, and it leaves the cadence for a manual
// run, a retry or a limit park. Those writes go through here, which keeps the
// slot the trigger was armed for, so the arming after the run
// (nextArmingAfterRun) returns to the cadence instead of restarting it from
// wherever the detour ended.
// The first cadence slot after `after`: on the wall clock when the routine
// keeps one (hostedWallCadence), else one interval on.
export function nextRecurringRun(
  task: Pick<Doc<"agent_tasks">, "interval_ms"> &
    Partial<Pick<Doc<"agent_tasks">, "cadence">>,
  after: number,
): number {
  return task.cadence
    ? nextCadenceRun(task.cadence, after)
    : after + (task.interval_ms ?? 0);
}

// Re-arm a retired schedule. Exists for the hide-gesture affordance: killing a
// session cancels its injecting schedules as a side effect (see
// cancelTasksBoundToConversation), and both the "Keep schedule" toast action
// and undo-of-hide need to reverse exactly that side effect. Also revives a
// failed schedule. Recurring re-arms one interval out (not an immediate fire);
// a once-task keeps its future run_at or re-arms a minute out.
export async function applyReactivate(ctx: TaskCtx, task: Doc<"agent_tasks">) {
  if (task.status !== "completed" && task.status !== "failed") return false;
  await patchTask(ctx, task, {
    status: "scheduled",
    canceled_on_kill_at: undefined,
    requested_run_source: undefined,
    // A revived schedule starts fresh: its first firing is not a retry of
    // the dead one (triggerFiringContinues), carries none of its message, and
    // its gate asks again from nothing (a change the dead run never acted on
    // must not read as "unchanged").
    retry_count: 0,
    // Nor is it failing: the dead run stops being its last word (ct-95585).
    last_run_failed: false,
    failed_slots: undefined,
    precheck_message: undefined,
    precheck_state: undefined,
    cadence_slot_at: undefined,
    run_at:
      task.schedule_type === "event"
        ? undefined
        : task.schedule_type === "recurring" && task.interval_ms
          ? nextRecurringRun(task, Date.now())
          : task.run_at && task.run_at > Date.now()
            ? task.run_at
            : Date.now() + 60_000,
  });
  return true;
}

// Resolve a spawned run's conversation (session_id IS the uuid the daemon
// assigned via `claude --session-id`) and stamp agent_task_id on it, so the run
// stays attributable to its schedule forever — not just while it's the latest.
// A spawned run nests under the session that armed it (runParentOf) as a
// subagent row, the same shape `cast spawn --subagent` makes, so it never
// surfaces as a loose inbox card nobody owns. The daemon stamps both
// at birth (createConversation agent_task_id + parent_conversation_id); this
// is the backfill for rows born without them. Idempotent; returns the
// conversation, or null if it hasn't synced yet.
export async function stampRunConversation(
  ctx: TaskCtx,
  userId: Id<"users">,
  task: Doc<"agent_tasks">,
  runSessionUuid: string,
  opts: { backfill?: boolean } = {},
): Promise<Doc<"conversations"> | null> {
  const conv = await ctx.db
    .query("conversations")
    .withIndex("by_session_id", (q: any) => q.eq("session_id", runSessionUuid))
    .filter((q: any) => q.eq(q.field("user_id"), userId))
    .first();
  if (!conv) return null;
  const patch: Record<string, any> = {};
  const firstStamp = conv.agent_task_id !== task._id;
  if (firstStamp) patch.agent_task_id = task._id;
  // A run is never a loose inbox card. It nests under the session that armed
  // it (runParentOf: every spawn schedule, repeating included) whatever that
  // session's inbox state, a stashed parent or a subagent worker included: the
  // outcomes a person must see wake the parent (runOwnerWakeOf), and a wake
  // brings a stashed or killed parent back, so hiding the run loses nothing.
  // A repeating run with no parent to nest under is born stashed instead, and
  // surfaces only for those same outcomes (wakeRunOwner). A once run with no
  // parent stays a card: its single result is the deliverable. Only the first
  // stamp hides, so a run the user brought back stays back; the backfill
  // (nestLooseTriggerRuns) applies the rule to runs stamped before it existed.
  // A run blocked on the human is an open ask and is never hidden.
  if (!conv.parent_conversation_id) {
    const parent = runParentOf(task);
    const parentConv =
      parent && parent.toString() !== conv._id.toString()
        ? await ctx.db.get(parent)
        : null;
    if (parentConv && parentConv.user_id.toString() === userId.toString()) {
      patch.parent_conversation_id = parent;
      patch.is_subagent = true;
    } else if (
      (firstStamp || opts.backfill) &&
      task.schedule_type !== "once" &&
      !conv.inbox_stashed_at &&
      !conv.inbox_pinned_at &&
      conv.thread_state_status !== "blocked"
    ) {
      patch.inbox_stashed_at = Date.now();
    }
  }
  if (Object.keys(patch).length > 0) {
    await ctx.db.patch(conv._id, patch);
    Object.assign(conv, patch);
  }
  return conv;
}

// Kill is the strongest triage gesture — "make this stop". Any armed schedule
// that INJECTS into the killed conversation (originating_conversation_id, the
// `--context current` kind) would resurrect it on its next fire — the
// scheduler's injection un-kills the session for delivery — silently defeating
// the kill. So killSession cancels those schedules in the same transaction.
// Schedules that merely post summaries to the conversation
// (target_conversation_id) never wake it, and spawn-type schedules whose RUN
// was killed are untouched: each run is its own session, and killing one run
// doesn't mean "stop the program" — the schedule strip on the run gives the
// user that verb explicitly.
export async function cancelTasksBoundToConversation(
  ctx: TaskCtx,
  userId: Id<"users">,
  conversationId: Id<"conversations">,
): Promise<number> {
  if (ctx[RETIRED_TRIGGER_HOME] === conversationId) return 0;
  let cancelled = 0;
  for (const task of await runnerTasksOriginatedBy(
    ctx,
    userId,
    conversationId,
  )) {
    if (
      task.status !== "scheduled" &&
      task.status !== "running" &&
      task.status !== "paused"
    )
      continue;
    // Stamp WHY it completed: a restore of the killed session re-arms exactly
    // the schedules this kill took down (reactivateTasksCanceledOnKill),
    // without touching schedules that ran to natural completion.
    await patchTask(ctx, task, {
      status: "completed",
      canceled_on_kill_at: Date.now(),
    });
    cancelled++;
  }
  return cancelled;
}
export async function tasksOriginatedBy(
  ctx: TaskCtx,
  conversationId: Id<"conversations">,
): Promise<Doc<"agent_tasks">[]> {
  return await triggersForConversation(ctx.db, conversationId).collect();
}
function triggersForConversation(
  db: DatabaseReader,
  conversationId: Id<"conversations">,
) {
  return db
    .query("agent_tasks")
    .withIndex("by_originating_conversation", (q) =>
      q.eq("originating_conversation_id", conversationId),
    );
}
export async function runnerTasksOriginatedBy(
  ctx: TaskCtx,
  userId: Id<"users">,
  conversationId: Id<"conversations">,
) {
  return (await tasksOriginatedBy(ctx, conversationId)).filter(
    (task) => task.user_id.toString() === userId.toString(),
  );
}
export async function roleSeatOf(
  ctx: TaskCtx,
  roleId: Id<"org_roles"> | undefined,
): Promise<Doc<"conversations"> | null> {
  const seat = await roleSeatId(ctx, roleId);
  return seat ? await ctx.db.get(seat) : null;
}
async function roleSeatId(
  ctx: TaskCtx,
  roleId: Id<"org_roles"> | undefined,
): Promise<Id<"conversations"> | null> {
  const role = roleId ? await ctx.db.get(roleId) : null;
  if (role?.status === "retired") return null;
  const anchor = role?.anchor_id ? await ctx.db.get(role.anchor_id) : null;
  return anchor?.conversation_id ?? null;
}
export async function roleTriggerRunnerOf(
  ctx: TaskCtx,
  task: Pick<
    Doc<"agent_tasks">,
    "role_id" | "user_id" | "originating_conversation_id"
  >,
): Promise<Id<"users"> | null> {
  const seat = await seatOfRoleTrigger(ctx, task);
  return seat && String(seat.user_id) !== String(task.user_id)
    ? seat.user_id
    : null;
}
export async function seatOfRoleTrigger(
  ctx: TaskCtx,
  task: Pick<Doc<"agent_tasks">, "role_id" | "originating_conversation_id">,
): Promise<Doc<"conversations"> | null> {
  if (!task.role_id || !task.originating_conversation_id) return null;
  const seat = await roleSeatOf(ctx, task.role_id);
  return seat && String(seat._id) === String(task.originating_conversation_id)
    ? seat
    : null;
}

/** The one account that may change what a trigger runs or where (its
 *  precheck, home, prompt, agent, checkout, permissions): for a role trigger
 *  on its seat the account running the seat, which is whose daemon claims it
 *  next (roleTriggerRunnerOf hands it over at the claim, before any precheck
 *  runs), even while the row still names a stale owner; for every other
 *  trigger its owner. Nobody else picks what runs on someone's machine. */
export async function rewriterOf(
  ctx: TaskCtx,
  task: Pick<
    Doc<"agent_tasks">,
    "role_id" | "user_id" | "originating_conversation_id"
  >,
): Promise<{ userId: Id<"users">; seat: boolean }> {
  const seat = await seatOfRoleTrigger(ctx, task);
  return seat
    ? { userId: seat.user_id, seat: true }
    : { userId: task.user_id, seat: false };
}
const HANDOFF_PAGE_ROWS = 128;
const HANDOFF_PAGE_BYTES = 1_000_000;
const HANDOFF_KIND_ROWS = 4096;
const HANDOFF_KIND_BYTES = 4_000_000;
async function smallTriggerSet(db: DatabaseReader, seat: Id<"conversations">) {
  const tasks: Doc<"agent_tasks">[] = [];
  let bytes = 0;
  for await (const task of triggersForConversation(db, seat)) {
    tasks.push(task);
    bytes += getDocumentSize(task);
    if (tasks.length >= HANDOFF_PAGE_ROWS || bytes >= HANDOFF_PAGE_BYTES)
      return null;
  }
  return tasks;
}
export async function handRoleTriggersToRunner(
  ctx: TaskCtx,
  conversationId: Id<"conversations">,
  repairAll = false,
): Promise<number> {
  const seat: Doc<"conversations"> | null = await ctx.db.get(conversationId);
  return seat ? handRoleTriggersForSeat(ctx, seat, repairAll) : 0;
}
export async function handClaimedRoleTriggerToRunner(
  ctx: TaskCtx,
  task: Doc<"agent_tasks">,
): Promise<boolean> {
  const home = task.originating_conversation_id;
  if (home) {
    for await (const { row, state } of activeCancellations(ctx.db, home)) {
      if (shouldCancelForRetirement(task, state, row._creationTime))
        return true;
    }
  }
  const seat = await seatOfRoleTrigger(ctx, task);
  if (!seat || seat.user_id === task.user_id) return false;
  await ctx.db.patch(task._id, { user_id: seat.user_id });
  await handRoleTriggersForSeat(ctx, seat, true);
  return true;
}
type RoleHandoff = {
  jobId: Id<"_scheduled_functions">;
  runner: Id<"users">;
  claimed: boolean;
  started: boolean;
  cursor?: string | null;
};
const sweepKey = (seat: Id<"conversations">, kind = "handoff") =>
  `role-trigger-${kind}:${seat}`;
function scheduledSweep(db: DatabaseReader, key: string) {
  return db
    .query("system_config")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
}
async function* activeCancellations(
  db: DatabaseReader,
  seat: Id<"conversations">,
) {
  const key = sweepKey(seat, "cancellation");
  const rows = db
    .query("system_config")
    .withIndex("by_key", (q) => q.gte("key", key).lt("key", `${key};`));
  for await (const row of rows) {
    const state = readSweep(row);
    if (
      "role" in state &&
      (await sweepIsActive(db, state.jobId)) &&
      (await db.get(state.role))?.status === "retired"
    )
      yield { row, state };
  }
}
export function readSweep(
  row: Doc<"system_config">,
): RoleHandoff | TriggerCancellation {
  return JSON.parse(row.value) as RoleHandoff | TriggerCancellation;
}
async function sweepIsActive(
  db: DatabaseReader,
  id: Id<"_scheduled_functions">,
) {
  const job = await db.system.get(id);
  return job?.state.kind === "pending" || job?.state.kind === "inProgress";
}
export async function writeSweep(
  ctx: TaskCtx,
  id: Id<"system_config">,
  state: RoleHandoff | TriggerCancellation,
): Promise<void> {
  await ctx.db.patch(id, { value: JSON.stringify(state) });
}
function createSweep(ctx: TaskCtx, key: string): Promise<Id<"system_config">> {
  return ctx.db.insert("system_config", {
    key,
    value: "",
    updated_at: Date.now(),
  });
}
export function triggerPage(
  db: DatabaseReader,
  seat: Id<"conversations">,
  cursor: string | null,
) {
  return triggersForConversation(db, seat).paginate({
    numItems: HANDOFF_PAGE_ROWS,
    maximumBytesRead: HANDOFF_PAGE_BYTES,
    cursor,
  });
}
async function handRoleTriggersForSeat(
  ctx: TaskCtx,
  seat: Doc<"conversations">,
  claimed: boolean,
): Promise<number> {
  for await (const _ of activeCancellations(ctx.db, seat._id)) return 0;
  const handoff = await scheduledSweep(ctx.db, sweepKey(seat._id));
  if (handoff) {
    const state = readSweep(handoff);
    if (!("role" in state) && state.runner === seat.user_id) {
      if (
        (claimed || state.started === false) &&
        (await sweepIsActive(ctx.db, state.jobId))
      ) {
        if (claimed && !state.claimed)
          await writeSweep(ctx, handoff._id, { ...state, claimed });
        return 0;
      }
      claimed ||= state.claimed;
    }
    await ctx.db.delete(handoff._id);
  }
  const tasks = await smallTriggerSet(ctx.db, seat._id);
  if (!tasks) {
    if (!ctx.scheduler) throw new Error("Trigger handoff requires a scheduler");
    const handoffId = await createSweep(ctx, sweepKey(seat._id));
    const jobId = (await ctx.scheduler.runAfter(
      0,
      internal.lib.agentTaskRows.continueRoleTriggerHandoff,
      {
        conversationId: seat._id,
        runner: seat.user_id,
        cursor: null,
        repair: "pending",
        handoffId,
      },
    )) as Id<"_scheduled_functions">;
    await writeSweep(ctx, handoffId, {
      jobId,
      runner: seat.user_id,
      claimed,
      started: false,
      cursor: null,
    });
    return 0;
  }
  const repairKind = () =>
    writeArmedTriggerKind(ctx, seat, armedTriggerKindFor(tasks));
  if (claimed) await repairKind();
  return handRoleTriggerPage(
    ctx,
    seat,
    tasks,
    claimed ? undefined : repairKind,
  );
}
async function handRoleTriggerPage(
  ctx: TaskCtx,
  seat: Doc<"conversations">,
  tasks: Doc<"agent_tasks">[],
  afterFirstWrite?: () => Promise<void>,
): Promise<number> {
  const roleBelongsToSeat = new Map<Id<"org_roles">, boolean>();
  let handed = 0;
  for (const task of tasks) {
    if (!task.role_id || task.user_id === seat.user_id) continue;
    let belongs = roleBelongsToSeat.get(task.role_id);
    if (belongs === undefined) {
      belongs = (await roleSeatId(ctx, task.role_id)) === seat._id;
      roleBelongsToSeat.set(task.role_id, belongs);
    }
    if (!belongs) continue;
    await ctx.db.patch(task._id, { user_id: seat.user_id });
    if (handed === 0) await afterFirstWrite?.();
    handed++;
  }
  return handed;
}
export const continueRoleTriggerHandoff = internalMutation({
  args: {
    handoffId: v.optional(v.id("system_config")),
    conversationId: v.id("conversations"),
    runner: v.id("users"),
    cursor: v.union(v.null(), v.string()),
    seenKind: v.optional(
      v.union(v.literal("none"), v.literal("once"), v.literal("standing")),
    ),
    repair: v.union(
      v.literal("pending"),
      v.literal("witness"),
      v.literal("done"),
    ),
  },
  handler: async (ctx, args): Promise<void> => {
    const handoff = args.handoffId && (await ctx.db.get(args.handoffId));
    if (args.handoffId && !handoff) return;
    const state = handoff ? readSweep(handoff) : null;
    if (state && "role" in state) return;
    if (state?.cursor !== undefined && state.cursor !== args.cursor) return;
    const seat = await ctx.db.get(args.conversationId);
    if (!seat || seat.user_id !== args.runner) {
      if (handoff) await ctx.db.delete(handoff._id);
      return;
    }
    const page = await triggerPage(ctx.db, seat._id, args.cursor);
    const pageKind =
      args.repair === "done" ? undefined : armedTriggerKindFor(page.page);
    const seenKind =
      args.seenKind === "standing" || pageKind === "standing"
        ? "standing"
        : args.seenKind === "once" || pageKind === "once"
          ? "once"
          : "none";
    let repair = args.repair;
    const seatKind = seat.armed_trigger_kind ?? "none";
    const repairKind = async () => {
      if (repair !== "pending") return;
      if (seenKind === "standing" || (args.cursor === null && page.isDone)) {
        await writeArmedTriggerKind(ctx, seat, seenKind);
        repair = "done";
        return;
      }
      let kind: ArmedTriggerKind = "none";
      let count = 0;
      let bytes = 0;
      for await (const task of triggersForConversation(ctx.db, seat._id)) {
        const next = armedTriggerKindOf(task);
        if (next === "standing") {
          kind = "standing";
          break;
        }
        if (next === "once") kind = "once";
        count++;
        bytes += getDocumentSize(task);
        if (count >= HANDOFF_KIND_ROWS || bytes >= HANDOFF_KIND_BYTES) {
          if ((kind === "once" || pageKind === "once") && seatKind === "none") {
            await writeArmedTriggerKind(ctx, seat, "once");
          }
          repair = "witness";
          return;
        }
      }
      await writeArmedTriggerKind(ctx, seat, kind);
      repair = "done";
    };
    if (state?.claimed) await repairKind();
    await handRoleTriggerPage(ctx, seat, page.page, repairKind);
    if (repair === "witness") {
      if (seenKind === "standing") {
        await writeArmedTriggerKind(ctx, seat, "standing");
        repair = "done";
      } else if (page.isDone) {
        await writeArmedTriggerKind(ctx, seat, seenKind);
      } else if (
        args.repair === "witness" &&
        pageKind === "once" &&
        seatKind === "none"
      ) {
        await writeArmedTriggerKind(ctx, seat, "once");
      }
    }
    if (!page.isDone) {
      const jobId = await ctx.scheduler.runAfter(
        0,
        internal.lib.agentTaskRows.continueRoleTriggerHandoff,
        {
          ...args,
          cursor: page.continueCursor,
          repair,
          seenKind,
        },
      );
      if (handoff && state) {
        await writeSweep(ctx, handoff._id, {
          ...state,
          jobId,
          started: true,
          cursor: page.continueCursor,
        });
      }
    } else if (handoff) {
      await ctx.db.delete(handoff._id);
    }
  },
});
type Retirement = {
  role: Id<"org_roles">;
  by: Id<"users">;
  keepTitle?: string;
};
type TriggerCancellation = Retirement & {
  batchKey: string;
  jobId: Id<"_scheduled_functions">;
  cursor: string | null;
  kind: ArmedTriggerKind;
  seenThrough: number | null;
};
export function shouldCancelForRetirement(
  task: Doc<"agent_tasks">,
  retirement: Retirement,
  started?: number,
) {
  return (
    task.status !== "cancelled" &&
    task.status !== "completed" &&
    task.status !== "failed" &&
    (retirement.keepTitle === undefined ||
      ((started === undefined || task._creationTime <= started) &&
        (task.title === retirement.keepTitle ||
          task.role_id === retirement.role)))
  );
}
export async function cancelRetirementPage(
  ctx: TaskCtx,
  tasks: Doc<"agent_tasks">[],
  restamp: TriggerRestamp = async () => {},
) {
  const stopped = [];
  for (const task of tasks) {
    await patchTask(ctx, task, { status: "cancelled" }, restamp);
    stopped.push({ agent_task_id: String(task._id), title: task.title });
  }
  return stopped;
}
export async function cancelTasksOriginatingFrom(
  ctx: TaskCtx,
  conversationId: Id<"conversations">,
  retirement: Retirement,
  prepareBatch: (sweepId: Id<"system_config">) => Promise<string>,
) {
  if (retirement.keepTitle === undefined)
    ctx[RETIRED_TRIGGER_HOME] = conversationId;
  const seatKey = sweepKey(conversationId, "cancellation");
  const roleKey = `${seatKey}:${retirement.role}`;
  const key = retirement.keepTitle === undefined ? seatKey : roleKey;
  for (const priorKey of [seatKey, roleKey]) {
    const row = await scheduledSweep(ctx.db, priorKey);
    if (!row) continue;
    const state = readSweep(row);
    if (priorKey === key || ("role" in state && state.role === retirement.role))
      await ctx.db.delete(row._id);
  }
  const tasks = await smallTriggerSet(ctx.db, conversationId);
  if (!tasks) {
    if (!ctx.scheduler)
      throw new Error("Trigger cancellation requires a scheduler");
    const handoff = await scheduledSweep(ctx.db, sweepKey(conversationId));
    if (handoff) await ctx.db.delete(handoff._id);
    const sweepId = await createSweep(ctx, key);
    const batchKey = await prepareBatch(sweepId);
    const jobId = (await ctx.scheduler.runAfter(
      0,
      internal.orgRoles.continueRoleTriggerCancellation,
      { conversationId, sweepId, cursor: null },
    )) as Id<"_scheduled_functions">;
    await writeSweep(ctx, sweepId, {
      ...retirement,
      batchKey,
      jobId,
      cursor: null,
      kind: "none",
      seenThrough: null,
    });
    return null;
  }
  const cancelling = tasks.filter((task) =>
    shouldCancelForRetirement(task, retirement),
  );
  let seat: Doc<"conversations"> | null = await ctx.db.get(conversationId);
  const remaining = { none: 0, once: 0, standing: 0 };
  for (const task of tasks) remaining[armedTriggerKindOf(task)]++;
  return cancelRetirementPage(ctx, cancelling, async (task) => {
    remaining[armedTriggerKindOf(task)]--;
    const kind = remaining.standing
      ? "standing"
      : remaining.once
        ? "once"
        : "none";
    await writeArmedTriggerKind(ctx, seat, kind);
    if (seat) seat = { ...seat, armed_trigger_kind: kind };
  });
}
export async function reactivateTasksCanceledOnKill(
  ctx: TaskCtx,
  userId: Id<"users">,
  conversationId: Id<"conversations">,
): Promise<number> {
  let rearmed = 0;
  for (const task of await runnerTasksOriginatedBy(
    ctx,
    userId,
    conversationId,
  )) {
    if (task.status !== "completed" || !task.canceled_on_kill_at) continue;
    if (await applyReactivate(ctx, task)) rearmed++;
  }
  return rearmed;
}

/** A project at rest: paused, or done. Its triggers wait with it. */
export function projectQuiet(status: string | undefined): boolean {
  return status === "paused" || status === "done";
}

/** A project's status moved: going quiet pauses every armed trigger it feeds
 *  and stamps each, waking resumes only the ones its quiet paused, so a
 *  trigger a person paused by hand stays paused. Same rule as a role's pause
 *  (org-staffing.md S25). */
export async function syncProjectTriggers(
  ctx: TaskCtx,
  projectId: Id<"projects">,
  from: string | undefined,
  to: string | undefined,
): Promise<number> {
  if (projectQuiet(from) === projectQuiet(to)) return 0;
  const rows: Doc<"agent_tasks">[] = await ctx.db
    .query("agent_tasks")
    .withIndex("by_project", (q: any) => q.eq("project_id", projectId))
    .collect();
  let moved = 0;
  for (const t of rows) {
    if (
      projectQuiet(to) &&
      (t.status === "scheduled" || t.status === "running")
    ) {
      await patchTask(ctx, t, {
        status: "paused",
        paused_by_project_id: projectId,
        paused_by_role_id: undefined,
      });
      moved++;
    } else if (
      !projectQuiet(to) &&
      t.status === "paused" &&
      String(t.paused_by_project_id ?? "") === String(projectId)
    ) {
      // An event trigger stays disarmed until its next event, as applyResume
      // leaves it, unless a window was open at the pause: its lines run now.
      const now = Date.now();
      const run_at =
        t.schedule_type === "event"
          ? t.pending_events?.length
            ? now
            : undefined
          : Math.max(t.run_at ?? 0, now);
      await patchTask(ctx, t, {
        status: "scheduled",
        paused_by_project_id: undefined,
        run_at,
      });
      moved++;
    }
  }
  return moved;
}
