import { defineTable } from "convex/server";
import { v } from "convex/values";

export const deploymentTables = {
  // A deploy as an object (docs/architecture/deploys.md): one version going
  // live on one target, with what it carried and who started it. The line's
  // deploy stage asks for one (status requested); the team's deploy path
  // finishes it when its marker arrives (changesDeploy.markDeploy, an ingest
  // deploy item), and a marker nobody asked for records one of its own. The
  // marker stays an external_events row (the team stream, triggers); its
  // meta.deploy names this row's short id.
  deploys: defineTable({
    short_id: v.string(), // "dp-N"
    // The store's stub of a deploy asked for from the web, which this row supersedes.
    client_key: v.optional(v.string()),
    workspace: v.string(),
    team_id: v.optional(v.id("teams")),
    project_id: v.optional(v.id("projects")),
    // The surface or environment it went to: "backend", "production".
    target: v.string(),
    status: v.union(
      v.literal("requested"),
      v.literal("running"),
      v.literal("live"),
      v.literal("failed"),
      v.literal("cancelled"),
    ),
    trigger: v.union(
      v.literal("person"),
      v.literal("role"),
      v.literal("schedule"),
      v.literal("count"),
      v.literal("outside"),
    ),
    started_by: v.optional(
      v.object({
        kind: v.union(
          v.literal("person"),
          v.literal("role"),
          v.literal("line"),
          v.literal("source"),
          v.literal("cli"),
        ),
        name: v.string(),
        user_id: v.optional(v.id("users")),
        role_id: v.optional(v.id("org_roles")),
      }),
    ),
    // Who reported it: "cast ship mark", or the source's name.
    source: v.string(),
    source_id: v.optional(v.id("event_sources")),
    event_ids: v.array(v.id("external_events")),
    repository: v.optional(v.string()),
    sha: v.optional(v.string()),
    previous_sha: v.optional(v.string()),
    // The sha's place in main's order (its commit's commits.main_at), stamped when the deploy's range is filled: a
    // merge is in the deploy's code when it reached main at or before this (packages/line/src/causeHistory.ts carryingDeploys).
    cut_at: v.optional(v.number()),
    version: v.optional(v.string()),
    // The CI run or the page that shows the deploy.
    url: v.optional(v.string()),
    // The GitHub Actions run that carried it (actionsRunKey of url, `<id>` or `<id>/attempts/<n>`), stamped wherever
    // url is written: how a run's marker finds its deploy and a run link in a message resolves to it.
    workflow_run: v.optional(v.string()),
    // What went out, with the session whose Codecast-Session trailer each commit carries.
    commits: v.optional(
      v.array(
        v.object({
          sha: v.string(),
          subject: v.string(),
          author: v.optional(v.string()),
          conversation_id: v.optional(v.id("conversations")),
          task_ids: v.optional(v.array(v.id("tasks"))),
        }),
      ),
    ),
    // The fixes it carried (packages/line/src/deploys.ts DeployCarry).
    carries: v.array(
      v.object({
        task_id: v.id("tasks"),
        run_id: v.optional(v.id("workflow_runs")),
        decision_id: v.optional(v.id("session_decisions")),
        merge_sha: v.optional(v.string()),
        merged_at: v.optional(v.number()),
        pr_url: v.optional(v.string()),
        how: v.union(
          v.literal("sent"),
          v.literal("same commit"),
          v.literal("deployed after the merge"),
        ),
      }),
    ),
    // Why it failed, or the deploy command's last words.
    note: v.optional(v.string()),
    // What was asked (DP13): a deploy of main's head, a redeploy of an earlier
    // deploy's sha, or the target's rollback command; rollback_of names the
    // deploy (dp-N) whose sha it puts back.
    action: v.optional(
      v.union(
        v.literal("deploy"),
        v.literal("redeploy"),
        v.literal("rollback"),
      ),
    ),
    rollback_of: v.optional(v.string()),
    // Files under the target's sources that were uncommitted when it went out:
    // the sha names every commit up to it, and these went too.
    dirty: v.optional(v.number()),
    // The hostname of the machine that pushed it.
    machine: v.optional(v.string()),
    // Which push path sent it. The dev watcher's pushes are not deploys: they are dev_pushes.
    pushed_via: v.optional(v.literal("deploy.sh")),
    // What it put on the target that was not there before, and what it took off, as names (`fn:<module>:<export>`,
    // `http:<METHOD> <path>`, `index:<table>.<index>`, `table:<table>`). At most 500 each, 200 characters a name.
    // Present exactly when the push's diff ran (possibly empty).
    adds: v.optional(v.array(v.string())),
    drops: v.optional(v.array(v.string())),
    // When the push's diff read prod: a clean deploy that kept a name proves it committed only for pushes made before
    // this (deploys.adderOf).
    changes_read_at: v.optional(v.number()),
    // The `cast ship checkout` pass that sent it (DP11).
    ship_pass_id: v.optional(v.id("ship_passes")),
    // The line-deploy run that carries it through its steps (DP8): each
    // step's state is that run's station, read from the run, never copied here.
    run_id: v.optional(v.id("workflow_runs")),
    // A deploy still open when a newer one of its target went live, closed as cancelled: that deploy's short id.
    // A later report of its own (live, failed) still lands on it.
    superseded_by: v.optional(v.string()),
    created_at: v.number(),
    live_at: v.optional(v.number()),
    finished_at: v.optional(v.number()),
    updated_at: v.number(),
  })
    .index("by_short_id", ["short_id"])
    .index("by_workspace_created", ["workspace", "created_at"])
    .index("by_source_created", ["source_id", "created_at"])
    .index("by_repository_created", ["repository", "created_at"])
    .index("by_workspace_target_created", ["workspace", "target", "created_at"])
    .index("by_workflow_run", ["workflow_run"]),

  // A dev watcher's push (scripts/gated-push.ts) of someone's working tree to a
  // target, which is not a deploy: nobody asked for it, it carries no fix and
  // ends no deploy's window, so it never enters `deploys`. One row per pusher,
  // machine, repository and sha between deploys of the target: a save lands on
  // its pusher's row from that machine that began after the target's live
  // deploy went live, and is a row of its own otherwise
  // (deploys.recordDevPush). Read for who added a name (deploys.adderOf), for
  // the notice that a push dropped someone's work, and for the uncommitted
  // work a target runs on top of its live deploy (deployTargetsState).
  dev_pushes: defineTable({
    // Access: the key the deploy of the same push would carry (`team:<id>`).
    workspace: v.string(),
    // Routing: the team whose deploys these are.
    team_id: v.optional(v.id("teams")),
    repository: v.optional(v.string()),
    target: v.string(),
    sha: v.string(),
    // The hostname of the machine that pushed.
    machine: v.optional(v.string()),
    started_by: v.optional(
      v.object({
        kind: v.union(
          v.literal("person"),
          v.literal("role"),
          v.literal("line"),
          v.literal("source"),
          v.literal("cli"),
        ),
        name: v.string(),
        user_id: v.optional(v.id("users")),
        role_id: v.optional(v.id("org_roles")),
      }),
    ),
    // Uncommitted files under the target's sources at the last save.
    dirty: v.number(),
    // The net change of the row's saves against what the target ran before the row began, by name (as deploys.adds):
    // a save's add of a name the row dropped takes it off drops, and its drop of a name the row added takes it off adds.
    adds: v.array(v.string()),
    drops: v.array(v.string()),
    created_at: v.number(),
    // The last save.
    live_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_workspace_target_live", ["workspace", "target", "live_at"])
    .index("by_workspace_target_machine_sha", [
      "workspace",
      "target",
      "machine",
      "sha",
      "created_at",
    ]),
};

export const checkoutFlowTables = {
  // A repository's own flows (`.codecast/flows`), as the viewer's checkouts of
  // it report them (repoFlows.ts, packages/flows/src/repoFlows.ts): the flows
  // `cast flow run` takes there ahead of the shipped and published ones. One
  // row per person and checkout (`root`, its git top level): a repository's
  // worktrees hold different flows. The owner alone reads it. `flows` holds
  // each graph parsed, its nodes the parser's FlowNodeIn, which grows with
  // the parser, so they are not pinned field by field here.
  checkout_flows: defineTable({
    user_id: v.id("users"),
    root: v.string(),
    repository: v.string(),
    hash: v.string(),
    flows: v.array(
      v.object({
        slug: v.string(),
        name: v.string(),
        kind: v.union(v.literal("line"), v.literal("segment")),
        label: v.string(),
        description: v.union(v.string(), v.null()),
        takes: v.array(v.string()),
        nodes: v.array(v.any()),
        edges: v.array(
          v.object({
            from: v.string(),
            to: v.string(),
            label: v.optional(v.string()),
            condition: v.optional(v.string()),
          }),
        ),
      }),
    ),
    updated_at: v.number(),
  })
    .index("by_user_root", ["user_id", "root"])
    // A session in a checkout that never reported reads its repository's newest report.
    .index("by_user_repository_updated", [
      "user_id",
      "repository",
      "updated_at",
    ]),
};
