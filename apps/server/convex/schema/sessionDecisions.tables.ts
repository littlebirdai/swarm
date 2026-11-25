import { permissionRemovalValidator } from "../lib/permissionRemoval";
import { ruleRequestValidator } from "../lib/permissionRuleRequest";
import { defineTable } from "convex/server";
import { v } from "convex/values";

export const pendingPermissionTables = {
  pending_permissions: defineTable({
    conversation_id: v.id("conversations"),
    session_id: v.string(),
    tool_name: v.string(),
    arguments_preview: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("denied"),
      v.literal("cancelled"),
    ),
    created_at: v.number(),
    resolved_at: v.optional(v.number()),
    resolved_by: v.optional(v.id("users")),
    // Denormalized conversation owner so getAllRespondedPermissions can index by
    // (owner, resolved_at) instead of scanning the whole table — the scan made
    // that live per-daemon subscription re-run on every other user's writes.
    owner_user_id: v.optional(v.id("users")),
    // Claude Code's permission_suggestions for this call (PermissionUpdate
    // objects, as the PermissionRequest hook handed them over). The card shows
    // them as the rules "Always allow" would add.
    suggestions: v.optional(v.array(v.any())),
    // The answer beyond approve/deny: the reason a denial sends the model, and
    // whether an approval keeps the suggested rules.
    deny_message: v.optional(v.string()),
    remember: v.optional(v.boolean()),
    // Who is asking, for the card: the subagent's type when a subagent raised
    // the prompt, and whether it is Claude Code's built-in safety check (a
    // prompt raised in bypass mode, such as an rm it cannot resolve). The
    // subagent's own conversation holds its steps up to the call.
    subagent_type: v.optional(v.string()),
    subagent_conversation_id: v.optional(v.id("conversations")),
    safety_check: v.optional(v.boolean()),
    // The agent's one-line account of the call, and what each rm in it would
    // delete as the daemon read the disk when the prompt opened.
    intent: v.optional(v.string()),
    removals: v.optional(v.array(permissionRemovalValidator)),
    // What the call asks for in codecast's own rule terms
    // (@codecast/policy/permissionRules): the permission, the patterns it touches, and the
    // rules "always" would keep. An answer re-checks the session's other
    // pending rows against the rules it saved.
    rule_request: v.optional(ruleRequestValidator),
  })
    .index("by_conversation_status", ["conversation_id", "status"])
    .index("by_session", ["session_id"])
    .index("by_owner_resolved", ["owner_user_id", "resolved_at"]),
};

