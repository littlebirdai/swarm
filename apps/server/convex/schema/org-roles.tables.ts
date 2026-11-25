import { defineTable } from "convex/server";
import { v } from "convex/values";
import { roleIconValidator } from "../lib/roleIconValidator";

export const orgRoleTables = {
  // ── Org roles ───────────────────────────────────────────────────────────────
  // A named seat in the reporting structure with a scope (docs/architecture/
  // org-roles.md S2). Sessions and other roles report to it through
  // `conversations.org_role_id` and `reports_to`; the person behind it is
  // `host_user_id`. No standing session yet: `anchor_id` is reserved for the
  // one that gets provisioned later. Access is the anchor rule (lib/orgAccess):
  // scope_type/team_id/scope_user_id carry the ACCESS boundary exactly as
  // anchors do, so there is no `workspace` key on this table.
  org_roles: defineTable({
    short_id: v.string(), // "or-N" from counters.nextShortId
    scope_type: v.union(v.literal("team"), v.literal("user")),
    // Exactly one of these is set, matching scope_type.
    team_id: v.optional(v.id("teams")), // routing AND the membership grant
    scope_user_id: v.optional(v.id("users")), // the personal owner
    host_user_id: v.id("users"), // creator; would host the role's session
    name: v.string(), // the role TITLE, e.g. "Head of Growth" (org-staffing.md S30)
    handle: v.string(), // unique inside the boundary; [a-z0-9-]{2,32}
    // The handles a rename took away, oldest first: a change, proposal or
    // reference written before the rename still finds the role through them
    // (orgInit.roleByRef), while a role holding the handle now always wins.
    previous_handles: v.optional(v.array(v.string())),
    // The person like name the role wears (S30), chosen by a person; absent
    // rows wear the character name of their face (@codecast/org/orgIdentity
    // roleIdentity). Every surface reads the name through it.
    given_name: v.optional(v.string()),
    // Set on an Executive Assistant, the person's right hand (S30): what it reaches.
    // Its row's boundary (scope_type) is ACCESS; `reach` is what its brief and
    // routine look across. A global assistant lives in the person's own boundary;
    // a team's reach in a personal boundary is a person's own assistant for one
    // team. An assistant names no scope and owns no work.
    assistant: v.optional(
      v.union(
        v.object({ reach: v.literal("global") }),
        v.object({ reach: v.literal("team"), team_id: v.id("teams") }),
      ),
    ),
    // What `migrations:renameHeadOfPeople` changed on this row (S30), so the
    // run is reversible: the handle and name before, and the trigger titles
    // it rewrote. Cleared by the reverse run.
    renamed_from: v.optional(
      v.object({
        handle: v.string(),
        name: v.string(),
        charter: v.optional(v.string()),
        // The charter doc's content before the run rewrote it (the doc is what
        // the agent reads; the row's charter is its first draft).
        charter_doc: v.optional(v.string()),
        // The personal root converted into the person's global Executive Assistant:
        // the review routine it had (cancelled) and the routine it got (armed).
        converted: v.optional(v.boolean()),
        review_trigger_id: v.optional(v.id("agent_tasks")),
        routine_trigger_id: v.optional(v.id("agent_tasks")),
        at: v.number(),
      }),
    ),
    // Scope is opt in (org-staffing.md S26): empty arrays name no area, and
    // the role owns no work. Only the Head of People with empty arrays covers
    // the whole workspace (isWholeWorkspaceRole, packages/org/src/orgLead.ts).
    scope: v.object({
      project_ids: v.array(v.id("projects")),
      plan_ids: v.array(v.id("plans")),
    }),
    reports_to: v.union(
      v.object({ kind: v.literal("user"), user_id: v.id("users") }),
      v.object({ kind: v.literal("role"), role_id: v.id("org_roles") }),
    ),
    status: v.union(
      v.literal("active"),
      v.literal("paused"),
      v.literal("retired"),
    ),
    anchor_id: v.optional(v.id("anchors")), // reserved: the standing session
    // Chat channels whose lines ride the role's wake frame (agent-channels.md
    // C1/C2 pull mode). Edited by orgChannels.follow/unfollow.
    follow_channel_ids: v.optional(v.array(v.id("chat_channels"))),
    // Consecutive company reviews at which the role was flagged overloaded
    // (org-staffing.md S2 STABILITY.split_after_breaches); orgProposals.create
    // in review mode writes it, org.health reads it as `breaches`.
    overload_streak: v.optional(v.number()),
    // When the streak last ticked: one tick per review window, so a proposal
    // withdrawn and reposted inside the week does not count as two reviews.
    overload_streak_at: v.optional(v.number()),
    // ── Standing agent (org-roles-standing.md T1 to T4) ──
    // The two documents the seat is run from: the charter (humans own it) and
    // the brief (the role owns it; its first line is the standing session's
    // thread state).
    charter_doc_id: v.optional(v.id("docs")),
    brief_doc_id: v.optional(v.id("docs")),
    // What the role may do on its own. understand: read and report; decide:
    // answer decisions inside its grants; direct: start hands within caps.
    // Changes are human only.
    trust: v.optional(
      v.union(
        v.literal("understand"),
        v.literal("decide"),
        v.literal("direct"),
      ),
    ),
    caps: v.optional(
      v.object({
        // Daily limits, each set only by a person; absent is no limit.
        hands_per_day: v.optional(v.number()),
        wakes_per_day: v.optional(v.number()),
        tokens_per_day: v.optional(v.number()),
        // Open card decisions the line may hold before it admits another cause
        // (the-line-end-to-end.md LE6); unset reads as DEFAULT_LINE_CARDS_CAP.
        cards: v.optional(v.number()),
        // The line's start switch (learning-loop.md LL5): true while the line of
        // the project this role leads starts problems on its own, up to `cards`
        // at a time. Unset reads as off (@codecast/org/roleAutonomy.lineStartsOn).
        line_on: v.optional(v.boolean()),
      }),
    ),
    // What a person lets the role do OUTSIDE codecast (org-hire.md H4): spend
    // on an account, publish to destinations, write into a project, connect a
    // service, each with a limit and an expiry. Independent of trust, which is
    // authority inside codecast. Human only, like trust and caps.
    authority: v.optional(
      v.array(
        v.object({
          id: v.string(),
          kind: v.union(
            v.literal("spend"),
            v.literal("publish"),
            v.literal("write"),
            v.literal("connect"),
          ),
          label: v.string(),
          scope: v.optional(v.string()),
          limit: v.optional(
            v.object({
              usd_per_month: v.optional(v.number()),
              usd_per_day: v.optional(v.number()),
              per_day: v.optional(v.number()),
            }),
          ),
          granted_by: v.id("users"),
          granted_at: v.number(),
          expires_at: v.optional(v.number()),
          template_instance_id: v.optional(v.id("org_template_instances")),
          decision_id: v.optional(v.string()),
        }),
      ),
    ),
    // Today's spend against the caps; `day` is the UTC date the counts belong
    // to, so a stale row resets itself on the first write of a new day.
    counters: v.optional(
      v.object({
        day: v.string(),
        hands: v.number(),
        wakes: v.number(),
        tokens: v.number(),
        // Merges the line made today (the-line.md L12), read against the
        // role's merge authority limit (per_day).
        merges: v.optional(v.number()),
        // Deploys the role asked for today (deploys.md DP4), read against its
        // deploy authority limit (per_day).
        deploys: v.optional(v.number()),
      }),
    ),
    // When the role last read its brief from its own session (orgRoles
    // .markBriefRead): `cast brief` shows what changed since (org-staffing.md S25).
    checked_at: v.optional(v.number()),
    // The area watch (org-staffing.md S29, orgWatch.ts): the area's status as
    // the last pass read it, since when it has read so, how many passes in a
    // row, and the status the Head of People was last told about, so a change
    // that lasts reaches the Head of People once per episode.
    area_watch: v.optional(
      v.object({
        status: v.string(),
        since: v.number(),
        passes: v.number(),
        told: v.optional(v.string()),
        told_at: v.optional(v.number()),
      }),
    ),
    // On the Head of People's row: the projects with work and no owner it was
    // told about, by project id, so each is told once until it gains an owner.
    unowned_told: v.optional(
      v.array(v.object({ id: v.string(), since: v.number() })),
    ),
    // The standing agent retired when this seat was filled with a fresh
    // session (org-staffing.md S16): its thread is kept and linked from the
    // role page, so a workspace never ends with two root agents.
    previous_standing_conversation_id: v.optional(v.id("conversations")),
    // The agent the line's review station runs on for this role (the-line.md
    // L3): must differ from the role's own agent, checked when the line starts.
    review_backend: v.optional(v.string()),
    // The workflow this scope's tasks run on (the-line.md L2); absent = the
    // shipped "line" template. Human only, logged like a scope edit.
    line_workflow_slug: v.optional(v.string()),
    // The line's merge step (the-line.md L12): on, an approved task's branch
    // is merged into the default branch when its checks pass, under the
    // role's `merge` authority grant and its daily limit. Off (absent) unless
    // a person turns it on for this line. Human only, logged like the line.
    line_merge: v.optional(v.boolean()),
    // The merge step on the measured rate (regret.md R7): while set, the line
    // merges only while its regret-free rate holds `bar` (0..1) over at least
    // `min` finished changes; the daily limit still applies. Absent: the count
    // alone decides. Human only, set with the switch.
    line_merge_rate: v.optional(
      v.object({
        bar: v.number(),
        min: v.number(),
        set_by: v.id("users"),
        set_at: v.number(),
      }),
    ),
    // Leeway to hire: on, a role's proposal of a new role under itself is
    // brought online at once, with no lead or person approving it
    // (orgProposals.routeHire). Off (absent or false) unless a person turns it on.
    // Human only, logged like the line's merge step.
    hires_freely: v.optional(v.boolean()),
    // Containment (scopes-and-feed.md F1): on, every role reporting to this
    // one keeps its scope inside this role's, and a scope edit, a move or an
    // undo that breaks that is refused. Off (absent) unless a person turns it
    // on: the org is open by default (2026-10-22). Read through
    // @codecast/org/orgLead keepsReportsInside.
    keeps_reports_inside: v.optional(v.boolean()),
    // Knowledge handoff when an area moves (org-staffing.md S32). On the
    // RECEIVING role: which role it succeeded for which project or plan, so
    // its page says where its lines came from.
    succeeded: v.optional(
      v.array(
        v.object({
          project_id: v.optional(v.id("projects")),
          plan_id: v.optional(v.id("plans")),
          from_role_id: v.id("org_roles"),
          from_handle: v.string(),
          from_name: v.string(),
          at: v.number(),
          // How many standing lines came over with it, and when the outgoing
          // role handed over what the lines did not say (cast role handoff).
          lines: v.number(),
          handed_at: v.optional(v.number()),
        }),
      ),
    ),
    // On the OUTGOING role: the handoff in flight. The role's standing
    // session has a trigger to hand each receiver what is not in the lines;
    // a retire that moved the area waits for it until `deadline`, then
    // decommissions anyway (orgHandoff.sweep).
    handing_over: v.optional(
      v.object({
        reason: v.union(
          v.literal("retire"),
          v.literal("split"),
          v.literal("scope"),
        ),
        started_at: v.number(),
        deadline: v.number(),
        by: v.id("users"),
        trigger_id: v.optional(v.id("agent_tasks")),
        receivers: v.array(
          v.object({
            role_id: v.id("org_roles"),
            handle: v.string(),
            project_ids: v.array(v.id("projects")),
            plan_ids: v.array(v.id("plans")),
            done_at: v.optional(v.number()),
          }),
        ),
        // Set when a retire waits on this handoff: how the person asked for
        // the standing session to be treated when it completes.
        retire: v.optional(
          v.object({
            standing_session: v.optional(
              v.union(v.literal("keep"), v.literal("retire")),
            ),
          }),
        ),
      }),
    ),
    // People who report to the role (org-roles-run-work.md R6): the role keeps
    // their goals in its brief, reads their sessions against those goals at
    // every wake, and tells them once a day at most when a high goal stalls.
    // Edited from the role's Settings tab or `cast role reports`; a person may
    // add or remove themself, an admin of the role anyone in its boundary.
    reports_user_ids: v.optional(v.array(v.id("users"))),
    // The UTC day a stalled goal notice last went to each reporting person
    // (keyed by user id), so a person hears about a stall once a day at most.
    goal_notices: v.optional(v.record(v.string(), v.string())),
    // The last time the failover sweep acted on this role's standing session
    // (roleFailover.ts): it moved it off a host that went quiet or unhealthy
    // with work waiting, or found no always-on host to move it to. The role
    // page draws this as the owner's line, with Move back while `from` is set
    // and the session still sits on `to`. Cleared by a move back.
    failover: v.optional(
      v.object({
        at: v.number(),
        reason: v.union(
          v.literal("offline"),
          v.literal("below_floor"),
          v.literal("freezing"),
          v.literal("pane_refused"),
        ),
        owner_user_id: v.id("users"),
        from: v.object({
          device_id: v.string(),
          label: v.string(),
          user_id: v.id("users"),
        }),
        // Absent when no always-on host could take it.
        to: v.optional(
          v.object({
            device_id: v.string(),
            label: v.string(),
            user_id: v.id("users"),
          }),
        ),
        // The move changed the account it runs and bills under.
        cross_user: v.optional(v.boolean()),
      }),
    ),
    // When the hourly sweep first saw each goal in the brief (orgGoals.goalKey
    // to a time). A role rewrites its brief at every wake, so the brief's own
    // age says nothing about how long a goal has sat with nothing matched.
    goal_first_seen: v.optional(v.record(v.string(), v.number())),
    // Standing or program (org-staffing.md S10). A program ends with a plan,
    // a project or a date; when the end comes org.health raises program_ended
    // and the next review proposes what `then` says. Absent = undeclared.
    tenure: v.optional(
      v.union(
        v.object({ kind: v.literal("standing") }),
        v.object({
          kind: v.literal("program"),
          ends: v.union(
            v.object({ plan: v.id("plans") }),
            v.object({ project: v.id("projects") }),
            v.object({ date: v.number() }),
          ),
          then: v.union(v.literal("retire"), v.literal("review")),
        }),
      ),
    ),
    // The face (org-staffing.md S13): a key from @codecast/org/orgAvatars;
    // absent rows draw the default for their handle.
    avatar: v.optional(v.string()),
    // The practical face (S13, @codecast/org/roleIcon): a drawn icon of
    // what the role looks after, as validated shapes. Every role wears both
    // faces; each viewer's setting picks one. Absent until drawn (the hire
    // schedules roleIcons.generateForRole); readers fall back to the monogram.
    icon: v.optional(roleIconValidator),
    // The contact sheet the generator drew the icon on (the icon beside its
    // siblings at sidebar sizes, both themes); absent for a hand-drawn icon.
    icon_preview_id: v.optional(v.id("_storage")),
    created_by: v.id("users"),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_team", ["team_id"])
    .index("by_scope_user", ["scope_user_id"])
    .index("by_team_handle", ["team_id", "handle"])
    .index("by_scope_user_handle", ["scope_user_id", "handle"])
    .index("by_short_id", ["short_id"]),

  // The audit trail of a role's scope (docs/architecture/scopes-and-feed.md
  // F1): scope edits are human only, and every one lands here as a
  // task_history style row until the charter becomes a doc. old/new carry the
  // scope as JSON so a reader can diff what a person added or removed.
  // A role's tokens today, one row per conversation that works for it
  // (lib/orgCaps roleTokensToday): each session's transcript writes only its
  // own row, so they never conflict with a spawn reading the role.
  org_role_tokens: defineTable({
    role_id: v.id("org_roles"),
    conversation_id: v.id("conversations"),
    day: v.string(),
    tokens: v.number(),
  })
    .index("by_conversation_day", ["conversation_id", "day"])
    .index("by_role_day", ["role_id", "day"]),

  org_role_history: defineTable({
    role_id: v.id("org_roles"),
    user_id: v.optional(v.id("users")),
    actor_type: v.union(
      v.literal("user"),
      v.literal("agent"),
      v.literal("system"),
    ),
    action: v.string(),
    field: v.optional(v.string()),
    old_value: v.optional(v.string()),
    new_value: v.optional(v.string()),
    created_at: v.number(),
  }).index("by_role", ["role_id", "created_at"]),
};
