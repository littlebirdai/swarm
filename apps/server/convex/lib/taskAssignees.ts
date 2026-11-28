import type { Id } from "../_generated/dataModel";
import { roleOfConversation } from "./actor";
import { parseWorkspaceKey, resolveWorkspaceKey } from "./access";
import { matchHandle, teamRoster } from "./mentionResolve";
import { liveRoleByHandle, roleByHandleForRead } from "./orgAccess";
import { roleAssigneeInfo, type AssigneeInfo } from "@codecast/org/orgAssignee";

// Resolve a free-form assignee ("Jason", "Jason Benn", an email, a github
// handle) to a team member's user id. Mirrors the feed member resolver in
// conversations.ts: exact match on github_username/name/email first, then a
// UNIQUE case-insensitive substring on name/email. Returns null when nothing
// matches or a substring is ambiguous — it never guesses between two people.
async function findTeamMemberId(
  ctx: any,
  query: string,
  teamId?: Id<"teams">,
  // "@handle" names one thing exactly; a substring would hand "@ads" to
  // whoever has "ads" in their email.
  opts: { exactOnly?: boolean } = {},
): Promise<Id<"users"> | null> {
  if (!teamId) return null;
  const lower = query.toLowerCase();
  const memberships = await ctx.db
    .query("team_memberships")
    .withIndex("by_team_id", (q: any) => q.eq("team_id", teamId))
    .collect();
  // A bot on the roster is a role's seat or the workspace anchor, never a
  // person to assign: a role named "Growth" mints a bot user named "Growth",
  // and matching it here would hand "@growth" to a fake person and never to
  // the role (which is looked up after the people, in resolveAssigneeStr).
  const members = (
    await Promise.all(memberships.map((m: any) => ctx.db.get(m.user_id)))
  ).filter((u: any) => u && !u.is_bot);
  const exact = members.find(
    (u: any) =>
      u.github_username?.toLowerCase() === lower ||
      u.name?.toLowerCase() === lower ||
      u.email?.toLowerCase() === lower ||
      u.alternate_emails?.some((e: string) => e.toLowerCase() === lower),
  );
  if (exact) return exact._id;
  if (opts.exactOnly) return null;
  const partial = members.filter(
    (u: any) =>
      u.name?.toLowerCase().includes(lower) ||
      u.email?.toLowerCase().includes(lower) ||
      u.alternate_emails?.some((e: string) => e.toLowerCase().includes(lower)),
  );
  return partial.length === 1 ? partial[0]._id : null;
}

export async function resolveAssigneeToUserId(
  ctx: any,
  assignee: string,
  teamId?: Id<"teams">,
): Promise<Id<"users"> | null> {
  if (!assignee) return null;
  // Only call ctx.db.get when the input actually is a document id — it throws
  // on a malformed id, so a raw name like "Jason Benn" must never reach it.
  // normalizeId returns null for non-ids instead of throwing.
  const directId = ctx.db.normalizeId("users", assignee);
  if (directId) {
    const direct = await ctx.db.get(directId);
    if (direct) return direct._id;
  }
  const lower = assignee.toLowerCase();
  const byGh = await ctx.db
    .query("users")
    .withIndex("by_github_username", (q: any) => q.eq("github_username", lower))
    .first();
  if (byGh) return byGh._id;
  return findTeamMemberId(ctx, assignee, teamId);
}

// ── A role as assignee (docs/architecture/org-roles-run-work.md R5) ─────────
//
// `tasks.assignee` holds a user's id or a role's id. A role owns a task only
// inside its own boundary: a team's role takes that team's tasks, a personal
// role its owner's. The by_assignee indexes key on the string either way.

export type AssigneeBoundary = {
  team_id?: Id<"teams">;
  scope_user_id?: Id<"users">;
  /** The team a task is ROUTED to when its access boundary is personal (a
   *  task kept private inside a team): where a handle is looked up, on the
   *  roster and among the roles, so "@growth" names the team's role and is
   *  refused for the right reason. Never what a role may take. */
  routed_team_id?: Id<"teams">;
};

