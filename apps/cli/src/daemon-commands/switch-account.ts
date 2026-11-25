import { switchFleetTo, fleetStoreDir } from "../ccAccounts.js";
import { shortId } from "../sessionProcessMatcher.js";
import { followsCredentialStore } from "../processEnv.js";
import type { CommandOutcome, DaemonCommandDeps } from "./dependencies.js";

export async function switchAccount(
  daemon: Pick<
    DaemonCommandDeps,
    | "FLEET_REREAD_WAIT_MS"
    | "SWITCH_CONTINUE_SPACING_MS"
    | "accountLifecycleGate"
    | "buildReverseConversationCache"
    | "findSessionProcess"
    | "killConversationBackends"
    | "log"
    | "maintainCcUsageSnapshots"
    | "pacedAccountRevive"
    | "pushCredentialToRemoteHosts"
    | "readConversationCache"
    | "sendHeartbeat"
    | "syncServiceRef"
  >,
  commandOutcome: CommandOutcome,
  commandId: string,
  profile: string | undefined,
  followIds: string[],
  conversationIds: string[],
  sessionIds: Record<string, string>,
  sendContinue: boolean,
  continueClientIds: Record<string, string>,
): Promise<void> {
  const {
    FLEET_REREAD_WAIT_MS,
    SWITCH_CONTINUE_SPACING_MS,
    accountLifecycleGate,
    buildReverseConversationCache,
    findSessionProcess,
    killConversationBackends,
    log,
    maintainCcUsageSnapshots,
    pushCredentialToRemoteHosts,
    readConversationCache,
    sendHeartbeat,
  } = daemon;

  const gateWaitStarted = Date.now();
  const releaseAccountSwitch = profile
    ? await accountLifecycleGate.acquireSwitch()
    : await accountLifecycleGate.acquireResume("claude");
  const gateWaitMs = Date.now() - gateWaitStarted;
  if (gateWaitMs > 250) {
    log(
      `[ACCOUNTS] ${profile ? `switch to "${profile}"` : "recovery"} waited ${gateWaitMs}ms for in-flight Claude launches to spawn`,
    );
  }
  try {
    let switched: string | null = null;
    let fleetMoved = false;
    if (profile) {
      try {
        // On the fleet store the store is rewritten and running
        // sessions follow it. Otherwise the keychain when the saved
        // login is usable, else the minted setup-token (the launch
        // record: the fleet moves, the keychain login stays); the
        // restarts below then carry the pins the server corrected.
        const switchResult = await switchFleetTo(profile);
        switched = switchResult.to;
        fleetMoved = switchResult.mode === "fleet";
        log(
          switchResult.mode === "fleet"
            ? `[ACCOUNTS] Fleet store moved to "${profile}"${switchResult.toEmail ? ` (${switchResult.toEmail})` : ""}${switchResult.from ? ` from "${switchResult.from}"` : ""}; running sessions follow without a restart`
            : switchResult.mode === "token"
              ? `[ACCOUNTS] Switched fleet to "${profile}"${switchResult.toEmail ? ` (${switchResult.toEmail})` : ""} on its setup-token; the keychain login stays`
              : `[ACCOUNTS] ${switchResult.keptLive ? "Already on" : "Switched CC account to"} "${profile}"${switchResult.toEmail ? ` (${switchResult.toEmail})` : ""}${switchResult.from ? `, re-saved outgoing as "${switchResult.from}"` : ""}${switchResult.keptLive ? ", kept the live login" : ""}`,
        );
        // Remotes run on a pushed COPY of the keychain credential — refresh
        // them now instead of waiting for the 30-min loop. A token switch
        // changed nothing they receive.
        if (switchResult.mode === "keychain")
          pushCredentialToRemoteHosts("account_switch").catch(() => {});
        // Surface the new active account in Settings without waiting a beat.
        sendHeartbeat().catch(() => {});
        // Probe the new account's meters now, not at the next 5-minute
        // tick: the server's auto-switch loop holds off judging this
        // account until a snapshot fetched after the switch lands.
        maintainCcUsageSnapshots("account_switch")
          .then(() => sendHeartbeat())
          .catch(() => {});
      } catch (err) {
        // Don't tear anything down if the swap itself failed.
        commandOutcome.error = `Account switch failed: ${err instanceof Error ? err.message : String(err)}`;
        return;
      }
    }

    // The server counts every session on a fleet machine as a follower,
    // but a `claude` started by hand reads the keychain, not the store,
    // and would resume on the exhausted account forever. Restart those.
    if (fleetMoved && followIds.length > 0) {
      const reverse = buildReverseConversationCache(readConversationCache());
      const storeDir = fleetStoreDir();
      for (const convId of [...followIds]) {
        const sessionId = reverse[convId];
        const proc = sessionId
          ? await findSessionProcess(sessionId, "claude")
          : null;
        if (!proc || followsCredentialStore(proc.pid, storeDir) !== false)
          continue;
        followIds.splice(followIds.indexOf(convId), 1);
        conversationIds.push(convId);
        sessionIds[convId] = sessionId;
        log(
          `[ACCOUNTS] ${shortId(sessionId)} (pid ${proc.pid}) is not on the fleet store; restarting it instead of following`,
        );
      }
    }

    let killed = 0;
    let continued = 0;
    for (const convId of conversationIds) {
      try {
        const out = await killConversationBackends(convId, sessionIds[convId]);
        if (
          out.result &&
          out.result !== "no_process" &&
          out.result !== "no_session"
        )
          killed++;
      } catch (err) {
        log(
          `[ACCOUNTS] Teardown failed for ${String(convId).slice(0, 12)}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (sendContinue && daemon.syncServiceRef) {
      // Paced, not fired at once: each continue resumes a process whose
      // first request carries the whole context, and twenty of those in
      // the same half-minute trip the provider's per-minute cap — the
      // fleet then parks on a 429 the CLI renders as a limit, and the
      // loop rotates to the next account to do it again (2026-09-04).
      // The spacing keeps the revive under the cap; the enqueue runs on
      // after the command reports so the ack isn't held for minutes.
      const sync = daemon.syncServiceRef;
      const enqueueContinue = async (convId: string) => {
        try {
          // client_id keyed by command id: re-running the command can't
          // double-queue, but a deliberate second switch still can.
          await sync.enqueueUserMessage(
            convId,
            "continue",
            continueClientIds[convId] || `acct-switch-${commandId}-${convId}`,
          );
          return true;
        } catch (err) {
          log(
            `[ACCOUNTS] Continue enqueue failed for ${String(convId).slice(0, 12)}: ${err instanceof Error ? err.message : String(err)}`,
          );
          return false;
        }
      };
      // A follower still holds the old account's credential until Claude
      // Code re-reads the store, so its continue waits that out.
      const followWaitMs =
        followIds.length > 0 && switched ? FLEET_REREAD_WAIT_MS : 0;
      const revive = [...conversationIds, ...followIds];
      const immediate = followWaitMs === 0 ? revive.slice(0, 1) : [];
      const rest = revive.slice(immediate.length);
      for (const convId of immediate)
        if (await enqueueContinue(convId)) continued++;
      if (rest.length > 0) {
        continued += rest.length;
        if (profile) {
          daemon.pacedAccountRevive = {
            profile,
            pending:
              (daemon.pacedAccountRevive?.profile === profile
                ? daemon.pacedAccountRevive.pending
                : 0) + rest.length,
          };
        }
        const paceProfile = profile;
        void (async () => {
          try {
            if (followWaitMs)
              await new Promise((resolve) => setTimeout(resolve, followWaitMs));
            let sent = 0;
            for (const [i, convId] of rest.entries()) {
              if (i > 0 || immediate.length > 0)
                await new Promise((resolve) =>
                  setTimeout(resolve, SWITCH_CONTINUE_SPACING_MS),
                );
              if (await enqueueContinue(convId)) sent++;
            }
            log(
              `[ACCOUNTS] paced continues done: ${sent}/${rest.length} enqueued ${SWITCH_CONTINUE_SPACING_MS / 1000}s apart after switch=${switched ?? "none"}`,
            );
          } finally {
            if (
              paceProfile &&
              daemon.pacedAccountRevive?.profile === paceProfile
            ) {
              daemon.pacedAccountRevive.pending -= rest.length;
              if (daemon.pacedAccountRevive.pending <= 0)
                daemon.pacedAccountRevive = null;
            }
          }
        })();
      }
    }
    commandOutcome.result = JSON.stringify({ switched, killed, continued });
    log(
      `[ACCOUNTS] switch_account done: switched=${switched ?? "none"} killed=${killed}/${conversationIds.length} continued=${continued}${conversationIds.length > 1 ? ` (paced ${SWITCH_CONTINUE_SPACING_MS / 1000}s apart)` : ""}`,
    );
  } finally {
    releaseAccountSwitch();
  }
  return;
}
