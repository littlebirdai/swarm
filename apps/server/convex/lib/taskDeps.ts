import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { pendingReleases, tellReleased } from "../taskWaits";
import {
  canAccessTask,
  isSameWorkspace,
  workspaceForResource,
  type AuthorizedWorkspace,
} from "./access";
import {
  assertDependencyEdges,
  requireTaskByRef,
  taskByRef,
  writeEdges,
} from "./taskGraph";
import { bySystem, byUser, type TaskChangeBy } from "./taskHistory";

// create and update accept blocked_by/blocks as raw arrays, and plans
// insert whole graphs (createFromTemplate, fork); each accepted edge must
// also land on the referenced task's other side or the stored mirror drifts
// (addDep/removeDep already keep it for single edges). Same
// short-id resolution addDep uses, but an unresolvable, inaccessible or
// cross-workspace reference skips the mirror instead of rejecting a write
// the caller already made. The mirror may name `self` by its `_id` (a plan's
// older rows): that form is the same edge, so it is never added twice and
// is removed with the short id.
export async function patchDepMirror(
  ctx: any,
  userId: Id<"users">,
  self: { short_id: string; _id?: string; workspace: AuthorizedWorkspace },
  otherRef: string,
  mirrorField: "blocks" | "blocked_by",
  op: "add" | "remove",
  // Who made the edit: a blocked_by mirror is the other task's own history (TG11).
  by?: TaskChangeBy,
) {
  const other = await taskByRef(ctx, otherRef);
  if (!other || !(await canAccessTask(ctx, userId, other))) return;
  if (op === "add" && !isSameWorkspace(other, self.workspace)) return;
  const mirror: string[] = other[mirrorField] || [];
  const isSelf = (id: string) =>
    id === self.short_id || (!!self._id && id === self._id);
  if (op === "add" ? mirror.some(isSelf) : !mirror.some(isSelf)) return;
  const next =
    op === "add"
      ? [...mirror, self.short_id]
      : mirror.filter((id: string) => !isSelf(id));
  await writeEdges(ctx, other, mirrorField, next, by ?? bySystem);
}

export async function syncDepEdgeMirrors(
  ctx: any,
  userId: Id<"users">,
  task: { _id: Id<"tasks">; short_id: string },
  depWorkspace: AuthorizedWorkspace,
  prevDeps: { blocked_by: string[]; blocks: string[] },
  nextArgs: { blocked_by?: string[]; blocks?: string[] },
  changedBy: TaskChangeBy,
) {
  // blocked_by/blocks are raw overwrites; reflect the delta onto each
  // referenced task's other side so the stored mirror stays coherent. Refs
  // compare by the task they name: an older plan row names one by `_id`,
  // this write by short id, and removing the old form would drop the mirror
  // the new form keeps.
  const byTask = async (refs: string[]) =>
    new Map(
      await Promise.all(
        refs.map(async (r): Promise<[string, string]> => [
          r,
          (await taskByRef(ctx, r))?.short_id ?? r,
        ]),
      ),
    );
  for (const [field, mirrorField] of [
    ["blocked_by", "blocks"],
    ["blocks", "blocked_by"],
  ] as const) {
    const nextRefs = nextArgs[field];
    if (!nextRefs) continue;
    const [prev, next] = await Promise.all([
      byTask(prevDeps[field]),
      byTask(nextRefs),
    ]);
    const [prevTasks, nextTasks] = [
      new Set(prev.values()),
      new Set(next.values()),
    ];
    const self = {
      short_id: task.short_id,
      _id: String(task._id),
      workspace: depWorkspace,
    };
    for (const [dep, id] of next) {
      if (!prevTasks.has(id))
        await patchDepMirror(
          ctx,
          userId,
          self,
          dep,
          mirrorField,
          "add",
          changedBy,
        );
    }
    for (const [dep, id] of prev) {
      if (!nextTasks.has(id))
        await patchDepMirror(
          ctx,
          userId,
          self,
          dep,
          mirrorField,
          "remove",
          changedBy,
        );
    }
  }
}

/** One dependency edge of `short_id`: the task it blocks, or the task it is blocked by. */
export type DepEdge = {
  short_id: string;
  blocks?: string;
  blocked_by?: string;
};

/** Add one edge, mirrored on both rows and refused when it would close a loop
 *  (TG4). `cast task dep` and the web's add-blocker palette (dispatch addBlocker). */