export const boundaryOfWorkspace = (
  w:
    | { type: "team"; teamId: Id<"teams"> }
    | { type: "personal"; userId: Id<"users"> },
): AssigneeBoundary =>
  w.type === "team" ? { team_id: w.teamId } : { scope_user_id: w.userId };

/** The boundary a task's assignee must be inside, read from the task's ACCESS
 *  key (its workspace) and never from team_id, which is routing (CLAUDE.md):
 *  a task routed to a team but readable by its owner only is a personal task
 *  to a role, so a team role cannot take it and carry its title into a wake
 *  row and a standing session the whole team reads. */
export async function boundaryOfTask(
  ctx: { db: any },
  task: { user_id: Id<"users">; workspace?: string },
): Promise<AssigneeBoundary> {
  const stored = parseWorkspaceKey(await resolveWorkspaceKey(ctx, task));
  return boundaryOfWorkspace(
    stored ?? { type: "personal", userId: task.user_id },
  );
}

/** boundaryOfTask plus where a handle is looked up: the task's routing team. */
export async function assigneeScopeOf(
  ctx: { db: any },
  task: { user_id: Id<"users">; team_id?: Id<"teams">; workspace?: string },
): Promise<AssigneeBoundary> {
  return { ...(await boundaryOfTask(ctx, task)), routed_team_id: task.team_id };
}

/** The role an assignee value names, or null when it names anything else. */
export async function roleAssigneeOf(
  ctx: { db: any },
  assignee: string | undefined | null,
): Promise<any | null> {
  if (!assignee) return null;
  const id = ctx.db.normalizeId("org_roles", assignee);
  return id ? await ctx.db.get(id) : null;
}

/** The role whose seat a bot user is: a role's standing session renders as a
 *  bot user named after the role (anchors.provisionStandingAgent), and a
 *  picker or a stale row may hand that user's id in as the assignee. The task
 *  belongs to the role, never to the bot. Null for a person or a bot with no
 *  role. */
async function roleOfBotUser(
  ctx: { db: any },
  userId: Id<"users">,
): Promise<any | null> {
  const user = await ctx.db.get(userId);
  if (!user?.is_bot) return null;
  const anchor = await ctx.db
    .query("anchors")
    .withIndex("by_bot_user", (q: any) => q.eq("bot_user_id", user._id))
    .first();
  return anchor?.org_role_id ? await ctx.db.get(anchor.org_role_id) : null;
}

/** Why this role cannot take a task in this boundary, in words for the person
 *  who tried; null when it can. */
export function roleAssigneeRefusal(
  role: any,
  boundary: AssigneeBoundary,
): string | null {
  if (role.status === "retired")
    return `@${role.handle} is retired, so it cannot take tasks. Pick a live role or a person.`;
  if (boundary.team_id) {
    return String(role.team_id ?? "") === String(boundary.team_id)
      ? null
      : `@${role.handle} belongs to another workspace, so it cannot take this task.`;
  }
  if (role.team_id) {
    // A team role, and a task only its owner can read (personal, or routed to
    // the team but kept private): the role's wake row and standing session
    // are the team's to read, so the task would leak through them.
    return `This task is readable by its owner only, so a team role cannot take it: @${role.handle} would carry it into a session the team reads. Share the task with the team first, or hand it to a person.`;
  }
  return String(role.scope_user_id ?? "") ===
    String(boundary.scope_user_id ?? "")
    ? null
    : `@${role.handle} belongs to another workspace, so it cannot take this task.`;
}

type ResolveAssigneeOpts = {
  /** A read (a list filter) names what a task holds, so a retired role and a
   *  role outside the boundary resolve as they are; only a write refuses. */
  read?: boolean;
};

