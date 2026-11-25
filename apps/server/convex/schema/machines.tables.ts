import {
  distributionValidator,
  updateStateValidator,
} from "../lib/deviceUpdate";
import { defineTable } from "convex/server";
import { v } from "convex/values";
import { DAEMON_COMMANDS } from "@codecast/daemon/daemonCommands";
import {
  cloudAutoscaleValidator,
  cloudHostReportValidator,
  hostReadinessValidator,
} from "../lib/cloudHostValidators";
import { lineSlotsValidator } from "../lib/lineSlotsValidator";
import {
  ccAccountsValidator,
  ccAutoSwitchStateValidator,
  ccLoginFlowValidator,
  ccMintFlowValidator,
} from "../ccAccountsShared";
import {
  cloudAgentBlocksValidator,
  deviceSettingsValidator,
  modelInventoryValidator,
} from "../deviceSettingsShared";

const daemonCommandValidator = v.union(
  ...DAEMON_COMMANDS.map((c) => v.literal(c)),
);

export const daemonCommandTables = {
  daemon_commands: defineTable({
    user_id: v.id("users"),
    request_id: v.optional(v.string()),
    command: daemonCommandValidator,
    args: v.optional(v.string()),
    created_at: v.number(),
    executed_at: v.optional(v.number()),
    result: v.optional(v.string()),
    error: v.optional(v.string()),
    // Device this command is routed to. When set, only the daemon whose
    // deviceId() matches executes it — the poll filters the rest out, so
    // session commands (start/resume) go to the one machine that owns the
    // checkout instead of being raced by every daemon. Undefined = broadcast
    // (device-agnostic commands like status/restart, or sessions whose owner
    // can't be resolved yet).
    target_device_id: v.optional(v.string()),
    // Exclusive lease, held by one daemon PROCESS on one DEVICE. Two daemons
    // can share a device (a launchd instance and a self spawned one, or both
    // sides of an upgrade) and both poll this queue, so without a claim both
    // execute every command. The first writer wins and holds for CLAIM_GRACE_MS
    // (lib/daemonCommandClaim.ts); a claimer that died holding one releases it
    // when the lease lapses.
    //
    // claimed_device is what keeps a broadcast a broadcast: an untargeted row
    // (kill_session, an admin restart) is meant for every machine, so a hold
    // from another device is not a hold at all.
    claimed_by: v.optional(v.string()),
    claimed_at: v.optional(v.number()),
    claimed_device: v.optional(v.string()),
  })
    .index("by_user_pending", ["user_id", "executed_at"])
    .index("by_user_request", ["user_id", "request_id"]),
};

