import { defineTable } from "convex/server";
import { v } from "convex/values";
import {
  workflowEdgeValidator,
  workflowNodeValidator,
  workflowSnapshotValidator,
} from "../lib/workflowGraphValidators";

export const workflowTables = {
  workflows: defineTable({
    user_id: v.id("users"),
    team_id: v.optional(v.id("teams")),
    name: v.string(),
    slug: v.string(),
    // What a person reads as the flow's name (the graph's `label`), when it
    // has one. `name` and `slug` stay its key: run creation finds a workflow
    // by name and a line run by its slug, and each run's worktree is named
    // after the graph's name.
    label: v.optional(v.string()),
    goal: v.optional(v.string()),
    source: v.optional(v.string()),
    nodes: v.array(workflowNodeValidator),
    edges: v.array(workflowEdgeValidator),
    model_stylesheet: v.optional(v.string()),
    is_private: v.optional(v.boolean()),
    // ACCESS (computeWorkspaceKey through createDataContext): `team:<id>` for
    // a flow published to the team's pool (flows.md FL2), else `user:<owner>`.
    // team_id is routing only.
    workspace: v.optional(v.string()),
    // Where the graph lives (line-workspace.md LW4): the machine that pushed
    // it from a file, the checkout, the .cast and each station's file
    // (repo-relative), and the hash of the graph as pushed. The app edits and
    // tries a step through that machine; a graph pushed from no file has none.
    origin: v.optional(
      v.object({
        device_id: v.string(),
        root: v.string(),
        file: v.string(),
        files: v.array(
          v.object({
            node: v.string(),
            prompt: v.optional(v.string()),
            script: v.optional(v.string()),
          }),
        ),
        graph_hash: v.string(),
        nodes: v.array(v.object({ id: v.string(), h: v.string() })),
      }),
    ),
    // A line version's scenario (the graph's `serves`): the finding sources
    // whose problems it runs. workflows.lineRouteFor picks by them when a
    // line run starts on a problem; written only by a push from a file.
    serves: v.optional(v.array(v.string())),
    // The library flow this one is a variant of, by slug, when it was saved
    // from a session (flowLibrary.save): its graph is whole, so its base is
    // named here rather than by `extends` (shared flowPool.flowBase reads both).
    variant_of: v.optional(v.string()),
    // Where its runs read the graph (ct-70169): "library" = this row, the
    // current version, on every machine; "repo" = the checkout's file (pinned).
    // Unset: the resolution from before the library (daemonGraph.ts).
    runs_from: v.optional(v.union(v.literal("library"), v.literal("repo"))),
    // The version the row stands at now (ct-98653): the one its last push or save left, which a run started with no
    // version named pins. A place that pushes a graph again keeps its old version, so the newest version by time can
    // be another checkout's.
    version_id: v.optional(v.id("workflow_versions")),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_user_id", ["user_id"])
    .index("by_team_id", ["team_id"])
    .index("by_workspace", ["workspace"])
    .index("by_user_slug", ["user_id", "slug"]),

  // Every version of a pushed graph (line-workspace.md LW4: every save is a
  // version of the step): one row per new graph_hash, or per new place that
  // pushed it, with each station's hash and the stations that moved, so a
  // step's history reads its saves whether or not a run has read them yet.
  workflow_versions: defineTable({
    workflow_id: v.id("workflows"),
    graph_hash: v.string(),
    nodes: v.array(v.object({ id: v.string(), h: v.string() })),
    // Stations whose hash differs from the version before (all of them on the first).
    changed: v.array(v.string()),
    by: v.id("users"),
    at: v.number(),
    // The version itself (ct-70169): a run in the library runs it, and a restore writes it back.
    snapshot: v.optional(workflowSnapshotValidator),
    // A flow outside the library keeps its graph apart (ct-98653), so a list of versions never loads it: a run
    // reads the version it started on (workflow_runs.graph_version_id, convex lib/runGraph.ts).
    graph_id: v.optional(v.id("workflow_version_graphs")),
    // The checkout on a machine the push read its file from; absent for a push from no file.
    pushed_from: v.optional(
      v.object({ device_id: v.string(), root: v.string() }),
    ),
    // The versions a run pinned to this one resumes with (lib/runGraph.ts): "place:<device>:<root>" for a push from
    // a file, "library" for a library flow. Only a later version of its line supersedes a pinned run. A push from no
    // file has none: its run resumes with its own pinned graph. Unset too on versions from before ct-98653.
    line: v.optional(v.string()),
    // Its number in the row's history (`v<seq>`), from ct-98653 on.
    seq: v.optional(v.number()),
  })
    .index("by_workflow_at", ["workflow_id", "at"])
    .index("by_workflow_line", ["workflow_id", "line", "at"]),

  // A pushed graph's content, once per row per content (`key`, a hash of the
  // whole snapshot): the versions that pushed the same graph share it.
  workflow_version_graphs: defineTable({
    workflow_id: v.id("workflows"),
    key: v.string(),
    snapshot: workflowSnapshotValidator,
  }).index("by_workflow_key", ["workflow_id", "key"]),

  // A person's verdict on one decision a line step made (line-workspace.md
  // LW4): the step at `node_id` in run `run_id` decided right or wrong, with
  // a note. A step's labels are its test set. One row per person per
  // decision (`key` = run:node:user); access is the run's workspace key, so
  // whoever reads the run reads its labels.
  line_labels: defineTable({
    key: v.string(),
    workspace: v.string(),
    team_id: v.optional(v.id("teams")),
    project_id: v.optional(v.id("projects")),
    // The decision's subject: a run's step, or a judge's finding (judgeReview.labelFinding).
    run_id: v.optional(v.id("workflow_runs")),
    signal_id: v.optional(v.id("signals")),
    node_id: v.string(),
    verdict: v.union(v.literal("right"), v.literal("wrong")),
    note: v.optional(v.string()),
    by: v.id("users"),
    at: v.number(),
  })
    .index("by_key", ["key"])
    .index("by_workspace_at", ["workspace", "at"]),

  // A person's conversation with a project's line (line-workspace.md LW4,
  // convex/lineChat.ts): what they said, each ask naming the session it went
  // to; the replies are read back from those sessions' transcripts. One row
  // per person per project, readable by that person only. line_conversation_id
  // is the session spawned to answer when the project had no lead to ask.
  line_chats: defineTable({
    project_id: v.id("projects"),
    user_id: v.id("users"),
    line_conversation_id: v.optional(v.id("conversations")),
    asks: v.array(
      v.object({
        client_id: v.string(),
        text: v.string(),
        at: v.number(),
        user_id: v.id("users"),
        conversation_id: v.id("conversations"),
        graph: v.optional(v.string()),
      }),
    ),
    created_at: v.number(),
    updated_at: v.number(),
  }).index("by_project_user", ["project_id", "user_id"]),

  // One case of a Try (line-workspace.md LW4): a step's edited prompt run on
  // a past case through the dry-run harness with writes refused, on the
  // machine that pushed the graph. `old` is what the step decided when the
  // case ran, `new` what it decided with the edit; nothing ships from a try.
  // Access is the case's run's workspace key, like its labels.
  line_tries: defineTable({
    key: v.string(), // `${try_id}:${run_id}`
    try_id: v.string(),
    workspace: v.string(),
    team_id: v.optional(v.id("teams")),
    project_id: v.optional(v.id("projects")),
    workflow_id: v.id("workflows"),
    node_id: v.string(),
    run_id: v.id("workflow_runs"),
    case_id: v.optional(v.id("tasks")),
    by: v.id("users"),
    at: v.number(),
    updated_at: v.number(),
    status: v.union(
      v.literal("queued"),
      v.literal("running"),
      v.literal("done"),
      v.literal("not_tryable"),
      v.literal("failed"),
    ),
    reason: v.optional(v.string()),
    // The template the case ran with differed from the one the edit starts from.
    older_text: v.optional(v.boolean()),
    model: v.string(),
    // The step's hash the edit starts from, and a hash of the edited text.
    base_hash: v.optional(v.string()),
    text_hash: v.string(),
    via: v.optional(v.union(v.literal("patch"), v.literal("checkpoint"))),
    old: v.object({
      outcome: v.optional(v.string()),
      words: v.optional(v.string()),
      result: v.optional(v.any()),
    }),
    new: v.optional(
      v.object({
        status: v.optional(v.string()),
        words: v.optional(v.string()),
        result: v.optional(v.any()),
      }),
    ),
    reply: v.optional(v.string()),
    cost_usd: v.optional(v.number()),
    turns: v.optional(v.number()),
    refused: v.optional(v.array(v.string())),
    took_ms: v.optional(v.number()),
    device_id: v.string(),
    // The daemon command that carries the try: a machine that never picks it up lets it expire.
    command_id: v.optional(v.id("daemon_commands")),
  })
    .index("by_try", ["try_id"])
    .index("by_project_at", ["project_id", "at"]),

  // One Ship control (docs/architecture/ship.md): every press of Ship, from
  // a task, a session, a pull request, a change card or `cast ship run`. The
  // plan is what the popover said at the press; the ship session (or the line
  // run whose card it answered) carries the progress.
  ship_runs: defineTable({
    target_key: v.string(),
    target_kind: v.union(
      v.literal("task"),
      v.literal("conversation"),
      v.literal("pull_request"),
    ),
    user_id: v.id("users"),
    plan: v.any(),
    conversation_id: v.optional(v.id("conversations")),
    decision_id: v.optional(v.id("session_decisions")),
    workflow_run_id: v.optional(v.id("workflow_runs")),
    // The web's optimistic press: the row the server writes supersedes it.
    client_key: v.optional(v.string()),
    created_at: v.number(),
  })
    .index("by_target", ["target_key", "created_at"])
    .index("by_conversation", ["conversation_id"]),

  // What one trial run cost: its station sessions priced from their token
  // totals, the one home of that fact (lineTrial.priceRunsTick writes it,
  // trialSpend sums it). Its own small table so a trial's spend reads ~200
  // bytes a run, never the runs or their sessions. Opened when the run is
  // created (lib/trialRunPrices.ts), so the row count is the trial's run
  // count. `settled`: the run ended long enough ago that its sessions are
  // done, so it is not priced again until the run moves.
  // sessions/usd/tokens/unpriced_tokens cover every session (usd at API list
  // price); `key` is the part on a metered provider key, which bills money.
  // The rest ran on subscription accounts (`providers`): quota, not a bill.
  // `device`: the machine the run ran on, whose accounts the quota reads.
  trial_run_prices: defineTable({
    project_id: v.id("projects"),
    run_id: v.id("workflow_runs"),
    run_created_at: v.number(),
    sessions: v.number(),
    usd: v.number(),
    tokens: v.number(),
    unpriced_tokens: v.number(),
    key: v.optional(
      v.object({ sessions: v.number(), tokens: v.number(), usd: v.number() }),
    ),
    providers: v.optional(v.array(v.string())),
    device: v.optional(v.string()),
    at: v.number(),
    settled: v.boolean(),
  })
    .index("by_project_created", ["project_id", "run_created_at"])
    .index("by_run", ["run_id"]),

  workflow_runs: defineTable({
    user_id: v.id("users"),
    workflow_id: v.optional(v.id("workflows")),
    task_id: v.optional(v.id("tasks")),
    plan_id: v.optional(v.id("plans")),
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("paused"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    current_node_id: v.optional(v.string()),
    node_statuses: v.array(
      v.object({
        node_id: v.string(),
        status: v.union(
          v.literal("pending"),
          v.literal("running"),
          v.literal("completed"),
          v.literal("failed"),
        ),
        outcome: v.optional(v.string()),
        session_id: v.optional(v.string()),
        started_at: v.optional(v.number()),
        completed_at: v.optional(v.number()),
        // Dynamic-workflow agents carry their own label/phase/tokens (no stored graph to look them up in)
        label: v.optional(v.string()),
        phase: v.optional(v.string()),
        tokens: v.optional(v.number()),
        result_preview: v.optional(v.string()),
        // Live "what it's doing" line for a running agent (runtime's last tool-call summary)
        activity: v.optional(v.string()),
        // What a call node's model calls cost, summed over its visits (learning-loop.md LL1).
        cost_usd: v.optional(v.number()),
        // How many times the run has entered this station; the graph's max_visits is its limit.
        visits: v.optional(v.number()),
      }),
    ),
    goal_override: v.optional(v.string()),
    project_path: v.optional(v.string()),
    primary_session_id: v.optional(v.string()),
    primary_conversation_id: v.optional(v.id("conversations")),
    // The session that ran `cast workflow run`: session nodes spawn under it
    // (spawned_by, and so its org role) whichever process executes the run.
    spawner_conversation_id: v.optional(v.id("conversations")),
    // The run is waiting on the session its change came from (flows.md FL4): the station that sent it work, since
    // when, and what it sent, cut short. Cleared when the session settles and when the run ends.
    waiting_on_session: v.optional(
      v.object({
        node_id: v.string(),
        conversation_id: v.string(),
        since: v.number(),
        note: v.string(),
      }),
    ),
    // The role whose line started the run (the sweep, LE6). Its open cards
    // count by this, so a role with no standing session, or one whose
    // standing session changed, still holds its slots (learning-loop.md LL5).
    org_role_id: v.optional(v.id("org_roles")),
    tmux_session: v.optional(v.string()),
    gate_prompt: v.optional(v.string()),
    gate_choices: v.optional(
      v.array(
        v.object({
          key: v.string(),
          label: v.string(),
          target: v.string(),
        }),
      ),
    ),
    gate_response: v.optional(v.string()),
    // the-line.md L4: the decision row the open gate is; gate_prompt and
    // gate_choices above stay as a mirror for old readers.
    gate_decision_id: v.optional(v.id("session_decisions")),
    gate_node_id: v.optional(v.string()),
    // the-line.md L8: workspace is ACCESS (one equality per read), team_id is
    // ROUTING. Written at create; older rows are backfilled from user_id.
    workspace: v.optional(v.string()),
    team_id: v.optional(v.id("teams")),
    fail_reason: v.optional(v.string()),
    // "routine" = our DOT-graph runs (default/legacy); "workflow" = Anthropic dynamic workflows
    run_kind: v.optional(v.union(v.literal("routine"), v.literal("workflow"))),
    external_run_id: v.optional(v.string()), // the runtime's wf_<id>; idempotent upsert key for snapshot ingest
    workflow_name: v.optional(v.string()),
    phases: v.optional(
      v.array(v.object({ title: v.string(), detail: v.optional(v.string()) })),
    ),
    total_tokens: v.optional(v.number()),
    agent_count: v.optional(v.number()),
    created_at: v.number(),
    updated_at: v.number(),
    // Public sharing: "anyone with the link" (publicShare.ts).
    share_token: v.optional(v.string()),
    // The line's merge step landed (the-line.md L12): what went where, when.
    // `authorized`: on a merge no role is behind, the person whose word allowed it and why (orgLineMerge.personAuthorized).
    merge: v.optional(
      v.object({
        sha: v.string(),
        branch: v.string(),
        into: v.string(),
        at: v.number(),
        pr_url: v.optional(v.string()),
        authorized: v.optional(
          v.object({ user_id: v.id("users"), why: v.string() }),
        ),
      }),
    ),
    // The run's own graph cleared it to land with no card (orgLineMerge.clearForMerge): when, the script station that
    // wrote it and its words, the runner's account, and the attempt (runAttempt). Valid only in that attempt; every
    // resume, reask and land-again drops it.
    merge_cleared: v.optional(
      v.object({
        at: v.number(),
        node_id: v.string(),
        why: v.string(),
        by: v.id("users"),
        attempt: v.number(),
      }),
    ),
    // The CI station's verdict as it reported it from its own running node (orgLineMerge.recordCiVerdict): green or
    // not on which pull-request head, in which attempt. A clearance to land needs a green one on the head it merges.
    // `ci_changed`: the pull request edits CI's own config, so a clearance also needs a person's Ship on the run's card.
    ci_verdict: v.optional(
      v.object({
        node_id: v.string(),
        green: v.boolean(),
        head_sha: v.string(),
        ci_changed: v.optional(v.boolean()),
        at: v.number(),
        attempt: v.number(),
      }),
    ),
    // The reviewer's verdict as its own session reported it (orgLineMerge.recordReviewVerdict): on which head, in which round.
    review_verdict: v.optional(
      v.object({
        node_id: v.string(),
        verdict: v.string(),
        head_sha: v.string(),
        round: v.optional(v.string()),
        at: v.number(),
        attempt: v.number(),
      }),
    ),
    // The Merge station's own rebases of a reviewed head, pushed to be tested again (orgLineMerge.recordStationRebase):
    // a review of `from` covers `to`, which differs only by the default branch it sits on. The newest few.
    station_rebases: v.optional(
      v.array(
        v.object({
          from: v.string(),
          to: v.string(),
          at: v.number(),
          attempt: v.number(),
        }),
      ),
    ),
    graph_hash: v.optional(v.string()), // LE14: content hash of the graph the runner executed (parser.graphHash)
    graph_nodes: v.optional(
      v.array(v.object({ id: v.string(), h: v.string() })),
    ), // LE14: each station's hash in that graph (parser.graphNodeHashes)
    // The machine whose runner drives the run (its device id): where the run
    // is resumed when that runner dies (cli workflow/runResume.ts).
    runner_device: v.optional(v.string()),
    // A run placed on another of its owner's machines (`cast flow run --device`): the change it works on, pushed to
    // origin, which that machine fetches and freezes in its own checkout before the run starts (cli workflow/placedChange.ts).
    placed_change: v.optional(v.any()),
    // The last time a person asked for the run to be resumed (the trace's Resume).
    resume_requested_at: v.optional(v.number()),
    // A rerun from the trial page: its runner sets the earlier run's branch
    // aside and starts from origin/main (cli lineTrialBranch.ts).
    fresh_branch: v.optional(v.boolean()),
    // The version of its workflows row the run started on, or the one its runner reported loading since
    // (lib/runGraph.ts, ct-98653). The row is one per (user, slug), rewritten by every checkout and team that
    // pushes the slug, so the run's stations, agents and supersession read this, never the row. Unset on a run
    // from before pins, which reads the row.
    graph_version_id: v.optional(v.id("workflow_versions")),
    // The library versions the run executes, its flow and the base it extends (flowVersions.ts).
    flow_versions: v.optional(
      v.array(
        v.object({
          workflow_id: v.id("workflows"),
          version_id: v.id("workflow_versions"),
        }),
      ),
    ),
    // When a failed run was last resumed at a station as a new attempt: its
    // runner counts each station's visits again from then (cli runResume.ts).
    visits_reset_at: v.optional(v.number()),
    // A failed run waiting for a free slot on its own machine to resume at `at`
    // (cast workflow resume --queue): the line's sweep resumes it there, ahead
    // of new starts (orgLine.planSweep), onto the current flow when asked.
    resume_queued: v.optional(
      v.object({
        at: v.string(),
        current_flow: v.optional(v.boolean()),
        by: v.id("users"),
        since: v.number(),
      }),
    ),
    // When a re-pin moved the live run onto newer flow versions (flowVersions.repinLiveRuns). Its runner holds the
    // graph it loaded at start, so the run's machine restarts the runner once the run waits at a gate (daemon
    // resumeOrphanedWorkflowRuns); the new runner's first report clears it.
    restart_runner_at: v.optional(v.number()),
    // A place at a station that takes only so many runs at once (the line profile's caps.stations), held from
    // admission (admitToStation) until the run reports another station or ends.
    station_place: v.optional(
      v.object({ node_id: v.string(), at: v.number() }),
    ),
  })
    .index("by_share_token", ["share_token"])
    // A daemon's sweep for its own live runs whose runner is gone.
    .index("by_runner_device_status", ["runner_device", "status"])
    .index("by_user_id", ["user_id"])
    // One person's live runs (sessionMigrations.movabilityFacts), without reading everyone's.
    .index("by_user_status", ["user_id", "status"])
    .index("by_workflow_id", ["workflow_id"])
    .index("by_external_run", ["external_run_id"])
    .index("by_status", ["status"])
    // the-line.md L8: one equality per read for the workspace, and the
    // task page / scope feed lookups.
    .index("by_workspace_updated", ["workspace", "updated_at"])
    // A status asked of a workspace reads that status's runs, never the newest few filtered.
    .index("by_workspace_status_updated", ["workspace", "status", "updated_at"])
    .index("by_task", ["task_id"])
    .index("by_plan", ["plan_id"])
    // LE6: a role's line runs still in flight hold its card slots.
    .index("by_spawner_status", ["spawner_conversation_id", "status"])
    .index("by_org_role_status", ["org_role_id", "status"])
    // Sparse in effect: only runs whose fix merged carry merge.at. The deploy
    // stage's waiting set and a marker's carries read a workspace's merges
    // here, never its runs whole (deploys.md DP2).
    .index("by_workspace_merged", ["workspace", "merge.at"])
    // A session flow's runs (session_flows): the runs on one graph in one workspace, newest first.
    .index("by_workspace_graph", ["workspace", "graph_hash", "updated_at"])
    // Sparse in effect: only runs queued to resume carry resume_queued, read oldest first by the sweep.
    .index("by_resume_queued", ["resume_queued.since"]),
};
