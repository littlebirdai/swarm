import { defineTable } from "convex/server";
import { v } from "convex/values";
import {
  TEAM_FEATURE_KEYS,
  type TeamFeatureKey,
} from "@codecast/policy/teamFeatures";
import { TASK_STATUS_COLORS } from "@codecast/tasks/statuses";
import { teamPolicyValidator } from "../managedDevicesSchema";
import { taskStatusCategoryValidator } from "./task-status.tables";

// A team's editable task statuses (Linear-style): named statuses within the
// six fixed categories, in display order. Absent = the shared defaults, one
// per category. See @codecast/tasks/statuses for the contract.
const teamTaskStatusesValidator = v.array(
  v.object({
    id: v.string(),
    name: v.string(),
    category: taskStatusCategoryValidator,
    color: v.optional(v.union(...TASK_STATUS_COLORS.map((c) => v.literal(c)))),
  }),
);

// Per-team opt-in features (chat, calls). Only flags that were ever set are
// stored; an absent flag reads as OFF (teamFeatureEnabled in shared
// contracts). Every key optional so a new feature needs no migration.
// A member's level of team visibility and one segment of its time split
// (teamVisibility.ts). Shared by team_memberships and the deleted-team roster.
const teamVisibilityLevelValue = v.union(
  v.literal("hidden"),
  v.literal("activity"),
  v.literal("summary"),
  v.literal("full"),
);

const teamVisibilityLevel = v.optional(teamVisibilityLevelValue);

const visibilitySegment = v.object({
  before: v.number(),
  visibility: teamVisibilityLevelValue,
});

// One optional flag per catalog key, so a new team feature can be stored the
// moment it is catalogued (a hand list here once lacked "line").
const optionalFlag = () => v.optional(v.boolean());

const teamFeaturesValidator = v.object(
  Object.fromEntries(
    TEAM_FEATURE_KEYS.map((k) => [k, optionalFlag()]),
  ) as Record<TeamFeatureKey, ReturnType<typeof optionalFlag>>,
);

export const teamTables = {
  teams: defineTable({
    name: v.string(),
    icon: v.optional(v.string()),
    icon_color: v.optional(v.string()),
    task_statuses: v.optional(teamTaskStatusesValidator),
    // Opt-in features; default off. Enforced server-side at each feature's
    // access chokepoint (teamFeatures.requireTeamFeature), hidden client-side.
    features: v.optional(teamFeaturesValidator),
    // Managed policy (packages/policy/src/managedPolicy.ts), set by an admin in
    // Team settings > Managed devices. Enforced server side for the team's
    // workspace and for every device enrolled in the team (lib/teamPolicyGuard),
    // and sent to those devices on the heartbeat.
    policy: v.optional(teamPolicyValidator),
    // The library flow a session's change is offered first (flows.md FL4): a
    // flow's slug, set by an admin on /flows. Unset: the shipped `change`.
    default_flow: v.optional(v.string()),
    // The role that answers for the team: Slack, team chat, @anchor and
    // decision talk (anchors.workspaceAgentRoleOf). Set by an admin in Team
    // settings. Unset: the Head of People.
    workspace_agent_role_id: v.optional(v.id("org_roles")),
    // IANA zone the team's day is cut in (Changes editions, lib/teamDay.ts).
    // Unset: the earliest admin's users.timezone, else UTC.
    timezone: v.optional(v.string()),
    // Who decides for which areas (decisionAreas.ts): when the members' areas
    // were last set and by whom, and the "Who decides for which areas?" card
    // asked of the admins while none are set, with the split it proposes.
    decision_areas: v.optional(
      v.object({
        set_at: v.optional(v.number()),
        set_by: v.optional(v.id("users")),
        card_id: v.optional(v.id("session_decisions")),
        declined_at: v.optional(v.number()),
        // When the card last found nothing to ask (a solo team, no projects, no admin): asks skip it for a day.
        checked_at: v.optional(v.number()),
        proposal: v.optional(
          v.array(
            v.object({
              user_id: v.id("users"),
              project_ids: v.array(v.id("projects")),
            }),
          ),
        ),
      }),
    ),
    // The one team whose "community" chat channels are the product's public
    // space (codecast.sh/community). Set by an operator
    // (chat.designateCommunityTeam), never by a team's own members: the flag
    // lets this team's admins publish rooms to every visitor, which no team
    // may grant itself.
    community: v.optional(v.boolean()),
    created_at: v.number(),
    invite_code: v.string(),
    invite_code_expires_at: v.optional(v.number()),
    // People with a proven address at this domain can find the team and ask
    // to join (teamDiscovery.ts). Set by an admin, from their own domain.
    discoverable_domain: v.optional(v.string()),
    // Idempotency key from the client's optimistic stub. A retried create
    // (replayed dispatch, timeout after commit) finds the team it already
    // made instead of minting a duplicate.
    client_key: v.optional(v.string()),
    // Soft delete. The row stays as a tombstone: every membership, mapping
    // and chat row is gone, so nobody can reach the team, and a replayed
    // create carrying this row's client_key is refused instead of minting the
    // team again. `deleted_members` is the roster at deletion time, enough for
    // an admin restore to re-seat everyone (teams.restoreTeam).
    deleted_at: v.optional(v.number()),
    deleted_by: v.optional(v.id("users")),
    deleted_members: v.optional(
      v.array(
        v.object({
          user_id: v.id("users"),
          role: v.union(v.literal("member"), v.literal("admin")),
          joined_at: v.number(),
          visibility: teamVisibilityLevel,
          visibility_history: v.optional(v.array(visibilitySegment)),
        }),
      ),
    ),
  })
    .index("by_invite_code", ["invite_code"])
    .index("by_client_key", ["client_key"])
    .index("by_discoverable_domain", ["discoverable_domain"]),

  // A person asking to join a team they found by their work email domain
  // (teamDiscovery.ts). An admin approves or declines.
  team_join_requests: defineTable({
    team_id: v.id("teams"),
    user_id: v.id("users"),
    status: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("declined"),
    ),
    created_at: v.number(),
    decided_at: v.optional(v.number()),
    decided_by: v.optional(v.id("users")),
  })
    .index("by_user_team", ["user_id", "team_id"])
    .index("by_team_status", ["team_id", "status"]),
};