export const sessionDecisionTables = {
  session_decisions: defineTable({
    conversation_id: v.id("conversations"),
    session_id: v.string(),
    // Denormalized owner so the queue subscription indexes by (user, status).
    // Rows created before W2 have no decision_inbox rows: listForUser falls
    // back to this field for them.
    user_id: v.id("users"),
    short_id: v.optional(v.string()), // "sd-N" from counters.nextShortId
    question: v.string(),
    // Markdown: the reasoning, the tradeoff, what happens under each choice.
    context_md: v.optional(v.string()),
    kind: v.optional(
      v.union(
        v.literal("single"),
        v.literal("multi"),
        v.literal("rank"),
        v.literal("form"),
      ),
    ),
    // Server assigned from lib/decisionCategory; the asker's proposal is kept.
    category: v.optional(v.string()),
    category_proposed: v.optional(v.string()),
    // Rich body: a docs row (doc_type "decision"); report_slug stays for a
    // published page.
    doc_id: v.optional(v.id("docs")),
    options: v.array(
      v.object({
        label: v.string(),
        description: v.optional(v.string()),
        body_md: v.optional(v.string()),
        evidence: v.optional(
          v.array(v.object({ label: v.string(), url: v.string() })),
        ),
        cost: v.optional(v.string()),
        risk: v.optional(v.string()),
        // A published page of its own (the-line.md L6): a mockup or a report
        // the option is judged by; rendered as a comparison row.
        page_slug: v.optional(v.string()),
      }),
    ),
    // A gate on the line (the-line.md L4): the run this decision pauses and
    // the node that asked. finalizeAnswer resumes the run.
    workflow_run_id: v.optional(v.id("workflow_runs")),
    gate_node_id: v.optional(v.string()),
    form: v.optional(
      v.object({
        fields: v.array(
          v.object({
            key: v.string(),
            label: v.string(),
            type: v.union(
              v.literal("text"),
              v.literal("number"),
              v.literal("select"),
              v.literal("bool"),
            ),
            options: v.optional(v.array(v.string())),
          }),
        ),
      }),
    ),
    // Published artifact slug (cast publish) carrying a full HTML report.
    report_slug: v.optional(v.string()),
    // A change card (the-line-end-to-end.md LE10, packages/line/src/changeCard.ts):
    // the web renders it natively in place of a report. Validated on ask.
    card: v.optional(v.any()),
    // A command the asker wants a person to run (`cast decide --run`,
    // decisions/src/commandRun.ts): the card shows it, a person's Run
    // executes it on the session's machine (daemon run_cast) and the result
    // comes back as the answer.
    run: v.optional(
      v.object({
        argv: v.array(v.string()),
        state: v.union(
          v.literal("waiting"),
          v.literal("queued"),
          v.literal("running"),
          v.literal("done"),
          v.literal("failed"),
          v.literal("skipped"),
        ),
        device_id: v.optional(v.string()),
        cwd: v.optional(v.string()),
        exit_code: v.optional(v.number()),
        output: v.optional(v.string()),
        at: v.optional(v.number()),
        // Written only by the removed workspace trust card; kept so rows that
        // carry it still validate. Nothing reads it.
        approves: v.optional(
          v.object({
            title: v.string(),
            folder: v.string(),
            items: v.array(
              v.object({
                label: v.string(),
                lines: v.array(v.string()),
                note: v.optional(v.string()),
              }),
            ),
          }),
        ),
      }),
    ),
    // true = the agent ended its turn and is parked on this answer.
    // false = advisory: the agent proceeded with default_option and the
    // human's answer can override it later.
    blocking: v.boolean(),
    // true = a pointer card: answering resolves it and delivers no
    // "Decision: …" message into the asking session (a staffing proposal's
    // queue card, org-staffing.md S4).
    silent: v.optional(v.boolean()),
    // A trial project's question (convex lineTrial.ts): asked by a station of
    // a trial run, it sits in the trial's own stack and reaches nobody's
    // queue, inbox, ladder or digest; its answer only records what the person
    // would have done.
    trial: v.optional(v.boolean()),
    default_option: v.optional(v.number()),
    // How much getting it answered matters, 1-5, as the asker judged it, and
    // its one-line why (packages/decisions/src/decisionImpact.ts). Orders the lists
    // inside the blocking tiers; unset counts as the middle.
    impact: v.optional(v.number()),
    impact_reason: v.optional(v.string()),
    // answered / dismissed are the human's verdicts; withdrawn is the agent
    // taking its own question back (`cast decide cancel`) — the facts changed
    // and there is nothing left to decide.
    status: v.union(
      v.literal("pending"),
      v.literal("answered"),
      v.literal("dismissed"),
      v.literal("withdrawn"),
    ),
    // Why it was withdrawn, when the withdrawing path knows (a problem closing takes its open questions with it).
    withdrawn_reason: v.optional(v.string()),
    answer_index: v.optional(v.number()),
    answer_text: v.optional(v.string()),
    // multi: number[] (indexes); rank: number[] (ordered); form: Record<key, value>.
    answer_json: v.optional(v.any()),
    // The task this decision blocks or informs, and the station (task status
    // category or team status id) the task is held at.
    task_id: v.optional(v.id("tasks")),
    station: v.optional(v.string()),
    // Tasks with a wait on this decision (task-graph.md TG2), so answering,
    // dismissing or reopening it finds them. Added by taskWaits.writeWaits,
    // never pruned (a reopen must find its met waits again):
    // each task is re-read and only its waits on this decision move.
    waiting_task_ids: v.optional(v.array(v.id("tasks"))),
    stack_id: v.optional(v.id("decision_stacks")),
    // When it joined its stack; the auto default deadline counts from here.
    stack_joined_at: v.optional(v.number()),
    // Who may answer: the people, or a role holding a grant for this category
    // and scope. holder_key is the flattened "user:<id>" / "role:<id>" for the
    // index (a user holder with several people uses the primary owner).
    holder: v.optional(
      v.object({
        kind: v.union(v.literal("user"), v.literal("role")),
        id: v.string(),
      }),
    ),
    holder_key: v.optional(v.string()),
    // A person handed the question to someone else (passCore): a teammate or a
    // role. It then holds the decision whatever routing or grants say, and a
    // role it was passed to may answer it without a grant.
    // `from`: the people it was asked of before the first pass, whom taking the pass back (unassignCore) restores.
    // `note`: what the passer wrote for the new owner (decisionHandoff.ts).
    passed_to: v.optional(
      v.object({
        kind: v.union(v.literal("user"), v.literal("role")),
        id: v.string(),
        by: v.id("users"),
        at: v.number(),
        from: v.optional(v.array(v.id("users"))),
        note: v.optional(v.string()),
      }),
    ),
    // Sent up to the owner's manager, else the workspace admins (escalateCore):
    // who sent it, why, when, and whom it went to. It sorts first for them; a later pass or unassign clears it.
    escalated: v.optional(
      v.object({
        by: v.id("users"),
        at: v.number(),
        note: v.string(),
        to: v.array(v.id("users")),
      }),
    ),
    // Asked of named people (`cast decide --to`): Share out leaves it with them (decisionRouting.ts).
    addressed: v.optional(v.boolean()),
    // The people it is visible to; materialized one row each in decision_inbox.
    asked_user_ids: v.optional(v.array(v.id("users"))),
    // The ladder: roles from the asker up to the first person, in order. A
    // recommendation or a skip note lands on the role's hop.
    hops: v.optional(
      v.array(
        v.object({
          role_id: v.id("org_roles"),
          recommendation: v.optional(v.number()),
          note: v.optional(v.string()),
          at: v.number(),
          passed_at: v.optional(v.number()),
        }),
      ),
    ),
    answered_by: v.optional(
      v.object({
        kind: v.union(
          v.literal("user"),
          v.literal("role"),
          v.literal("policy"),
        ),
        id: v.string(),
        // A person's answer given by their agent at their word (`cast decide
        // answer --for-human`): the session that carried it.
        via: v.optional(v.id("conversations")),
      }),
    ),
    // Set when a role answered under a grant.
    grant_id: v.optional(v.id("decision_grants")),
    // The scope keys a grant may match for this row (the asker's role, its
    // projects and plans, the task's project and plan, the stack). Stored so
    // agreement history and grant matching read one field.
    scope_keys: v.optional(v.array(v.string())),
    // A person reopened a granted answer: the grant and the answer it gave, so
    // the person's own answer can be scored as an agreement or an override.
    // Set by `cast org apply` (orgInit.performApplyDecision) once an org
    // proposal's answer was acted on, so a second run skips the row.
    applied_at: v.optional(v.number()),
    applied_note: v.optional(v.string()),
    reopened_from: v.optional(
      v.object({
        grant_id: v.id("decision_grants"),
        answer_index: v.optional(v.number()),
        at: v.number(),
      }),
    ),
    created_at: v.number(),
    // conversation.message_count when the ask landed. The live count minus this
    // is "messages since the ask" — how far the session has run past the
    // question — correct even when the client hasn't loaded that far back.
    asked_message_count: v.optional(v.number()),
    // Who asked, as a snapshot: the queue and the phone render the card from
    // this row alone, and the sessions collection on that device may not hold
    // the asking conversation (pruned, or a teammate's). Derived at render
    // from the live session row when present (lib/liveEntities rule).
    // ROUTING, never access (lib/decisionTeam.ts): the team whose Decisions
    // page lists it, its problem's team, else the asking conversation's.
    // Unset for a personal decision. Reads still answer to userMayRead.
    team_id: v.optional(v.id("teams")),
    session_title: v.optional(v.string()),
    project_path: v.optional(v.string()),
    // Last `cast decide edit`. created_at stays the ask time because the queue
    // ranks by age; this is what wakes a card whose text changed underneath it.
    updated_at: v.optional(v.number()),
    resolved_at: v.optional(v.number()),
    resolved_by: v.optional(v.id("users")),
    // Public sharing: "anyone with the link" (publicShare.ts).
    share_token: v.optional(v.string()),
    // What people said to the session that owns the decision, from the
    // decision's own surface (decisionDiscussion.ts): each ask and the session
    // it went to. The owner's replies are read from that session's transcript.
    discussion: v.optional(
      v.array(
        v.object({
          conversation_id: v.id("conversations"),
          user_id: v.id("users"),
          text: v.string(),
          client_id: v.string(),
          at: v.number(),
        }),
      ),
    ),
  })
    .index("by_share_token", ["share_token"])
    .index("by_user_status", ["user_id", "status"])
    .index("by_conversation_status", ["conversation_id", "status"])
    // Global recency scan for the email digest sweep: recent pending decisions.
    .index("by_status_created", ["status", "created_at"])
    .index("by_task", ["task_id", "status"])
    .index("by_holder_status", ["holder_key", "status"])
    .index("by_short_id", ["short_id"])
    // Agreement history and grant scope moves: one range read per category.
    .index("by_category_status_created", ["category", "status", "created_at"])
    // org.health and the analyzer inputs: one workspace's week, member by
    // member, never the deployment's newest rows.
    .index("by_user_status_created", ["user_id", "status", "created_at"])
    .index("by_user_status_resolved", ["user_id", "status", "resolved_at"])
    // A team's Decisions page and its Flows' decisions: one team's rows, never the deployment's.
    .index("by_team_status_created", ["team_id", "status", "created_at"]),

  // One row per person a decision is visible to (D2): the queue reads
  // (user, pending) here and joins the decision. `done` once the decision is
  // resolved, so "Handled without you" can list what a role answered.
  decision_inbox: defineTable({
    decision_id: v.id("session_decisions"),
    user_id: v.id("users"),
    status: v.union(v.literal("pending"), v.literal("done")),
    created_at: v.number(),
    // When status last changed: the recently handled reads take a window of
    // done rows by index instead of every row a person was ever asked.
    status_at: v.optional(v.number()),
  })
    .index("by_user_status", ["user_id", "status"])
    .index("by_user_status_at", ["user_id", "status", "status_at"])
    .index("by_decision", ["decision_id"]),

  // An ordered set of decisions one person clears in one sitting (D5).
  // Access is the anchor rule (lib/orgAccess): team_id / scope_user_id carry
  // the boundary; owner_user_id is the host.
  // A session's goal (messages/src/sessionGoal.ts, task ct-87437): the
  // objective a person gave the session, and the loop's own state. Each turn
  // end the judge reads it (managedSessions applyAgentStatus → sessionGoals
  // scheduleGoalJudge); continue delivers the next round, done and blocked
  // stop it. One row per goal; setting a new goal clears the session's
  // previous one, so the newest row is the session's goal. Access follows the
  // conversation (no workspace key: a goal is part of its session).
  session_goals: defineTable({
    conversation_id: v.id("conversations"),
    // Who set it: the loop's messages are sent in their name.
    set_by: v.id("users"),
    objective: v.string(),
    status: v.union(
      v.literal("active"),
      v.literal("paused"),
      v.literal("done"),
      v.literal("blocked"),
      v.literal("cleared"),
    ),
    rounds: v.number(),
    max_rounds: v.number(),
    stalls: v.number(),
    max_stalls: v.number(),
    idle_limit_ms: v.number(),
    reason: v.optional(v.string()),
    next_step: v.optional(v.string()),
    verdict: v.optional(
      v.union(
        v.literal("done"),
        v.literal("continue"),
        v.literal("blocked"),
        v.literal("paused"),
      ),
    ),
    // The newest agent_status_updated_at a judge was scheduled for, so two
    // reports of one turn end judge it once.
    judged_status_ts: v.optional(v.number()),
    last_activity_at: v.number(),
    // The idle check chain that is current: a set or resume arms a new one.
    idle_armed_at: v.optional(v.number()),
    // The web's optimistic stub key: /goal paints the pill under this before
    // the server answers, and the feed's altKey supersedes it.
    client_key: v.string(),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_conversation", ["conversation_id", "created_at"])
    .index("by_client_key", ["client_key"]),
  decision_stacks: defineTable({
    short_id: v.string(), // "ds-N"
    title: v.string(),
    team_id: v.optional(v.id("teams")),
    scope_user_id: v.optional(v.id("users")),
    owner_user_id: v.id("users"),
    role_id: v.optional(v.id("org_roles")),
    decision_ids: v.array(v.id("session_decisions")),
    policy: v.object({
      // Advisory members answer with their default when this passes.
      auto_default_after_ms: v.optional(v.number()),
      // This role holds every non protected category for the stack's members.
      delegate_role_id: v.optional(v.id("org_roles")),
      // When the person means to have cleared it; the queue sorts overdue
      // stacks first (the-line.md L10).
      due_at: v.optional(v.number()),
    }),
    status: v.union(v.literal("open"), v.literal("done")),
    // The web's optimistic stub key: "group into a stack" paints a row under
    // this before the server answers, and the list feed's altKey supersedes it.
    client_key: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
    // Public sharing: "anyone with the link" (publicShare.ts).
    share_token: v.optional(v.string()),
  })
    .index("by_share_token", ["share_token"])
    .index("by_team", ["team_id"])
    .index("by_scope_user", ["scope_user_id"])
    .index("by_short_id", ["short_id"])
    .index("by_status", ["status"]),

  // A saved approval or a configured deny (lib/permissionRules.ts): settles a
  // tool call from any harness before a card exists. Owned and read by
  // `user_id` alone; `project` and `scope` say where it applies (the
  // repository, and the workspace key of the sessions it settles). `scope` is
  // not access: a team-scoped rule still governs only its owner's sessions.
  permission_rules: defineTable({
    user_id: v.id("users"),
    project: v.string(),
    scope: v.string(),
    permission: v.string(),
    pattern: v.string(),
    action: v.union(v.literal("allow"), v.literal("deny")),
    created_at: v.number(),
    source_conversation_id: v.optional(v.id("conversations")),
  })
    .index("by_user_project", ["user_id", "project"])
    .index("by_user", ["user_id", "created_at"]),

  // A role may answer decisions of one category in one scope without a person
  // (D2). Earned from agreement history or delegated by a stack policy; expires
  // after 30 days; revoked after two consecutive overrides.
  decision_grants: defineTable({
    role_id: v.id("org_roles"),
    category: v.string(),
    scope_key: v.string(), // "role:<id>" | "project:<id>" | "plan:<id>" | "stack:<id>"
    granted_by: v.id("users"),
    granted_from_decision_id: v.optional(v.id("session_decisions")),
    granted_at: v.number(),
    expires_at: v.number(),
    revoked_at: v.optional(v.number()),
    revoked_reason: v.optional(v.string()),
    // Consecutive person overrides of this grant's answers; 2 revokes it.
    override_streak: v.optional(v.number()),
  }).index("by_role", ["role_id", "category"]),

  // A signed-in link recipient (someone who opened a shared conversation but is
  // neither its owner nor a team member) asking to do more than read: to send
  // messages into the live session — which, since the agent runs whatever it's
  // told, means running commands on the owner's machine. The owner approves once
  // per session; the grant then lets performSessionSend accept that user's sends.
  // Co-writing the draft needs no grant — only firing it into the session does.
  // A signed-in viewer who presented a conversation's share link. Access via a
  // share link requires PRESENTING the token — id knowledge is not a grant
  // (issue #27). Anonymous guests carry the token on every query; signed-in
  // viewers redeem it once here and checkConversationAccess honors the row
  // only while its stored token still matches the conversation's current one,
  // so rotating or revoking the token cuts every past redeemer off.
  // Append only record of every act that creates or changes authority: a
  // permission answered, a share link minted/revoked/redeemed, a conversation's
  // visibility moved, an org role's trust/caps/authority set, a proposal
  // accepted, a team membership added/removed/re-roled. The row is written
  // inside the same mutation as the change (lib/authorityEvents.ts is the one
  // writer; authorityEvents.guard.test.ts keeps it so), so the change cannot
  // commit without its audit row. `workspace` is ACCESS (computeWorkspaceKey),
  // `team_id` is ROUTING only. Never a raw token: share links are stored as a
  // sha256 hash.
  authority_events: defineTable({
    kind: v.union(
      v.literal("permission_answered"),
      v.literal("permission_rule_saved"),
      v.literal("permission_rule_removed"),
      v.literal("share_link_minted"),
      v.literal("share_link_revoked"),
      v.literal("share_link_redeemed"),
      v.literal("conversation_visibility_changed"),
      v.literal("org_role_trust_changed"),
      v.literal("org_role_caps_changed"),
      v.literal("org_role_authority_changed"),
      v.literal("org_proposal_accepted"),
      v.literal("team_member_added"),
      v.literal("team_member_removed"),
      v.literal("team_member_role_changed"),
      v.literal("team_member_visibility_changed"),
      v.literal("staff_daemon_command"),
      v.literal("team_read_key_minted"),
      v.literal("team_read_key_revoked"),
      v.literal("team_read_key_used"),
    ),
    actor_user_id: v.id("users"),
    actor_conversation_id: v.optional(v.id("conversations")),
    conversation_id: v.optional(v.id("conversations")),
    team_id: v.optional(v.id("teams")),
    target_user_id: v.optional(v.id("users")),
    role_id: v.optional(v.string()),
    share_table: v.optional(v.string()),
    share_token_hash: v.optional(v.string()),
    detail: v.object({
      before: v.optional(v.any()),
      after: v.optional(v.any()),
    }),
    workspace: v.string(),
    created_at: v.number(),
  })
    .index("by_workspace_created", ["workspace", "created_at"])
    .index("by_actor_created", ["actor_user_id", "created_at"])
    .index("by_conversation_created", ["conversation_id", "created_at"]),
};