export const deviceTables = {
  // One row per machine the user runs a codecast daemon on. The remote Mac is
  // just another device. device_id is a stable hash of ~/.codecast/.machine_key,
  // bound to the machine's hardware UUID so a disk-copied ~/.codecast (Migration
  // Assistant) mints a fresh id instead of impersonating the source machine
  // (see remote/device.ts). Per-device fields (local_project_roots) live here
  // rather than on the user doc, so multiple machines don't clobber each other.
  devices: defineTable({
    user_id: v.id("users"),
    device_id: v.string(),
    label: v.string(),
    platform: v.string(),
    // The machine's own hostname, heartbeat-reported. Distinct from `label`,
    // which is the daemon's own string (config device_label, else
    // "macOS - hostname") and is rewritten on every beat. A name a person
    // typed lives in display_name. The hostname is only ever a SUGGESTION
    // for ssh_host — never interpolated into a command on its own, because
    // a hostname is not necessarily a reachable ssh target.
    hostname: v.optional(v.string()),
    // The WSL distro the daemon runs in, heartbeat-reported; absent off WSL.
    wsl_distro: v.optional(v.string()),
    // How to reach this machine over SSH from elsewhere, e.g. "nose" or
    // "m1@1.2.3.4". User-set in Settings → Devices (never heartbeat-written):
    // an ssh alias resolves against the VIEWER's ~/.ssh/config, which no daemon
    // can know. Absent = no target, and the UI then refuses to hand out an
    // attach command it can't stand behind. Shell-safe by construction — see
    // sanitizeSshHost in devices.ts, which is what makes it safe to paste.
    ssh_host: v.optional(v.string()),
    // A name and icon a person set in Settings → Devices. Heartbeats never
    // write these: `label` is the daemon's string and the next beat would
    // clobber a rename stored there. Absent means the automatic name
    // (deviceDisplayName) and the platform glyph. `icon` is a team-icon
    // token; `icon_color` is a team-color token. Both are display only.
    display_name: v.optional(v.string()),
    icon: v.optional(v.string()),
    icon_color: v.optional(v.string()),
    last_seen: v.number(),
    // When a human last touched THIS machine's keyboard/mouse — computed
    // server-side as (heartbeat arrival − the daemon's reported input idle), so
    // daemon clock skew can't fake it. macOS-only (cli/inputIdle.ts); absent on
    // Linux/headless boxes, which therefore never read as "the user is here".
    // Consumed by pushRouter unless the user opted out of machine_wide_presence.
    last_input_at: v.optional(v.number()),
    status: v.optional(v.union(v.literal("online"), v.literal("offline"))),
    // Per-device daemon health, written on every beat: boot time, ms the event
    // loop was blocked in the last minute, and the sync backlog. The web derives
    // "restarted, catching up" / "under load" / "syncing N" PER MACHINE from
    // these — the user-doc twins are last-writer across machines, so with two
    // daemons alive one machine's trouble is masked by the other's beats.
    daemon_started_at: v.optional(v.number()),
    loop_freeze_ms: v.optional(v.number()),
    // The same measure over the trailing hour, plus the worst single freeze and
    // the stacks it was in. This is the loop freeze budget the daemonLogs cron
    // alerts on and the devices settings page shows. Rounded by the daemon (1h
    // to 5s, max to 1s) so a beat that changed nothing else does not rewrite
    // the row and churn the roster.
    loop_freeze_1h_ms: v.optional(v.number()),
    loop_freeze_max_ms: v.optional(v.number()),
    loop_freeze_top: v.optional(v.string()),
    // Debounce state for the aggregated "daemon overloaded" notification
    // (daemonLogs.checkDeviceLoopFreeze). One write per incident, not per tick.
    // Dropped once the hour total has stayed under the bar past
    // FREEZE_NOTIFY_COOLDOWN_MS, which is what lets the next real incident on
    // this machine announce itself. Not on the first dip: a machine hovering at
    // the bar crosses it every other tick, and clearing on the dip would let it
    // reset its own debounce and alert every ten minutes.
    freeze_notify_state: v.optional(
      v.object({
        last_notified_at: v.number(),
        // Hour total covered by that notification; only a HIGHER total is a fresh
        // incident worth announcing again.
        last_hour_ms: v.number(),
      }),
    ),
    pending_sync_count: v.optional(v.number()),
    oldest_pending_ms: v.optional(v.number()),
    pending_sync_messages: v.optional(v.number()),
    pending_sync_conversations: v.optional(v.number()),
    sync_no_progress_ms: v.optional(v.number()),
    is_remote: v.optional(v.boolean()),
    // Set when work was queued for a REMOTE device that is offline (a cloud
    // host that put itself to sleep). The configured server waker or a local
    // daemon boots the host; a heartbeat from the device itself clears it.
    // Never set for a local device — nothing can wake
    // a closed laptop.
    wake_requested_at: v.optional(v.number()),
    cloud_wake: v.optional(
      v.object({
        request_at: v.number(),
        attempt: v.number(),
        next_attempt_at: v.number(),
        status: v.union(
          v.literal("pending"),
          v.literal("starting"),
          v.literal("awake"),
          v.literal("failed"),
        ),
        lease_token: v.optional(v.string()),
        lease_until: v.optional(v.number()),
        last_error: v.optional(v.string()),
        aws_request_id: v.optional(v.string()),
      }),
    ),
    local_project_roots: v.optional(v.array(v.string())),
    // The line checkouts this device offers (lib/lineSlotsValidator).
    line_slots: v.optional(lineSlotsValidator),
    // An operator's hold on this device's line slots (linePool.holdLine): its checkouts stay in the pool with no room,
    // whatever the heartbeat reports, for a machine that cannot finish a run (no Codex for Review) and cannot be reached.
    line_hold: v.optional(v.object({ why: v.string(), at: v.number() })),
    // The one job this machine is kept for (e.g. "Union line"), set by its owner in Settings → Machines or
    // `cast devices reserve`. Automatic placement never picks it (deviceRouting.pickOwnerDevice and every
    // other picker go through isReservedDevice): work reaches it only by name (a --device pick, a move, a
    // line slot) or because it already runs there. Absent means any work may land here.
    reserved_for: v.optional(v.string()),
    // Git-plane health per repo with live sessions on this device (gitPlane.ts),
    // heartbeat-reported: is origin a real rendezvous URL, does fetch succeed,
    // how far HEAD sits from upstream. Metadata only — never file content or
    // credentials. Surfaces silent drift (a dead bundle origin, a repo weeks
    // behind) in the UI instead of during an incident.
    git_plane: v.optional(
      v.array(
        v.object({
          root: v.string(),
          origin: v.optional(v.string()),
          origin_ok: v.boolean(),
          fetch_ok: v.optional(v.boolean()),
          ahead: v.optional(v.number()),
          behind: v.optional(v.number()),
          branch: v.optional(v.string()),
          fetched_at: v.optional(v.number()),
          repaired_from: v.optional(v.string()),
          // Fetch fails with an auth error even via the device key: the machine
          // needs to be granted repo access (the devices page renders the grant card).
          needs_access: v.optional(v.boolean()),
          // "device" when the per-device fallback git key is the identity in use.
          identity: v.optional(v.string()),
          error: v.optional(v.string()),
        }),
      ),
    ),
    // The device's PUBLIC git key (ed25519), heartbeat-reported. Not a secret —
    // it exists precisely to be pasted into GitHub/GitLab to grant this machine
    // repo access. The private half never leaves the device.
    git_pubkey: v.optional(v.string()),
    // A cloud host's readiness from its own disk (heartbeat, only when it
    // changed), and its managing laptop's report (cloud.reportCloudHost).
    host_readiness: v.optional(hostReadinessValidator),
    cloud_host: v.optional(cloudHostReportValidator),
    // Autoscale with this host as the template (Settings > Machines): the
    // laptop that prepares a placement reads it (cloud.autoscalePolicies).
    cloud_autoscale: v.optional(cloudAutoscaleValidator),
    // Saved CC account profiles on this machine (names/emails/tiers only,
    // never tokens) — heartbeat-reported, drives the web account switcher.
    cc_accounts: v.optional(ccAccountsValidator),
    // DEPRECATED (2026-08-01): superseded by codex_accounts. Kept as v.any()
    // because prod rows still hold data and old daemons still send it; drop
    // once the field is cleared everywhere.
    codex_usage: v.optional(v.any()),
    // Saved Codex (ChatGPT) account profiles on this machine (names/emails/
    // plans/usage percentages, never tokens) — heartbeat-reported, same shape
    // as cc_accounts so the web renders both with one component set.
    codex_accounts: v.optional(ccAccountsValidator),
    // Managed-provider-key metadata (pl-207), heartbeat-reported. The public half
    // of the device's ECDH keypair — NOT a secret; the web encrypts a key to it so
    // Convex never sees plaintext. `managed_provider_ids` is which providers have a
    // key set here (ids only, never the keys) — drives the web's managed/unmanaged
    // status, mirroring how cc_accounts reports names-not-tokens.
    provider_key_pubkey: v.optional(v.string()),
    managed_provider_ids: v.optional(v.array(v.string())),
    // What keeps this machine from reading each cloud agent provider (no
    // sign-in, expired, turned off for the account: CloudAgentSetupBlock),
    // heartbeat-reported, so Settings does not call it connected.
    cloud_agent_blocks: v.optional(cloudAgentBlocksValidator),
    // Auto-switch on usage limits: when on, limit-parked sessions trigger a
    // server-side check that switches this machine to the best saved profile
    // and revives them, retrying until unblocked or every account is spent.
    // Web-set (setAutoSwitchAccounts); the heartbeat never writes these.
    cc_auto_switch: v.optional(v.boolean()),
    // Same-account resume once the limit window resets (no switch). Only an
    // explicit true turns it on; unset is off (recoveryModeOf).
    // Web-set (setAutoContinueAccounts). Shares cc_auto_switch_state.
    cc_auto_continue: v.optional(v.boolean()),
    // Ask before changing accounts. When on, a limit that would trigger an
    // account switch instead records a PROPOSAL (cc_auto_switch_state
    // .last_decision, kind "propose") and leaves the sessions parked for the
    // human to approve from the park card — same-account resume still runs on
    // its own. Opt-in like every recovery mode: a machine that never chose
    // recovers nothing. Never both: setRecoveryMode keeps cc_auto_switch and
    // this mutually exclusive.
    cc_recovery_ask: v.optional(v.boolean()),
    cc_auto_switch_state: v.optional(ccAutoSwitchStateValidator),
    // The in-flight browser sign-in round trip (web CTA → daemon `claude auth
    // login` → outcome). Web-set to pending; daemon-set to confirmed/rejected.
    cc_login_flow: v.optional(ccLoginFlowValidator),
    // Deprecated rollout field. Per-session account tokens are always enabled;
    // retained while existing device rows and older clients still carry it.
    cc_session_tokens: v.optional(v.boolean()),
    // The in-flight mint round trip (web/daemon → `claude setup-token` →
    // outcome). Web-set or daemon-set to pending; daemon-set to the outcome.
    cc_mint_flow: v.optional(ccMintFlowValidator),
    // Installed agent-feature snippets (by slug) + stable mode on this machine
    // — heartbeat-reported, drives the web Settings page (per-device toggles).
    settings: v.optional(deviceSettingsValidator),
    // Launchable `provider/model` ids per dynamic client (opencode/pi) on this
    // machine — heartbeat-reported (hash-gated), drives the web model pickers.
    model_inventory: v.optional(modelInventoryValidator),
    // The cast version this device's daemon runs, and a newer release it could
    // update to (absent when none), for the device page. Heartbeat-written.
    cli_version: v.optional(v.string()),
    update_available: v.optional(v.string()),
    // Self update as desired state (lib/deviceUpdate.ts): whether this install
    // can replace its own binary and how it was installed (heartbeat), the
    // Update button's request (web), and the daemon's run for it (heartbeat).
    can_self_update: v.optional(v.boolean()),
    distribution: v.optional(distributionValidator),
    update_requested_version: v.optional(v.string()),
    update_requested_at: v.optional(v.number()),
    update_state: v.optional(updateStateValidator),
    update_error: v.optional(v.string()),
    // The team this machine is enrolled in through its MDM profile
    // (managedDevices.ts). Set when the enrollment completes, cleared when an
    // admin revokes it. The heartbeat and the policy guard read it here.
    enrolled_team_id: v.optional(v.id("teams")),
    // This machine's place on a running tailnet, heartbeat-reported only when
    // it changes (docs/architecture/peer-transport.md). Projected to the owner only.
    tailnet: v.optional(
      v.object({
        ip: v.string(),
        name: v.string(),
        tailnet: v.optional(v.string()),
        ts_user_id: v.optional(v.string()),
        bindable: v.optional(v.boolean()),
      }),
    ),
    // "Accept direct links" off: folderSync never asks this machine for a direct grant.
    direct_links_off: v.optional(v.boolean()),
    // When this machine asked for folders (folderSync rate limit), inside the window only.
    folder_export_at: v.optional(v.array(v.number())),
  })
    .index("by_user_id", ["user_id"])
    .index("by_user_device", ["user_id", "device_id"]),

  // The last transfer outcome per ordered pair of one owner's machines
  // (peerLinks.ts): from = the source that served, to = the requester.
  peer_links: defineTable({
    user_id: v.id("users"),
    from_device_id: v.string(),
    to_device_id: v.string(),
    last_direct_ok_at: v.optional(v.number()),
    last_direct_failure: v.optional(
      v.object({ at: v.number(), reason: v.string() }),
    ),
    last_relay_ok_at: v.optional(v.number()),
    last_bytes: v.optional(v.number()),
    updated_at: v.number(),
  })
    .index("by_user", ["user_id"])
    .index("by_user_pair", ["user_id", "from_device_id", "to_device_id"]),

  // Every change codecast made to a device's agent harness (CLAUDE.md, hooks,
  // ~/.claude/settings.json), as the daemon's harness.ts recorded it: what,
  // why, and whether anyone asked. The device page's change history reads
  // this. Capped per device (harnessChanges.report).
  harness_changes: defineTable({
    user_id: v.id("users"),
    device_id: v.string(),
    at: v.number(),
    file: v.string(),
    action: v.union(
      v.literal("created"),
      v.literal("modified"),
      v.literal("removed"),
    ),
    what: v.string(),
    why: v.string(),
    automatic: v.boolean(),
    version: v.string(),
    bytes_before: v.number(),
    bytes_after: v.number(),
  }).index("by_user_device_at", ["user_id", "device_id", "at"]),

  // A person's machine opened to one of their teams (Settings → Devices). A
  // teammate may start sessions there, which run under the owner's daemon and
  // account exactly like a team agent box's run under the bot's. One row per
  // device per team; its presence is the whole fact. A share only counts
  // while the owner is still on the team (sessionLaunch.listTeamMachines).
  device_shares: defineTable({
    user_id: v.id("users"),
    device_id: v.string(),
    team_id: v.id("teams"),
    shared_at: v.number(),
  })
    .index("by_team", ["team_id"])
    .index("by_user_device", ["user_id", "device_id"]),
};

export const systemConfigTables = {
  system_config: defineTable({
    key: v.string(),
    value: v.string(),
    updated_at: v.number(),
    updated_by: v.optional(v.id("users")),
  }).index("by_key", ["key"]),
};

export const daemonLogTables = {
  daemon_logs: defineTable({
    user_id: v.id("users"),
    level: v.union(
      v.literal("debug"),
      v.literal("info"),
      v.literal("warn"),
      v.literal("error"),
    ),
    message: v.string(),
    metadata: v.optional(
      v.object({
        session_id: v.optional(v.string()),
        error_code: v.optional(v.string()),
        stack: v.optional(v.string()),
        command: v.optional(v.string()),
        args: v.optional(v.string()),
        error: v.optional(v.string()),
      }),
    ),
    daemon_version: v.optional(v.string()),
    platform: v.optional(v.string()),
    timestamp: v.number(),
  })
    // Deliberately the ONLY index: this is the highest-row-count table in the
    // DB (telemetry), and every index multiplies both its footprint in the
    // Convex `indexes` table and the tombstone cost of pruning it. user_id
    // lookups use this index's prefix; there is no by-level query path.
    .index("by_user_timestamp", ["user_id", "timestamp"]),
};
