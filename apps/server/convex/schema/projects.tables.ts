import { defineTable } from "convex/server";
import { v } from "convex/values";
import { metricValidator } from "../lib/metricSeries";
import { publishedLineProfileValidator } from "../lib/lineProfileValidator";
import { goalEnvValidator } from "../envSchema";
import {
  decisionValidator,
  intentSourceValidator,
  milestoneValidator,
  questionValidator,
  scoreValidator,
} from "../lib/initiativeValidators";

export const projectTables = {
  // --- Task Layer: Projects, Tasks, Docs ---

  projects: defineTable({
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    // ACCESS axis — see tasks.workspace.
    workspace: v.optional(v.string()),
    short_id: v.optional(v.string()),
    title: v.string(),
    description: v.optional(v.string()),
    // Standing instructions every session in the project starts with
    // (session-projects.md SP6), verbatim. Capped by PROJECT_INSTRUCTIONS_MAX.
    instructions: v.optional(v.string()),
    status: v.union(
      v.literal("planning"),
      v.literal("active"),
      v.literal("paused"),
      v.literal("done"),
    ),
    color: v.optional(v.string()),
    icon: v.optional(v.string()),
    project_path: v.optional(v.string()),
    target_date: v.optional(v.number()),
    labels: v.optional(v.array(v.string())),
    // The key a web create painted its stub under; the synced row carrying it
    // supersedes that stub (the projects collection's altKey).
    client_key: v.optional(v.string()),
    // ── Charter (docs/architecture/org-staffing.md S7) ──
    // The direction a role reads before the task list: the goal, how success
    // is measured, how urgent, which role owns the line, what it will not do,
    // what could go wrong, and the daily budget the owner role may spend.
    goal: v.optional(v.string()),
    success_metrics: v.optional(v.array(v.string())),
    // Its numbers, the goal's shape (lib/metricSeries): each with a target,
    // read live from the metric watch it names (projects.projectMetricsPatch).
    metrics: v.optional(v.array(metricValidator)),
    priority: v.optional(
      v.union(
        v.literal("p0"),
        v.literal("p1"),
        v.literal("p2"),
        v.literal("p3"),
      ),
    ),
    owner_role_id: v.optional(v.id("org_roles")),
    // The project's canonical session (session-projects.md SP4): the one its
    // own composer first started, while it has no seated lead. A lead hired
    // from the project adopts it as the seat's standing session.
    default_session_id: v.optional(v.id("conversations")),
    // Named after its main session (started with the composer's new project
    // switch): the session's generated title becomes the project's until a
    // person renames the project.
    title_from_session: v.optional(v.boolean()),
    non_goals: v.optional(v.array(v.string())),
    risks: v.optional(v.array(v.string())),
    budget: v.optional(
      v.object({
        tokens_per_day: v.optional(v.number()),
        hands_per_day: v.optional(v.number()),
      }),
    ),
    // Ongoing (a business line that outlives any plan) or bounded (an effort
    // with an end); a bounded project is what a program role ends with
    // (org-staffing.md S10).
    horizon: v.optional(v.union(v.literal("ongoing"), v.literal("bounded"))),
    // The repo's resolved line profile (line-profile.md LP3), published by
    // `cast line profile --publish` onto every project its finders file
    // into: the finders for this project, every other value with where it
    // came from, the loader's notes and warnings, and the checkout and device
    // that published it. The repo holds the truth; this copy is what the app
    // reads. default: this is that profile's `[line] project`. Shape:
    // @codecast/line/lineProfile.
    line_profile: v.optional(publishedLineProfileValidator),
    // A trial project (lineTrial.ts): its line runs go through every station
    // up to the decision card and stop there. A gate asks nobody; it becomes a
    // trial_cards row answered on the trial review page, and nothing merges.
    // graph and cwd: the trial graph `cast line trial run` starts, and the
    // checkout it runs from, on the machine that turned the trial on.
    // dispatch: when set, the trial starts its own runs (lineTrial.dispatch),
    // the problems most in need first, while its billed money stays under
    // cap_usd and its subscription accounts have quota; last is what the
    // latest pass started, or why it held.
    line_trial: v.optional(
      v.object({
        since: v.number(),
        by: v.id("users"),
        graph: v.optional(v.string()),
        cwd: v.optional(v.string()),
        // The graph a problem of cases against a judge runs instead (LL11's
        // judge route), its checkout, and its digraph name, which tells its
        // runs apart from the product graph's when a dispatch picks one to copy.
        // `decides`: the role a judge-route run's decision belongs to (a fix to
        // the judges changes how every conversation is graded, so it is that
        // role's call, not the trial owner's; trialDecision.trialDeciderOf).
        judge: v.optional(
          v.object({
            graph: v.string(),
            cwd: v.string(),
            name: v.string(),
            decides: v.optional(v.id("org_roles")),
          }),
        ),
        // max_runs: the trial's line runs (every route, since it began) past
        // which the dispatcher starts none, next to the dollar cap.
        dispatch: v.optional(
          v.object({
            cap_usd: v.number(),
            max_runs: v.optional(v.number()),
            last: v.optional(
              v.object({
                at: v.number(),
                started: v.array(v.string()),
                held: v.optional(v.string()),
              }),
            ),
          }),
        ),
        // Money the trial was billed outside codecast's own accounting (shadow
        // harnesses and evals on an API key), recorded by `cast line trial
        // spend add`; `billed_by` names the key or account that billed it. It
        // counts toward the dispatcher's cap with the rest of billed money.
        outside: v.optional(
          v.array(
            v.object({
              usd: v.number(),
              what: v.string(),
              billed_by: v.optional(v.string()),
              at: v.number(),
              by: v.id("users"),
            }),
          ),
        ),
        // The one stack the trial's decisions sit in (lineTrial.trialStackOf).
        stack_id: v.optional(v.id("decision_stacks")),
        // The viewing password every page a trial decision attaches gets
        // (trialDecision.gateTrialPages): a trial's pages quote customer text.
        page_password: v.optional(v.string()),
      }),
    ),

    created_at: v.number(),
    updated_at: v.number(),
    // Public sharing: "anyone with the link" (publicShare.ts).
    share_token: v.optional(v.string()),
  })
    .index("by_share_token", ["share_token"])
    .index("by_user_id", ["user_id"])
    .index("by_user_status", ["user_id", "status"])
    .index("by_team_id", ["team_id"])
    .index("by_workspace", ["workspace"])
    .index("by_short_id", ["short_id"])
    // A fresh role restart moves projects off the seat it retires.
    .index("by_default_session", ["default_session_id"])
    // Trial projects that start their own runs (lineTrial.dispatch).
    .index("by_trial_dispatch_cap", ["line_trial.dispatch.cap_usd"])
    // Trial projects (lineTrial.priceRunsTick prices their runs).
    .index("by_trial_since", ["line_trial.since"]),

  // How many of a project's board tasks sit in one (workspace, status) bucket,
  // kept by the write interceptor (lib/projectTaskCounts.ts) so a project list
  // never reads the tasks themselves.
  project_task_counts: defineTable({
    project_id: v.id("projects"),
    workspace: v.string(),
    status: v.string(),
    count: v.number(),
  }).index("by_bucket", ["project_id", "workspace", "status"]),

  // Single row: the backfill cursor for project_task_counts (tasks created at
  // or before `through` are counted; `done` once the backfill caught up).
  project_task_count_state: defineTable({
    through: v.number(),
    done: v.boolean(),
  }),

  // An initiative (docs/architecture/initiatives-projects-role-page.md I1): a
  // goal the company is trying to reach, carried by an intentional set of
  // projects, with one owner who drives it. The row shape is
  // @codecast/goals/initiative. Low volume and read whole, so it
  // stays off the change feed: the web reads one live query per workspace.
  initiatives: defineTable({
    // Who created it. The access stamp reads `user_id` on every table.
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    // ACCESS axis — see tasks.workspace.
    workspace: v.string(),
    short_id: v.string(), // "in-N"
    // The optimistic stub's key; the row that carries it supersedes the stub.
    client_key: v.optional(v.string()),
    title: v.string(),
    // Purpose, scope and context.
    description: v.optional(v.string()),
    status: v.union(
      v.literal("proposed"),
      v.literal("planned"),
      v.literal("active"),
      v.literal("completed"),
      v.literal("cancelled"),
    ),
    // A person or a role (org-roles-run-work.md R5). Absent = nobody drives it.
    owner: v.optional(
      v.union(
        v.object({ kind: v.literal("user"), user_id: v.id("users") }),
        v.object({ kind: v.literal("role"), role_id: v.id("org_roles") }),
      ),
    ),
    target_date: v.optional(v.number()),
    priority: v.optional(
      v.union(
        v.literal("p0"),
        v.literal("p1"),
        v.literal("p2"),
        v.literal("p3"),
      ),
    ),
    labels: v.optional(v.array(v.string())),
    // Ordered, added on purpose. A project may sit in several initiatives.
    project_ids: v.array(v.id("projects")),
    // One level: a row that has a parent is never a parent itself. The parent
    // is the top level goal this one feeds.
    parent_initiative_id: v.optional(v.id("initiatives")),
    // Where it reads among its siblings, set by hand (the Goals document). Lower
    // first; a goal without one reads after those that have one, by status and date.
    position: v.optional(v.number()),
    // How the goal is measured (@codecast/goals/initiative InitiativeMetric):
    // at most two numbers with a target each. The reported values live in
    // `scoreboard` by key, the template scoreboard's own shape, written by
    // the same recordScores path `cast org template report` uses.
    metrics: v.optional(v.array(metricValidator)),
    // The environments that predict it, ordered by level (@codecast/goals/envs GoalEnv).
    envs: v.optional(v.array(goalEnvValidator)),
    scoreboard: v.optional(v.record(v.string(), scoreValidator)),
    // The intent record (I5, lib/initiativeValidators): every reported value
    // by metric key oldest first, written only with `scoreboard`; why it
    // matters and what done looks like; and four lists edited one entry at a
    // time through initiatives.record.
    score_history: v.optional(v.record(v.string(), v.array(scoreValidator))),
    why: v.optional(v.string()),
    done_when: v.optional(v.string()),
    milestones: v.optional(v.array(milestoneValidator)),
    questions: v.optional(v.array(questionValidator)),
    decisions: v.optional(v.array(decisionValidator)),
    sources: v.optional(v.array(intentSourceValidator)),
    // Copied from the latest update when it is posted; "none" before one.
    health: v.union(
      v.literal("none"),
      v.literal("on_track"),
      v.literal("at_risk"),
      v.literal("off_track"),
    ),
    health_at: v.optional(v.number()),
    latest_update_id: v.optional(v.id("initiative_updates")),
    created_at: v.number(),
    updated_at: v.number(),
    // Public sharing: "anyone with the link" (publicShare.ts).
    share_token: v.optional(v.string()),
  })
    .index("by_share_token", ["share_token"])
    .index("by_user_id", ["user_id"])
    .index("by_team_id", ["team_id"])
    .index("by_workspace", ["workspace"])
    .index("by_short_id", ["short_id"])
    .index("by_parent", ["parent_initiative_id"]),

  // What the owner said about an initiative, and how it is going. Access is
  // the parent initiative's; `workspace` and `team_id` are copies written with
  // the row (an initiative never changes workspace), so a list filters on them
  // without reading the parent.
  initiative_updates: defineTable({
    initiative_id: v.id("initiatives"),
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    workspace: v.string(),
    client_key: v.optional(v.string()),
    body: v.string(),
    health: v.union(
      v.literal("on_track"),
      v.literal("at_risk"),
      v.literal("off_track"),
    ),
    // A person, or a role through its standing session.
    by: v.union(
      v.object({ kind: v.literal("user"), user_id: v.id("users") }),
      v.object({
        kind: v.literal("role"),
        role_id: v.id("org_roles"),
        conversation_id: v.optional(v.id("conversations")),
      }),
    ),
    at: v.number(),
  }).index("by_initiative_at", ["initiative_id", "at"]),

  // A post on a project's Updates tab: a human status post or an agent's
  // periodic digest. Untracked by the change feed (same trade as
  // task_comments): every write bumps the parent project's updated_at, and the
  // web reads these through reactive queries, so clients stay fresh without
  // first-class sync plumbing. Access is always derived from the parent
  // project (owner or team member) — rows carry no workspace stamp of their
  // own, so they can never drift from the project's scope.
  project_updates: defineTable({
    project_id: v.id("projects"),
    // Short id ("pu-N") so the CLI can address an update for commenting.
    short_id: v.optional(v.string()),
    user_id: v.id("users"),
    author: v.string(),
    // The person behind the post; absent for agent/system authored rows.
    author_user_id: v.optional(v.id("users")),
    author_kind: v.union(v.literal("user"), v.literal("agent")),
    // "update" = a deliberate post; "digest" = an automated roll-up (the
    // weekly what-changed post). The UI badges digests differently.
    kind: v.union(v.literal("update"), v.literal("digest")),
    title: v.optional(v.string()),
    body: v.string(),
    conversation_id: v.optional(v.id("conversations")),
    // The web's optimistic stub id for a post (store/projectUpdatesSlice):
    // the row carrying it supersedes the stub when the list echoes it.
    client_key: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
    edited_at: v.optional(v.number()),
  })
    .index("by_project_created", ["project_id", "created_at"])
    .index("by_short_id", ["short_id"]),

  // Discussion under a project update. Mirrors task_comments: flat thread,
  // denormalized project_id so the timeline can scan one index.
  project_update_comments: defineTable({
    update_id: v.id("project_updates"),
    project_id: v.id("projects"),
    author: v.string(),
    author_user_id: v.optional(v.id("users")),
    author_kind: v.union(v.literal("user"), v.literal("agent")),
    text: v.string(),
    conversation_id: v.optional(v.id("conversations")),
    created_at: v.number(),
  })
    .index("by_update_created", ["update_id", "created_at"])
    .index("by_project_created", ["project_id", "created_at"]),
};
