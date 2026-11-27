import { defineTable } from "convex/server";
import { v } from "convex/values";

export const sessionDeliveryTables = {
  pending_messages: defineTable({
    conversation_id: v.id("conversations"),
    kill_generation: v.optional(v.number()),
    from_user_id: v.id("users"),
    // The user who OWNS the target conversation — i.e. whose daemon delivers this message.
    // For a self-send (the common case) this equals from_user_id; for a team send (one user
    // messaging a teammate's session) it's the teammate. Delivery, claiming, and status writes
    // route on owner; cancel/retry/status-read and failure notifications route on the sender.
    // Optional only for backward compat with rows created before this field existed (backfilled
    // to from_user_id, which they're equal to); enqueuePendingMessage always sets it on new rows.
    owner_user_id: v.optional(v.id("users")),
    // The sender's own conversation, captured so the cron can tell the sending session when a
    // cross-user message can't be delivered (the "remote not responding" feedback path).
    from_conversation_id: v.optional(v.id("conversations")),
    // Set once when the sender has been told this cross-user message is stuck — keeps the cron
    // from notifying repeatedly.
    sender_notified_at: v.optional(v.number()),
    // The receipt that told the sender, so a later state (stuck, then unconfirmed) rewrites it
    // while it is still queued instead of stacking a second receipt.
    sender_notice_id: v.optional(v.id("pending_messages")),
    content: v.string(),
    image_storage_id: v.optional(v.id("_storage")),
    image_storage_ids: v.optional(v.array(v.id("_storage"))),
    client_id: v.optional(v.string()),
    // Who initiated the send. Absent = a person (web composer, cast send, team
    // send) — those clear dismissed/stashed/killed so the session resurfaces.
    // "scheduler" = the daemon's task scheduler firing a `cast trigger`
    // injection: a machine wake must not override the user's stash (stash =
    // "keep working out of my sight"), so enqueue skips the stash-clear.
    origin: v.optional(v.literal("scheduler")),
    // A person wrote this (enqueuePendingMessage.human). Kept on the row so
    // the echo can tell a person's message from one a program queued in
    // their name (a spawn brief, an account-switch "continue").
    human: v.optional(v.boolean()),
    // "composer": a signed-in person sent this from the web or phone composer
    // (a session login, never an API token). Server-set at those sends only;
    // absent reads as a program (lib/messageProvenance.ts). Unlike `human`,
    // no caller can declare it.
    channel: v.optional(v.literal("composer")),
    // With channel "composer": the words the person typed in the box, before
    // the composer folded in quotes, mention context or attachments. The part
    // of the message that is theirs (lib/messageProvenance.typedPart).
    typed_text: v.optional(v.string()),
    status: v.union(
      v.literal("pending"),
      v.literal("injected"),
      v.literal("delivered"),
      v.literal("failed"),
      v.literal("undeliverable"),
      // User-initiated terminal state. The only way to stop the always-on retry loop short of
      // delivery — the daemon's getPendingMessages never returns it and the healer never revives it.
      v.literal("cancelled"),
      // A person's message into a role's standing session, parked until the
      // wake rail's flush folds it into one frame and releases it as
      // "pending" (org-roles-standing.md T3). The daemon polls and the retry
      // cron read "pending" only, so a held row waits for free; cancel and
      // kill still terminalize it.
      v.literal("held"),
    ),
    created_at: v.number(),
    // Place in the conversation's queue when someone moved it (reorderQueued).
    // Absent = created_at. Every reader that takes "the oldest row" orders by
    // queueOrder(row), so a reorder changes what the session takes next.
    queue_at: v.optional(v.number()),
    // Set on a row folded into another by mergeQueued (status "cancelled"):
    // its words go out as a part of that row's joint turn.
    merged_into: v.optional(v.id("pending_messages")),
    // Queued for the end of the agent's turn (the composer's "Queue for
    // later"): parked as "held", shown to everyone in the session's shared
    // queue where it can be moved or merged, and released (releaseQueued)
    // when the turn ends. Ordinary sends never release these.
    queued: v.optional(v.boolean()),
    // Work a session handed another out of sight (enqueuePendingMessage.quiet): a hidden
    // stash survives it, and survives its risk resend too (executionBindings), which reads it here.
    quiet: v.optional(v.boolean()),
    delivered_at: v.optional(v.number()),
    // The transcript message this row's echo produced. Stamped when the echo
    // adopts the row (content rewrite, client_id, images, from_user_id). Lets a
    // row terminalized early by the status ack still be adopted by its late
    // echo, while guaranteeing each row is adopted at most once — an identical
    // later send can never re-match an already-echoed row.
    echo_message_id: v.optional(v.id("messages")),
    retry_count: v.number(),
    // Stamped by the daemon once it has SEEN its paste in the composer and the
    // Enter accepted. "injected" alone is the pre-paste mark; a status ack may
    // terminalize only a row that carries this stamp (a pre-paste mark acked by
    // an unrelated working report lost a cast send on 2026-09-08).
    paste_verified_at: v.optional(v.number()),
    // When the stuck-message healer re-pended this row for a session with no
    // live process, so the daemon would resume it. Set once: a row is revived
    // that way at most one time (see planDeadSessionRevive).
    dead_session_revived_at: v.optional(v.number()),
    // Present only after a conversation crosses the fenced-execution gate.
    // Legacy columns remain as a UI/backward-compatible projection, but legacy
    // daemon endpoints reject these rows. Convex assigns all four values in the
    // enqueue transaction; clients never mint ordering or delivery authority.
    delivery_protocol_version: v.optional(v.number()),
    delivery_id: v.optional(v.string()),
    delivery_intent: v.optional(
      v.union(v.literal("steer"), v.literal("queue")),
    ),
    delivery_observed_turn: v.optional(
      v.object({
        id: v.string(),
        run: v.number(),
        start_event_seq: v.number(),
      }),
    ),
    delivery_baton_token: v.optional(v.union(v.number(), v.null())),
    conversation_sequence: v.optional(v.number()),
    execution_epoch: v.optional(v.number()),
    delivery_status: v.optional(
      v.union(
        v.literal("pending"),
        v.literal("claimed"),
        v.literal("delivery-started"),
        v.literal("delivered"),
        v.literal("rejected"),
        v.literal("cancelled-by-supersession"),
        v.literal("correlated-delivered"),
        v.literal("ambiguous"),
        v.literal("abandoned-ambiguous"),
      ),
    ),
    active_delivery_attempt_id: v.optional(v.id("delivery_attempts")),
    delivery_disposition_reason: v.optional(v.string()),
    // The terminal rows the daemon read when it held this message for a
    // dialog, so the person deciding what to do sees what it saw. Set and
    // cleared together with delivery_disposition_reason.
    delivery_hold_screen: v.optional(v.string()),
    // The person chose "Send anyway" on a held message: the next delivery
    // types it past the dialog check, once.
    delivery_force: v.optional(v.boolean()),
    // Explicit risk-bearing resend provenance. The original delivery remains
    // terminal abandoned-ambiguous; content is copied into a new logical
    // delivery with a new client/delivery id and sequence.
    resend_of_delivery_id: v.optional(v.string()),
  })
    .index("by_conversation_id", ["conversation_id"])
    // The rows a session's queue held around a moment (originator.queuedNear): a terminal line's words checked
    // against what the queue sent then, without reading a long-lived session's whole queue.
    .index("by_conversation_created", ["conversation_id", "created_at"])
    .index("by_conversation_status", ["conversation_id", "status"])
    .index("by_conversation_status_kill_generation", [
      "conversation_id",
      "status",
      "kill_generation",
    ])
    .index("by_user_status", ["from_user_id", "status"])
    // The daemon polls by the TARGET owner (owner_user_id), not the sender, so a teammate's
    // message lands in the right daemon's queue. Replaces by_user_status for delivery routing.
    .index("by_owner_status", ["owner_user_id", "status"])
    .index("by_status", ["status"])
    .index("by_status_created", ["status", "created_at"])
    .index("by_conversation_sequence", [
      "conversation_id",
      "conversation_sequence",
    ])
    .index("by_conversation_epoch_delivery", [
      "conversation_id",
      "execution_epoch",
      "delivery_status",
    ])
    .index("by_conversation_epoch_delivery_status_intent_sequence", [
      "conversation_id",
      "execution_epoch",
      "delivery_status",
      "delivery_intent",
      "conversation_sequence",
    ])
    .index("by_conversation_delivery_status_sequence", [
      "conversation_id",
      "delivery_status",
      "conversation_sequence",
    ])
    .index("by_conversation_status_protocol_queued", [
      "conversation_id",
      "status",
      "delivery_protocol_version",
      "queued",
    ])
    .index("by_conversation_client_id", ["conversation_id", "client_id"])
    // `cast send --status`: one sender's sends into one target, newest first.
    .index("by_from_conversation", ["from_conversation_id", "conversation_id"]),

  // Singleton storage for the stuck-message cron's current sweep.
  pending_message_sweep_state: defineTable({
    run_token: v.optional(v.number()),
    dead_revived: v.optional(v.array(v.id("conversations"))),
    cursor: v.union(
      v.null(),
      v.object({
        through: v.number(),
        createdAt: v.number(),
        creationTime: v.number(),
      }),
    ),
  }),

  pending_message_sweep_retries: defineTable({
    conversation_id: v.id("conversations"),
    message_id: v.id("pending_messages"),
    attempted_at: v.number(),
    reason: v.union(
      v.literal("apply_failed"),
      v.literal("dead_revive_limit"),
      v.literal("scan_pending"),
    ),
  })
    .index("by_reason_attempted", ["reason", "attempted_at"])
    .index("by_message_id", ["message_id"]),

  // One authoritative ordering/fencing row per conversation. Convex OCC on
  // this row serializes enqueue, delivery-slot acquisition, terminal-prefix
  // advancement, and epoch activation. There is deliberately one slot for the
  // whole conversation rather than one slot per epoch.
  conversation_execution_heads: defineTable({
    conversation_id: v.id("conversations"),
    owner_user_id: v.id("users"),
    protocol_state: v.union(v.literal("legacy-quiescing"), v.literal("fenced")),
    protocol_version: v.number(),
    last_pane_instance: v.optional(v.number()),
    current_epoch: v.optional(v.number()),
    agent_steer_grant: v.optional(
      v.object({
        sender_id: v.union(v.id("conversations"), v.null()),
        by_user_id: v.id("users"),
        revision: v.number(),
      }),
    ),
    pending_epoch: v.optional(v.number()),
    device_move: v.optional(
      v.object({
        move_id: v.optional(v.string()),
        recorded_at: v.optional(v.number()),
        phase: v.optional(
          v.union(v.literal("preparing"), v.literal("aborting")),
        ),
        replacement: v.optional(
          v.object({
            abandoned_move_id: v.string(),
            destination_device_id: v.string(),
            destination_runner_id: v.id("users"),
          }),
        ),
        source_stopped_at: v.optional(v.number()),
        source_replacement_boot_id: v.optional(v.string()),
        forced: v.optional(
          v.object({ by_user_id: v.id("users"), at: v.number() }),
        ),
        source_epoch: v.number(),
        source_lease_id: v.optional(v.id("run_leases")),
        attempt_id: v.optional(v.id("delivery_attempts")),
        destination_device_id: v.string(),
        destination_runner_id: v.id("users"),
        next_epoch: v.number(),
        settlement_deadline: v.number(),
        driver: v.optional(
          v.object({
            revision: v.number(),
            step: v.union(
              v.literal("prepare"),
              v.literal("restore"),
              v.literal("retarget"),
              v.literal("activate"),
              v.literal("failed"),
            ),
            retries: v.number(),
            owner_retried: v.optional(v.boolean()),
            moved: v.number(),
            prepared_at: v.optional(v.number()),
            retargeted_at: v.optional(v.number()),
            last_error: v.optional(v.string()),
          }),
        ),
      }),
    ),
    last_device_move: v.optional(
      v.object({
        move_id: v.string(),
        source_runner_id: v.id("users"),
        forced: v.boolean(),
        destination_device_id: v.string(),
        destination_runner_id: v.id("users"),
        epoch: v.number(),
        prepared_at: v.optional(v.number()),
        retargeted_at: v.optional(v.number()),
        moved: v.number(),
        activated_at: v.number(),
      }),
    ),
    admission_epoch: v.optional(v.number()),
    next_conversation_sequence: v.number(),
    next_nonterminal_sequence: v.number(),
    pending_policy: v.optional(
      v.union(v.literal("drain-current"), v.literal("cancel-unstarted")),
    ),
    pending_requested_at_sequence: v.optional(v.number()),
    cancelled_through_sequence: v.optional(v.number()),
    // Browser/session-authenticated product intent. The browser can request a
    // restart or a model/effort reconfiguration, but it never names effect
    // authority (device/boot/runtime/operation/capabilities). Those fields are
    // derived here from the current binding and consumed by the daemon's
    // separate API-token-only successor proposal.
    successor_intent: v.optional(
      v.object({
        intent_id: v.string(),
        requested_by_user_id: v.id("users"),
        expected_current_epoch: v.number(),
        kind: v.union(v.literal("restart"), v.literal("reconfigure")),
        policy: v.union(
          v.literal("drain-current"),
          v.literal("cancel-unstarted"),
        ),
        requested_model_option: v.optional(v.string()),
        requested_effort_option: v.optional(v.string()),
        requested_agent: v.union(
          v.literal("claude"),
          v.literal("codex"),
          v.literal("cursor"),
          v.literal("gemini"),
          v.literal("opencode"),
          v.literal("pi"),
          v.literal("grok"),
          v.literal("muse"),
          v.literal("antigravity"),
        ),
        transport: v.union(
          v.literal("tmux"),
          v.literal("app-server"),
          v.literal("external"),
        ),
        project_path: v.string(),
        isolation: v.optional(
          v.object({
            sandbox: v.optional(
              v.union(
                v.literal("read-only"),
                v.literal("workspace-write"),
                v.literal("danger-full-access"),
              ),
            ),
            approval_policy: v.optional(
              v.union(
                v.literal("untrusted"),
                v.literal("on-failure"),
                v.literal("on-request"),
                v.literal("never"),
              ),
            ),
            isolated: v.optional(v.boolean()),
            worktree_name: v.optional(v.string()),
          }),
        ),
        configuration_revision: v.number(),
        model: v.optional(v.string()),
        effort: v.optional(v.string()),
        owner_device_id: v.string(),
        protocol_version: v.number(),
        required_capabilities: v.array(
          v.union(
            v.literal("single-flight-binding"),
            v.literal("delivery-permit-v1"),
            v.literal("strict-agent-routing"),
            v.literal("runtime-inspection-v1"),
            v.literal("steer-baton-v1"),
          ),
        ),
        status: v.union(
          v.literal("pending"),
          v.literal("consumed"),
          v.literal("activated"),
        ),
        successor_epoch: v.optional(v.number()),
        consumed_daemon_boot_id: v.optional(v.string()),
        created_at: v.number(),
        consumed_at: v.optional(v.number()),
        activated_at: v.optional(v.number()),
      }),
    ),
    active_delivery_attempt_id: v.optional(v.id("delivery_attempts")),
    active_delivery_state: v.optional(
      v.union(
        v.literal("claimed"),
        v.literal("delivery-started"),
        v.literal("ambiguous"),
      ),
    ),
    // The migration proof is exact to one device and one daemon incarnation;
    // device identity alone is not a worker fence.
    legacy_owner_device_id: v.optional(v.string()),
    legacy_daemon_boot_id: v.optional(v.string()),
    terminated_legacy_daemon_boot_id: v.optional(v.string()),
    replacement_daemon_boot_id: v.optional(v.string()),
    legacy_runtime_disposition: v.optional(
      v.union(
        v.literal("stopped"),
        v.literal("adopted"),
        v.literal("quarantined"),
      ),
    ),
    termination_evidence: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_conversation", ["conversation_id"])
    .index("by_owner_state", ["owner_user_id", "protocol_state"])
    .index("by_move_destination", [
      "device_move.destination_runner_id",
      "device_move.destination_device_id",
      "device_move.phase",
      "device_move.driver.step",
    ]),

  // Immutable target/configuration per epoch plus the durable startup CAS.
  // The device's CURRENT fenced-execution daemon boot, upserted at rail
  // startup. Cross-boot binding recovery is authorized only for this exact
  // boot: a claim from any other boot id (a dead boot's late-arriving request,
  // or a boot that never registered) stays rejected, so a restart can adopt
  // stranded bindings without a stale claimant ever stealing one back.
  execution_daemon_boots: defineTable({
    user_id: v.id("users"),
    owner_device_id: v.string(),
    daemon_boot_id: v.string(),
    edge_baton_hello: v.optional(
      v.object({
        boot: v.string(),
        capabilities: v.array(
          v.union(v.literal("steer-baton-v1"), v.literal("takeover-fence-v1")),
        ),
      }),
    ),
    registered_at: v.number(),
    owned_codex_new_sessions: v.optional(v.boolean()),
  }).index("by_user_device", ["user_id", "owner_device_id"]),

  // Ready-only fields are optional in storage and validated as a complete set
  // by executionBindings.publishReadyBinding before state becomes `ready`.
  execution_bindings: defineTable({
    conversation_id: v.id("conversations"),
    epoch: v.number(),
    owner_user_id: v.id("users"),
    owner_device_id: v.string(),
    daemon_boot_id: v.string(),
    move_id: v.optional(v.string()),
    requires_run_lease: v.optional(v.boolean()),
    claim_id: v.optional(v.string()),
    requested_agent: v.union(
      v.literal("claude"),
      v.literal("codex"),
      v.literal("cursor"),
      v.literal("gemini"),
      v.literal("opencode"),
      v.literal("pi"),
      v.literal("grok"),
      v.literal("muse"),
      v.literal("antigravity"),
    ),
    transport: v.union(
      v.literal("tmux"),
      v.literal("app-server"),
      v.literal("external"),
    ),
    project_path: v.string(),
    isolation: v.optional(
      v.object({
        sandbox: v.optional(
          v.union(
            v.literal("read-only"),
            v.literal("workspace-write"),
            v.literal("danger-full-access"),
          ),
        ),
        approval_policy: v.optional(
          v.union(
            v.literal("untrusted"),
            v.literal("on-failure"),
            v.literal("on-request"),
            v.literal("never"),
          ),
        ),
        isolated: v.optional(v.boolean()),
        worktree_name: v.optional(v.string()),
      }),
    ),
    configuration_revision: v.number(),
    model: v.optional(v.string()),
    effort: v.optional(v.string()),
    protocol_version: v.number(),
    required_capabilities: v.array(
      v.union(
        v.literal("single-flight-binding"),
        v.literal("delivery-permit-v1"),
        v.literal("strict-agent-routing"),
        v.literal("runtime-inspection-v1"),
        v.literal("steer-baton-v1"),
      ),
    ),
    state: v.union(
      v.literal("requested"),
      v.literal("starting"),
      v.literal("ready"),
      v.literal("start-failed-before-effect"),
      v.literal("start-ambiguous"),
      v.literal("stopped"),
      v.literal("quarantined"),
    ),
    operation_id: v.optional(v.string()),
    actual_agent: v.optional(
      v.union(
        v.literal("claude"),
        v.literal("codex"),
        v.literal("cursor"),
        v.literal("gemini"),
        v.literal("opencode"),
        v.literal("pi"),
        v.literal("grok"),
        v.literal("muse"),
        v.literal("antigravity"),
      ),
    ),
    runtime_id: v.optional(v.string()),
    handle: v.optional(v.string()),
    applied_configuration_revision: v.optional(v.number()),
    capabilities: v.optional(
      v.array(
        v.union(
          v.literal("steer-baton-v1"),
          v.literal("takeover-fence-v1"),
          v.literal("single-flight-binding"),
          v.literal("delivery-permit-v1"),
          v.literal("strict-agent-routing"),
          v.literal("runtime-inspection-v1"),
        ),
      ),
    ),
    edge_capabilities: v.optional(
      v.array(
        v.union(v.literal("steer-baton-v1"), v.literal("takeover-fence-v1")),
      ),
    ),
    failure_code: v.optional(v.string()),
    failure_message: v.optional(v.string()),
    failure_retryable: v.optional(v.boolean()),
    suspected_runtime_id: v.optional(v.string()),
    stopped_reason: v.optional(v.string()),
    abandoned_move: v.optional(v.boolean()),
    forced_device_move: v.optional(
      v.object({
        move_id: v.string(),
        by_user_id: v.id("users"),
        at: v.number(),
        destination_epoch: v.number(),
      }),
    ),
    // Evidence-bearing retirement of an epoch that never reached `ready`.
    // `no-runtime-proven` is safe only after inspection proves no external
    // runtime exists; `runtime-quarantined` retains the suspected runtime id.
    pre_ready_disposition: v.optional(
      v.union(v.literal("no-runtime-proven"), v.literal("runtime-quarantined")),
    ),
    disposition_evidence: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_conversation_epoch", ["conversation_id", "epoch"])
    .index("by_conversation_device_forced_at", [
      "conversation_id",
      "owner_device_id",
      "forced_device_move.at",
    ]),

  run_event_cursors: defineTable({
    conversation_id: v.id("conversations"),
    owner_user_id: v.id("users"),
    binding_id: v.id("execution_bindings"),
    run: v.number(),
    last_event_seq: v.number(),
  })
    .index("by_conversation_run", ["conversation_id", "run"])
    .index("by_owner", ["owner_user_id"]),

  run_terminal_panes: defineTable({
    conversation_id: v.id("conversations"),
    owner_user_id: v.id("users"),
    run: v.number(),
    pane_instance: v.number(),
    retain_until: v.number(),
    started: v.optional(
      v.object({
        at: v.number(),
        seq: v.number(),
        source: v.union(v.literal("observed"), v.literal("provider")),
        turn: v.union(v.string(), v.null()),
        actor: v.object({
          id: v.string(),
          kind: v.union(v.literal("person"), v.literal("agent")),
        }),
        tool_call_id: v.optional(v.string()),
      }),
    ),
    ended: v.optional(
      v.object({
        at: v.number(),
        seq: v.number(),
        source: v.union(v.literal("observed"), v.literal("provider")),
        turn: v.union(v.string(), v.null()),
        run: v.number(),
        outcome: v.union(
          v.object({ kind: v.literal("exit"), code: v.number() }),
          v.object({ kind: v.literal("signal"), signal: v.string() }),
          v.object({ kind: v.literal("replaced") }),
          v.object({ kind: v.literal("lost") }),
        ),
      }),
    ),
  })
    .index("by_conversation_run_pane", [
      "conversation_id",
      "run",
      "pane_instance",
    ])
    .index("by_owner", ["owner_user_id"])
    .index("by_retention", ["retain_until"]),

  run_turn_projections: defineTable({
    conversation_id: v.id("conversations"),
    owner_user_id: v.id("users"),
    binding_id: v.id("execution_bindings"),
    run: v.number(),
    status: v.union(v.literal("active"), v.literal("completed")),
    projection_version: v.optional(v.number()),
    turn_ids: v.array(v.string()),
    open_turn: v.union(
      v.null(),
      v.object({
        id: v.string(),
        prompt_ids: v.array(v.string()),
        starter: v.optional(
          v.object({
            id: v.string(),
            kind: v.union(v.literal("person"), v.literal("agent")),
          }),
        ),
        start_event_seq: v.optional(v.number()),
        baton_converted: v.optional(v.boolean()),
        prompt_details: v.optional(
          v.array(
            v.object({
              prompt_id: v.string(),
              kind: v.union(v.literal("question"), v.literal("permission")),
              tool_call_id: v.optional(v.string()),
              routine_question: v.optional(v.literal(true)),
              questions: v.optional(
                v.array(v.object({ id: v.string(), is_secret: v.boolean() })),
              ),
            }),
          ),
        ),
      }),
    ),
    received_at: v.number(),
  })
    .index("by_conversation_run", ["conversation_id", "run"])
    .index("by_owner", ["owner_user_id"]),

  run_leases: defineTable({
    conversation_id: v.id("conversations"),
    owner_user_id: v.id("users"),
    binding_id: v.id("execution_bindings"),
    claim_id: v.string(),
    boot: v.string(),
    fencing_token: v.string(),
    expires_at: v.number(),
    released_at: v.optional(v.number()),
    retain_until: v.number(),
  })
    .index("by_conversation_claim", ["conversation_id", "claim_id"])
    .index("by_owner", ["owner_user_id"])
    .index("by_retention", ["retain_until"]),

  // Every retry gets a fresh attempt row; delivery_id and sequence stay stable.
  // An ambiguous attempt remains the conversation-global slot owner until an
  // explicit proof/recovery decision resolves it.
  delivery_attempts: defineTable({
    conversation_id: v.id("conversations"),
    message_id: v.id("pending_messages"),
    delivery_id: v.string(),
    conversation_sequence: v.number(),
    execution_epoch: v.number(),
    configuration_revision: v.number(),
    owner_user_id: v.id("users"),
    owner_device_id: v.string(),
    daemon_boot_id: v.string(),
    runtime_id: v.string(),
    state: v.union(
      v.literal("claimed"),
      v.literal("delivery-started"),
      v.literal("delivered"),
      v.literal("failed-before-effect"),
      v.literal("ambiguous"),
      v.literal("correlated-delivered"),
      v.literal("cancelled-by-supersession"),
      v.literal("abandoned-ambiguous"),
    ),
    failure_code: v.optional(v.string()),
    failure_message: v.optional(v.string()),
    external_delivery_id: v.optional(v.string()),
    resolution_evidence: v.optional(v.string()),
    forced_move_source_epoch: v.optional(v.number()),
    claimed_at: v.number(),
    delivery_started_at: v.optional(v.number()),
    completed_at: v.optional(v.number()),
  }).index("by_conversation_sequence", [
    "conversation_id",
    "conversation_sequence",
  ]),
};

export const conversationEventTables = {
  // What happened to a session and who did it (lifecycleEvents.ts): one row
  // per CHANGE of a lifecycle fact, written by the mutation wrapper. `cause`
  // is the surface a mutation named (web:<action>, cli:<verb>, cron:<name>);
  // without one, `stack` keeps the top frames of the writer. Pruned after 60
  // days (lifecycleEvents.prune).
  conversation_events: defineTable({
    conversation_id: v.string(),
    ts: v.number(),
    kind: v.string(),
    changes: v.record(v.string(), v.array(v.union(v.string(), v.null()))),
    cause: v.optional(v.string()),
    stack: v.optional(v.string()),
  })
    .index("by_conversation_ts", ["conversation_id", "ts"])
    .index("by_ts", ["ts"]),
};
