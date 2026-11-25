import { deviceId } from "../remote/device.js";
import { type Config } from "../config/types.js";
import type { CommandOutcome, DaemonCommandDeps } from "./dependencies.js";
import { postCommandResult } from "./post-command-result.js";
import { handleMachineCommand } from "./machine.js";
import { handleTerminalCommand } from "./terminal.js";
import { handleExportCommand } from "./exports.js";
import { handleWorkflowCommand } from "./workflows.js";
import { handleSessionInputCommand } from "./session-input.js";
import { handleSessionLifecycleCommand } from "./session-lifecycle.js";
import { handleAccountCommand } from "./account.js";
import { handleConfigCommand } from "./config-files.js";
import { handleLineCommand } from "./line.js";
import { handleCloudCommand } from "./cloud.js";
import { handleStartSessionCommand } from "./start-session.js";
import { handleResumeSessionCommand } from "./resume-session.js";

const OUTCOME_LOGGED_COMMANDS = new Set([
  "kill_session",
  "start_session",
  "resume_session",
  "fork_session",
  "hibernate_session",
  "move_to_device",
  "switch_account",
  "escape",
  "rewind",
]);

// Which conversation a command acts on and who asked for it, for the
// "Executing command" line: a kill used to log only its command id, so finding
// what tore a session down meant dumping daemon_commands from prod.
export function commandLogContext(args: string | undefined): string {
  if (!args) return "";
  try {
    const parsed = JSON.parse(args);
    const conv =
      typeof parsed?.conversation_id === "string"
        ? ` conv=${parsed.conversation_id.slice(0, 12)}`
        : "";
    const cause =
      typeof parsed?.cause === "string" ? ` cause=${parsed.cause}` : "";
    return conv + cause;
  } catch {
    return "";
  }
}

