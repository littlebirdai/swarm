import { execSync } from "../proc.js";
import { type Config } from "../config/types.js";
import type { CommandOutcome, DaemonCommandDeps } from "./dependencies.js";

export async function handleMachineCommand(
  daemon: Pick<
    DaemonCommandDeps,
    | "daemonVersion"
    | "flushRemoteLogs"
    | "isAutostartEnabled"
    | "log"
    | "logLifecycle"
    | "logWarn"
    | "platform"
    | "readDaemonState"
    | "restartDaemonProcess"
    | "runSelfUpdate"
    | "syncStats"
  >,
  commandOutcome: CommandOutcome,
  commandId: string,
  command: string,
  config: Config,
  siteUrl: string,
): Promise<"reported" | void> {
  const {
    flushRemoteLogs,
    isAutostartEnabled,
    log,
    logLifecycle,
    logWarn,
    platform,
    readDaemonState,
    restartDaemonProcess,
    runSelfUpdate,
    syncStats,
  } = daemon;
  switch (command) {
    case "status": {
      const state = readDaemonState();
      commandOutcome.result = JSON.stringify({
        version: daemon.daemonVersion,
        platform,
        pid: process.pid,
        uptime: process.uptime(),
        autostart: isAutostartEnabled(),
        lastSync: state?.lastSyncTime,
        queueSize: state?.pendingQueueSize,
        stats: {
          messagesSynced: syncStats.messagesSynced,
          conversationsCreated: syncStats.conversationsCreated,
          activeSessions: syncStats.sessionsActive.size,
        },
      });
      log(`[REMOTE] Status requested, responding`);
      break;
    }
    case "version": {
      commandOutcome.result = daemon.daemonVersion || "unknown";
      log(`[REMOTE] Version requested: ${commandOutcome.result}`);
      break;
    }
    case "restart": {
      log(`[REMOTE] Restart requested`);
      commandOutcome.result = "restarting";
      // Report result first, then restart
      await fetch(`${siteUrl}/cli/command-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_token: config.auth_token,
          command_id: commandId,
          result: commandOutcome.result,
        }),
      });
      setTimeout(() => {
        restartDaemonProcess("remote restart command");
      }, 1000);
      return "reported";
    }
    case "force_update": {
      commandOutcome.result = "updating";
      // Report result first, then update
      await fetch(`${siteUrl}/cli/command-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_token: config.auth_token,
          command_id: commandId,
          result: commandOutcome.result,
        }),
      });
      setTimeout(() => void runSelfUpdate("remote update command"), 1000);
      return "reported";
    }
    case "reinstall": {
      const currentVersion = daemon.daemonVersion || "unknown";
      log(`[REMOTE] Reinstall requested from v${currentVersion}`);
      commandOutcome.result = "reinstalling";
      await fetch(`${siteUrl}/cli/command-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_token: config.auth_token,
          command_id: commandId,
          result: commandOutcome.result,
        }),
      }).catch(() => {});
      await flushRemoteLogs();
      setTimeout(() => {
        try {
          execSync(
            "curl -fsSL --proto '=https' --proto-redir '=https' https://codecast.sh/install | sh",
            { timeout: 120000, stdio: "ignore" },
          );
          logLifecycle(
            "reinstall_complete",
            `Reinstalled from v${currentVersion}`,
          );
        } catch (e) {
          logLifecycle(
            "reinstall_failed",
            `Failed from v${currentVersion}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        flushRemoteLogs().finally(() => {
          setTimeout(() => process.exit(0), 500);
        });
      }, 1000);
      return "reported";
    }
    // "Update now" from the in-app banner: apply the published desktop release
    // immediately (force quit + swap + relaunch) instead of waiting for the
    // next app quit. Forced, so it stops a running app via SIGTERM/SIGKILL.
    // Sent by a click, or by the web's below-floor gate on its own. Forced, so
    // it runs from a source checkout, ignores the retry throttle and stops a
    // running app; but never a reinstall of an app that is already current —
    // the gate broadcasts to every daemon of the user, and a second Mac that
    // is fine must stay untouched.
    case "desktop_update": {
      const { checkForDesktopUpdate } = await import("../desktopUpdate.js");
      const applied = await checkForDesktopUpdate((msg) => log(msg), {
        force: true,
        reinstall: false,
        warn: (msg) => logWarn(msg),
      });
      if (applied) {
        commandOutcome.result = "desktop_updated";
      } else {
        commandOutcome.error =
          "no desktop update applied (already current, app not installed, or unavailable)";
      }
      break;
    }
  }
}
