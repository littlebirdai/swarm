import type { Id } from "../_generated/dataModel";
import {
  TASK_STATUS_CATEGORIES,
  findTeamTaskStatus,
  invalidTaskStatusMessage,
  isTaskStatusCategory,
  taskStatusAlias,
  taskStatusChoices,
  teamTaskStatuses,
  type TeamTaskStatus,
} from "@codecast/tasks/statuses";

// The six status CATEGORIES (see @codecast/tasks/statuses.ts). Teams
// refine them with named statuses; tasks.status always holds the category.
export const VALID_TASK_STATUSES = TASK_STATUS_CATEGORIES;

export type TaskStatus = (typeof VALID_TASK_STATUSES)[number];

export function assertValidTaskStatus(
  status: string | undefined,
): asserts status is TaskStatus | undefined {
  if (
    status !== undefined &&
    !VALID_TASK_STATUSES.includes(status as TaskStatus)
  ) {
    throw new Error(
      `Invalid task status '${status}'. Valid: ${VALID_TASK_STATUSES.join(", ")}`,
    );
  }
}

export async function loadTeamTaskStatuses(
  ctx: any,
  teamId: Id<"teams"> | undefined | null,
): Promise<TeamTaskStatus[]> {
  const team = teamId ? await ctx.db.get(teamId) : null;
  return teamTaskStatuses(team?.task_statuses);
}

// Resolve a status write against the team's configured statuses (Linear-style
// custom statuses; see @codecast/tasks/statuses.ts).
//
// - `status` names a category, or a team status by id or name ("today"). A
//   team status in `status` is the same write as sending it as `status_id`,
//   which is how the CLI (`-s today`) reaches the team's own statuses.
// - `status_id` names a team status: it sets the category, and a `status` sent
//   alongside must agree (a mismatch is a client bug, not a preference).
//   The id is stored only when it refines the category default — a task on the
//   default needs no pointer to it.
// - `status_id: ""` clears the refinement (back to the category default).
// - a category-only write that CHANGES the category clears the refinement too:
//   the old id belongs to the old category and would lie about where the task
//   is. Same-category writes (e.g. `cast task start` on a task already
//   refined within in_progress) keep it.
//
// Returns the category to write (if any) and whether/what to write into
// status_id — `set` distinguishes "clear the field" from "leave it alone".
export async function resolveStatusWrite(
  ctx: any,
  teamId: Id<"teams"> | undefined | null,
  currentStatus: string | undefined,
  args: { status?: string; status_id?: string },
): Promise<{
  status?: TaskStatus;
  statusId: { set: boolean; value?: string };
}> {
  let status = args.status;
  let statusId = args.status_id;
  const namesTeamStatus = status !== undefined && !isTaskStatusCategory(status);
  if (namesTeamStatus || statusId) {
    const statuses = await loadTeamTaskStatuses(ctx, teamId);
    if (namesTeamStatus) {
      const named = findTeamTaskStatus(statuses, status!);
      if (named) {
        if (statusId && statusId !== named.id) {
          throw new Error(
            `Status '${status}' does not match status_id '${statusId}'`,
          );
        }
        status = undefined;
        statusId = named.id;
      } else {
        // A near-miss word (`cancelled`) means its category; anything else is refused.
        const alias = taskStatusAlias(status!);
        if (!alias)
          throw new Error(
            invalidTaskStatusMessage(status!, taskStatusChoices(statuses)),
          );
        status = alias;
      }
    }
    if (statusId) {
      const match = statuses.find((s) => s.id === statusId);
      if (!match) throw new Error(`Unknown status '${statusId}' for this team`);
      if (status && status !== match.category) {
        throw new Error(
          `Status '${statusId}' is in category '${match.category}', not '${status}'`,
        );
      }
      return {
        status: match.category,
        statusId: {
          set: true,
          value: match.id === match.category ? undefined : match.id,
        },
      };
    }
  }
  assertValidTaskStatus(status);
  if (statusId === "" || (status && status !== currentStatus)) {
    return { status, statusId: { set: true, value: undefined } };
  }
  return { status, statusId: { set: false } };
}