/**
 * One resolver for every assignee value the CLI, the web and the sync paths
 * write or filter on. A handle ("@growth") is a claim that someone answers
 * to it, resolved the way chat does (lib/mentionResolve): a teammate's login
 * or email wins, then the live role with that handle in the task's
 * boundary. A role outranks the bot user its seat renders as, and a bot is
 * never a person: the role's id is stored, so the role is woken, `--chain`
 * finds the task and the board shows one Growth, not two. A handle nobody
 * answers to is refused rather than stored as a bare string no roster could
 * resolve. A bare word is a person by login or name, else a role by handle,
 * else the word itself (a name typed by hand, kept as it was).
 */
export async function resolveAssigneeStr(
  ctx: any,
  assignee: string | undefined,
  userId: Id<"users">,
  boundary?: AssigneeBoundary,
  opts: ResolveAssigneeOpts = {},
): Promise<string | undefined> {
  if (!assignee) return undefined;
  if (assignee === "me") return userId.toString();
  if (assignee.startsWith("agent:")) return assignee;
  const settle = (role: any): string => {
    const refusal =
      !opts.read && boundary ? roleAssigneeRefusal(role, boundary) : null;
    if (refusal) throw new Error(refusal);
    return role._id.toString();
  };
  // Where a handle is looked up: the boundary's team, or the team a private
  // task is routed to; a personal boundary looks among the person's own roles.
  const lookupTeam = boundary?.team_id ?? boundary?.routed_team_id;
  const lookupSeat = lookupTeam ? { team_id: lookupTeam } : boundary;
  const roleByHandle = (handle: string) =>
    !lookupSeat
      ? null
      : opts.read
        ? roleByHandleForRead(ctx, lookupSeat, handle)
        : liveRoleByHandle(ctx, lookupSeat, handle);
  const assignedRole = await roleAssigneeOf(ctx, assignee);
  if (assignedRole) return settle(assignedRole);
  const assignedUser = ctx.db.normalizeId("users", assignee);
  if (assignedUser && (await ctx.db.get(assignedUser))) {
    const botRole = await roleOfBotUser(ctx, assignedUser);
    return botRole ? settle(botRole) : assignedUser;
  }
  if (assignee.startsWith("@")) {
    const handle = assignee.slice(1).trim();
    const match = lookupTeam
      ? matchHandle(await teamRoster(ctx, lookupTeam), handle)
      : null;
    if (match && !match.is_bot) return match._id.toString();
    const role = await roleByHandle(handle);
    if (role) return settle(role);
    const anyone = await resolveAssigneeToUserId(ctx, handle, lookupTeam);
    if (!anyone)
      throw new Error(
        `Nobody answers to @${handle} in this workspace: no teammate and no live role has that handle. Run cast role ls to see the roles here.`,
      );
    return anyone.toString();
  }
  const lower = assignee.toLowerCase();
  const found = await ctx.db
    .query("users")
    .withIndex("by_github_username", (q: any) => q.eq("github_username", lower))
    .first();
  if (found) return found._id.toString();
  // A team member's name or email persists a real user id (consistent with a
  // login match) rather than a bare string the roster cannot resolve. The
  // boundary says which team: a write never guesses one from the caller's
  // active team pointer (CLAUDE.md, reads may default, writes must be explicit).
  const memberId = await findTeamMemberId(ctx, assignee, lookupTeam);
  if (memberId) return memberId.toString();
  const role = await roleByHandle(assignee);
  return role ? settle(role) : assignee;
}

/** Is `conv` the conversation `ancestorId`, or a fork of it (at any depth
 *  that a real fork chain reaches)? A fork carries the filing session's whole
 *  history under a new conversation id, so its start of a task that session
 *  filed is the same session's bookkeeping, not a takeover. */
async function isForkLineOf(
  ctx: any,
  conv: any,
  ancestorId: string,
): Promise<boolean> {
  let cur: any = conv;
  for (let depth = 0; cur && depth < 16; depth++) {
    if (String(cur._id) === String(ancestorId)) return true;
    cur = cur.forked_from ? await ctx.db.get(cur.forked_from) : null;
  }
  return false;
}

/** The role a session works for: the one it reports to, or the one whose standing session it is. */
export const roleOf = (conv: any): string | undefined =>
  conv?.org_role_id
    ? String(conv.org_role_id)
    : conv?.standing_role_id
      ? String(conv.standing_role_id)
      : undefined;