export const teamMembershipTables = {
  // An emailed invite (teams.sendInviteEmail). It holds a free seat while it
  // is pending: sent with the team's current invite code, that code not yet
  // expired, and the address not yet a member. A new invite link revokes it.
  team_invites: defineTable({
    team_id: v.id("teams"),
    email: v.string(),
    invite_code: v.string(),
    invited_by: v.id("users"),
    created_at: v.number(),
    accepted_at: v.optional(v.number()),
    // An admin removed this person; a code generated before this no longer
    // admits them until they are invited again (teams.joinTeam).
    removed_at: v.optional(v.number()),
  }).index("by_team_email", ["team_id", "email"]),

  // The one outstanding code proving a user holds their account email, for
  // finding their team by domain (teamDiscovery.ts). Only a hash is stored.
  work_email_codes: defineTable({
    user_id: v.id("users"),
    email: v.string(),
    code_hash: v.string(),
    expires_at: v.number(),
    attempts: v.number(),
  }).index("by_user", ["user_id"]),

  team_memberships: defineTable({
    user_id: v.id("users"),
    team_id: v.id("teams"),
    role: v.union(v.literal("member"), v.literal("admin")),
    joined_at: v.number(),
    visibility: teamVisibilityLevel,
    // "Share in full going forward": sessions STARTED before a segment's
    // `before` are read at that segment's level; everything after the last
    // boundary at `visibility`. Ascending by `before`; `visibility` is always
    // the highest level (teamVisibility.ts nextMembershipVisibility).
    visibility_history: v.optional(v.array(visibilitySegment)),
    // The member this person reports to in the org chart (orgPeople.ts), a
    // member of the same team. Routing for the chart and the inbox's By
    // reports lens only: it grants no access to anyone's sessions.
    reports_to_user_id: v.optional(v.id("users")),
    // Decision areas (decisionAreas.ts): whether this member takes the team's
    // decisions, and the projects they decide for. Routing only; an
    // unaddressed decision about one of these projects may be shared to them
    // (decisionRouting.ts).
    takes_decisions: v.optional(v.boolean()),
    focus_project_ids: v.optional(v.array(v.id("projects"))),
  })
    .index("by_user_id", ["user_id"])
    .index("by_team_id", ["team_id"])
    .index("by_user_team", ["user_id", "team_id"]),
};

export const teamRoutingTables = {
  directory_team_mappings: defineTable({
    user_id: v.id("users"),
    path_prefix: v.string(),
    // The team a share rule sends sessions to. Absent on a "never share"
    // rule, which has no team: it exists to keep its folder out of every
    // share, the repository rule included (privacy.ts matchDirectoryMapping).
    team_id: v.optional(v.id("teams")),
    auto_share: v.boolean(),
    // A lock the owner wrote by hand: sessions in this folder are never
    // shared by any rule. Beats a repository rule from another checkout.
    private: v.optional(v.boolean()),
    // Sessions started before this instant stay private. Absent means every
    // session in the directory is shared, past included. A new mapping is
    // stamped with its creation time unless the member includes the past.
    share_since: v.optional(v.number()),
    // The repository the mapped checkout is a clone of (repositoryKeyOfRemote),
    // stamped from the sessions recorded there. Sessions in any other clone
    // or linked worktree of it resolve to this mapping when no path rule
    // covers them (privacy.ts matchDirectoryMapping).
    repository: v.optional(v.string()),
    created_at: v.number(),
  })
    .index("by_user_id", ["user_id"])
    .index("by_user_team", ["user_id", "team_id"])
    .index("by_team_id", ["team_id"]),
};