export async function executeRemoteCommand(
  daemon: DaemonCommandDeps,
  commandId: string,
  command: string,
  config: Config,
  commandArgs?: string,
): Promise<void> {
  const {
    clearConversationDeliveryAndResumeState,
    discardPrimedClaim,
    dropClaim,
    forgetProcessedCommand,
    holdClaim,
    killLocalPanesForConversation,
    log,
    ownedByAnotherDevice,
    takePrimedClaim,
  } = daemon;
  const siteUrl = config.convex_url?.replace(".cloud", ".site");
  if (!siteUrl || !config.auth_token) return;

  const commandOutcome: CommandOutcome = {};
  // Work that must follow this command's report (a line edit's republish,
  // whose own report has to land after the first one).

  // Single-owner guard: skip session-targeted commands for conversations owned
  // by ANOTHER device (local peer OR a remote Mac the session was moved to),
  // online or not. Both daemons poll the same user-scoped command queue and
  // moveSessionToDevice enqueues an UNtargeted resume_session, so without this
  // the non-owner daemon races the owner — e.g. after a move-to-remote the local
  // daemon would resume a local copy and answer in parallel with the remote
  // (split-brain). A person reclaims a session from a dead owner with the
  // header chip, which restamps the owner before any command reaches this daemon.
  const SESSION_COMMANDS = new Set([
    "resume_session",
    "fork_session",
    "kill_session",
    "send_keys",
    "set_permission_mode",
    "escape",
    "rewind",
    "hibernate_session",
    "switch_claude_backend",
    "rewind_files",
  ]);
  if (SESSION_COMMANDS.has(command) && commandArgs && daemon.syncServiceRef) {
    try {
      const parsedArgs = JSON.parse(commandArgs);
      const convId = parsedArgs?.conversation_id;
      if (convId) {
        const info =
          await daemon.syncServiceRef.getConversationOwnerInfo(convId);
        if (ownedByAnotherDevice(info)) {
          log(
            `[OWNER] skipping ${command} for ${String(convId).slice(0, 12)} — owned by device ${info?.ownerDeviceId.slice(0, 8)}${info?.ownerIsRemote ? " (remote)" : ""} (not ${deviceId().slice(0, 8)})`,
          );
          // …except a kill, which ALWAYS sweeps this machine's own panes first.
          // Routing the command to the owner is still right (it holds the rest of
          // the backends), but a pane physically here is only reachable from here:
          // deferring to the owner left owner-mismatched panes unkillable from
          // every device. The sweep is safe to run twice — it is has-session
          // guarded and idempotent — and the owner==local case never reaches it.
          if (command === "kill_session") {
            const sessionIdHint =
              typeof parsedArgs?.session_id === "string" &&
              parsedArgs.session_id
                ? parsedArgs.session_id
                : undefined;
            const swept = await killLocalPanesForConversation(
              convId,
              sessionIdHint,
              "OWNER",
            );
            // The owner runs the real teardown, but the local delivery/resume
            // caches are OURS and would otherwise survive the kill and suppress
            // (or resurrect) the next message. Always clear them — and always say
            // so: a silent swept-0 is indistinguishable from the command never
            // arriving, which is how this path stayed invisible.
            await clearConversationDeliveryAndResumeState(
              convId,
              sessionIdHint,
              "OWNER",
            );
            log(
              swept > 0
                ? `[OWNER] kill_session for ${String(convId).slice(0, 12)} swept ${swept} local pane(s) and cleared in-flight resume state before deferring to the owner`
                : `[OWNER] kill_session for ${String(convId).slice(0, 12)} — no local panes; cleared in-flight resume state`,
            );
          }
          // A lease primed for this batch would otherwise sit here unheld
          // until the grace window, blocking a peer daemon on this machine.
          discardPrimedClaim(commandId, siteUrl, config.auth_token);
          return; // leave the rest of the command for the owner device
        }
      }
    } catch {
      /* on any error, fall through and execute (fail-open) */
    }
  }

  // Claim the command before running it. Two daemons can share a device (both
  // sides of an upgrade, a rogue self spawn) and both poll the same queue, so
  // without this both execute every command: a resume runs twice, a kill races
  // a resume. One insertion covers all three delivery paths (subscription, 10s
  // poll, heartbeat embedded) because all three funnel through here.
  //
  // The answer is usually already in flight: executeCommandBatch primes the
  // whole batch together, so N commands cost one round trip instead of N. The
  // lease is scoped to this device, so priming ahead of the owner guard cannot
  // take work away from the machine that owns the session. What it can do is
  // hold a lease this daemon then defers, and the owner guard hands that back.
  //
  // It fails OPEN on purpose. Only the two answers that mean another daemon
  // owns the work skip: held_by_other and already_executed. A 404 from an older
  // server, a network error, a timeout, an auth failure, a missing row or a
  // malformed body all execute. A claim endpoint that is missing, unreachable
  // or wedged must never wedge every command on the machine, which is far worse
  // than the double execution this prevents.
  //
  // The request is bounded for the same reason the heartbeat is: a socket that
  // opens and never answers must not stall the batch behind it.
  const claim = await takePrimedClaim(commandId, siteUrl, config.auth_token);
  if (
    claim &&
    claim.claimed === false &&
    (claim.reason === "held_by_other" || claim.reason === "already_executed")
  ) {
    // The caller already marked this id as handled here. For a live hold, undo
    // that: the holder can die before executing, and once the lease lapses the
    // 10s poll offers the command again. Keep the marking for already_executed,
    // which is final.
    if (claim.reason === "held_by_other") forgetProcessedCommand(commandId);
    log(`[CLAIM] skipping ${command} (${commandId}): ${claim.reason}`);
    return;
  }
  // Held from here until the result is reported, so a graceful stop in between
  // gives the command back instead of stranding it for the grace window.
  if (claim?.claimed) holdClaim(commandId);

  try {
    switch (command) {
      case "status":
      case "version":
      case "restart":
      case "force_update":
      case "reinstall":
      case "desktop_update":
        if (
          (await handleMachineCommand(
            daemon,
            commandOutcome,
            commandId,
            command,
            config,
            siteUrl,
          )) === "reported"
        )
          return;
        break;
      case "get_terminal_endpoint":
      case "stream_pane":
      case "stream_browser":
        await handleTerminalCommand(
          daemon,
          commandOutcome,
          command,
          config,
          commandArgs,
          siteUrl,
        );
        break;
      case "export_folder":
      case "export_session":
        await handleExportCommand(daemon, commandOutcome, command, commandArgs);
        break;
      case "cap_publish":
      case "run_workflow":
      case "run_cast":
      case "merge_back":
      case "apply_snippet":
      case "org_template_bind":
      case "agent_tool_setup":
        await handleWorkflowCommand(
          daemon,
          commandOutcome,
          command,
          config,
          commandArgs,
          siteUrl,
        );
        break;
      case "escape":
      case "rewind":
      case "send_keys":
      case "set_permission_mode":
        await handleSessionInputCommand(
          daemon,
          commandOutcome,
          command,
          commandArgs,
        );
        break;
      case "kill_session":
      case "hibernate_session":
      case "switch_claude_backend":
      case "quiesce_session":
      case "rewind_files":
      case "release_session":
        await handleSessionLifecycleCommand(
          daemon,
          commandOutcome,
          command,
          commandArgs,
        );
        break;
      case "switch_account":
      case "start_login":
      case "set_provider_key":
        await handleAccountCommand(
          daemon,
          commandOutcome,
          commandId,
          command,
          commandArgs,
        );
        break;
      case "config_list":
      case "config_read":
      case "config_write":
      case "config_create":
      case "config_delete":
        await handleConfigCommand(daemon, commandOutcome, command, commandArgs);
        break;
      case "line_profile_edit":
      case "line_graph_edit":
      case "line_try":
      case "line_deploy":
      case "line_fixloop":
      case "line_trial_reask":
        await handleLineCommand(
          daemon,
          commandOutcome,
          commandId,
          command,
          config,
          commandArgs,
          siteUrl,
        );
        break;
      case "move_to_device":
      case "cloud_spawn":
      case "cloud_live_sync":
      case "cloud_host_action":
      case "cloud_browser_sync":
      case "vault_capture_signin":
      case "vault_check_signin":
      case "migrate_sessions":
      case "team_host_member":
      case "rehearse_moves":
      case "cloud_agent_login":
      case "cloud_agent_action":
        await handleCloudCommand(daemon, commandOutcome, command, commandArgs);
        break;
      case "start_session":
        await handleStartSessionCommand(
          daemon,
          commandOutcome,
          command,
          config,
          commandArgs,
        );
        break;
      case "fork_session":
      case "resume_session":
        await handleResumeSessionCommand(
          daemon,
          commandOutcome,
          command,
          config,
          commandArgs,
          siteUrl,
        );
        break;
      default:
        commandOutcome.error = `Unknown command: ${command}`;
    }
  } catch (err) {
    commandOutcome.error = err instanceof Error ? err.message : String(err);
  }

  // The outcome, beside the "Executing command" line. Bodies are logged only
  // for session lifecycle commands: other results can carry tokens.
  const body =
    OUTCOME_LOGGED_COMMANDS.has(command) && commandOutcome.result
      ? ` result=${commandOutcome.result.slice(0, 160)}`
      : "";
  log(
    `[CMD] ${command} (${commandId})${commandLogContext(commandArgs)} -> ${commandOutcome.error ? `error=${commandOutcome.error.slice(0, 200)}` : "ok"}${body}`,
    commandOutcome.error ? "warn" : "info",
  );

  // Report result
  try {
    await postCommandResult(
      siteUrl,
      config.auth_token,
      commandId,
      commandOutcome.result,
      commandOutcome.error,
    );
  } catch (err) {
    // The server keeps the command pending and may redeliver it.
    log(
      `[CMD] ${command} (${commandId}) result not reported: ${err instanceof Error ? err.message : String(err)}`,
      "warn",
    );
  } finally {
    // The lease dies with the report either way: a reported command carries an
    // executed_at, and the server refuses to release one of those.
    dropClaim(commandId);
  }
  commandOutcome.afterReport?.();
}