export async function addDepCore(
  ctx: MutationCtx,
  userId: Id<"users">,
  args: DepEdge,
  by: TaskChangeBy = byUser(userId),
) {
  const task = await requireTaskByRef(ctx, userId, args.short_id);
  const workspace = workspaceForResource(task);

  // `field` of this task gains the other task; its mirror gains this one.
  const addEdge = async (ref: string, field: "blocks" | "blocked_by") => {
    const otherRow = await requireTaskByRef(ctx, userId, ref);
    const other = otherRow.short_id;
    const current = task[field] ?? [];
    const blockedBy =
      field === "blocked_by" ? [...current, other] : task.blocked_by;
    await assertDependencyEdges(
      ctx,
      { short_id: task.short_id, _id: String(task._id), blocked_by: blockedBy },
      workspace,
      { [field]: [other] },
    );
    // An older plan row may already name it by `_id`: the same edge.
    if (!current.includes(other) && !current.includes(String(otherRow._id)))
      await writeEdges(ctx, task, field, [...current, other], by);
    await patchDepMirror(
      ctx,
      userId,
      { short_id: task.short_id, _id: String(task._id), workspace },
      other,
      field === "blocks" ? "blocked_by" : "blocks",
      "add",
      by,
    );
    return otherRow;
  };

  if (args.blocks) await addEdge(args.blocks, "blocks");
  // A finished blocker holds nothing, which the CLI says rather than "blocked".
  const blocker = args.blocked_by
    ? await addEdge(args.blocked_by, "blocked_by")
    : null;
  return {
    success: true,
    ...(blocker ? { blocker_status: blocker.status } : {}),
  };
}

/** Remove one edge and its mirror. Removing the last open blocker unblocks the
 *  dependent the way a closing blocker does (TG2), so a session parked on it
 *  is woken. `cast task dep --remove` and the web's Blocked by row. */
export async function removeDepCore(
  ctx: MutationCtx,
  userId: Id<"users">,
  args: DepEdge,
  by: TaskChangeBy = byUser(userId),
) {
  const task = await requireTaskByRef(ctx, userId, args.short_id);

  // Removes the edge from this task, plus the mirror edge on the other task
  // when it still exists — the other side may be gone, since edges to
  // dropped/deleted blockers are exactly what removal is for.
  const removeEdge = async (ref: string, field: "blocks" | "blocked_by") => {
    const current: string[] = task[field] || [];
    const other = await taskByRef(ctx, ref);
    // Older plan rows name a blocker by its `_id`, which `cast task show`
    // prints by short id. Both forms are one edge, and every form goes.
    const forms = new Set([
      ref,
      ...(other ? [other.short_id, String(other._id)] : []),
    ]);
    const otherId = current.find((id) => forms.has(id));
    if (!otherId) {
      // The usual cause is the edge named the other way round: say so, with the remove that fits.
      const [waiter, blocker] =
        field === "blocked_by" ? [other, task] : [task, other];
      const backwards =
        !!other &&
        (await canAccessTask(ctx, userId, other)) &&
        (waiter!.blocked_by ?? []).some(
          (r) => r === blocker!.short_id || r === String(blocker!._id),
        );
      const hint = backwards
        ? `; ${waiter!.short_id} waits on ${blocker!.short_id} instead (cast task dep ${waiter!.short_id} --remove-blocked-by ${blocker!.short_id})`
        : "";
      throw new Error(
        `${task.short_id} has no ${field === "blocks" ? "blocks" : "blocked-by"} dependency on ${ref}${hint}`,
      );
    }
    const next = current.filter((id) => !forms.has(id));
    // The row whose blocked_by loses the edge may be released (TG2).
    const releases = await pendingReleases(ctx, task, { [field]: next });
    await writeEdges(ctx, task, field, next, by);
    if (other) {
      const self = {
        short_id: task.short_id,
        _id: String(task._id),
        workspace: workspaceForResource(task),
      };
      await patchDepMirror(
        ctx,
        userId,
        self,
        other.short_id,
        field === "blocks" ? "blocked_by" : "blocks",
        "remove",
        by,
      );
    }
    await tellReleased(ctx, releases, by);
  };

  if (args.blocks) await removeEdge(args.blocks, "blocks");
  if (args.blocked_by) await removeEdge(args.blocked_by, "blocked_by");

  return { success: true };
}