// The role that takes a task when `conv` starts it: the role the session
// reports to, or the role whose standing session it is. Null when the session
// works for no role, when the task already names a person (a user, or a name
// nobody resolved: either way a human meant someone), or when the role cannot
// own a task here (retired, another workspace). Another role's task does move:
// the work is now being done under this one, and the chain view still rolls
// it up to the same person when one reports to the other.
//
// Taking over, not creating: every task with an assignee shows on the
// person's default board (`isOnHumanBoard`), which is right for work a role
// takes over and wrong for a session's own bookkeeping. So a task this same
// session filed stays unassigned and internal as it is today, and a subtask
// stays nested under its parent with no assignee of its own; the parent says
// who answers for the work.
export async function roleTakingTask(
  ctx: any,
  task: any,
  conv: any,
  boundary: AssigneeBoundary,
): Promise<any | null> {
  const roleId = roleOf(conv);
  if (!roleId) return null;
  if (task.parent_id) return null;
  if (
    task.created_from_conversation &&
    (await isForkLineOf(ctx, conv, task.created_from_conversation))
  )
    return null;
  const current: string | undefined = task.assignee || undefined;
  if (
    current &&
    !current.startsWith("agent:") &&
    !(await roleAssigneeOf(ctx, current))
  )
    return null;
  const role = await roleAssigneeOf(ctx, roleId);
  return role && !roleAssigneeRefusal(role, boundary) ? role : null;
}

/**
 * Who answers for a task a session files for people to see (a person's ask, a
 * meeting's decision, or `--human`) without naming an assignee: the role that
 * session works for (its standing seat, or the role it reports to), else the
 * person running it. A role this workspace cannot hold falls back to the
 * person. A session's own bookkeeping stays unowned, because an assignee puts
 * a task on the person's board (isOnHumanBoard).
 */
export async function defaultSessionOwner(
  ctx: any,
  conv: any,
  forPeople: boolean,
  userId: Id<"users">,
  boundary: AssigneeBoundary,
): Promise<string | undefined> {
  if (!conv || !forPeople) return undefined;
  const role = await roleOfConversation(ctx, conv);
  return role && !roleAssigneeRefusal(role, boundary)
    ? String(role._id)
    : String(userId);
}

// Who a set of assignee values names, in the contract's shape
// (@codecast/org/orgAssignee): a role with its face and handle,
// a person with their name and login. `agent:*` assignees are already names.
// Unknown values are left out so callers can print the raw value rather than
// nothing.
export async function assigneeInfoFor(
  ctx: any,
  assignees: (string | undefined)[],
): Promise<Record<string, AssigneeInfo>> {
  const out: Record<string, AssigneeInfo> = {};
  for (const id of new Set(assignees.filter(Boolean) as string[])) {
    if (id.startsWith("agent:")) {
      out[id] = { name: id };
      continue;
    }
    const role = await roleAssigneeOf(ctx, id);
    if (role) {
      out[id] = roleAssigneeInfo(role);
      continue;
    }
    const user = /^[a-z0-9]{32}$/.test(id)
      ? ((await ctx.db.get(id as any).catch(() => null)) as any)
      : null;
    if (user?.name || user?.github_username)
      out[id] = {
        name: user.name || user.github_username,
        github_username: user.github_username,
        image: user.image || user.github_avatar_url,
      };
  }
  return out;
}

/** The CLI names a role the way a person types it: "@growth". */
export const assigneeNameOf = (
  info: AssigneeInfo | undefined,
): string | undefined =>
  !info ? undefined : info.kind === "role" ? `@${info.handle}` : info.name;

// Display names for a set of assignee values; see assigneeInfoFor.
export async function assigneeNamesFor(
  ctx: any,
  assignees: (string | undefined)[],
): Promise<Record<string, string>> {
  const info = await assigneeInfoFor(ctx, assignees);
  return Object.fromEntries(
    Object.entries(info).map(([id, i]) => [id, assigneeNameOf(i)!]),
  );
}
