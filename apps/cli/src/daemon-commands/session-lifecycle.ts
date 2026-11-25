import {
  cancelBackendSwitch,
  backendSwitchHeld,
} from "../claudeSdk/switchBackend.js";
import { type ResourceProcess } from "@codecast/machines/systemResources";
import { MID_TURN_AGENT_STATUSES } from "@codecast/sessions/agentStatus";
import { deviceId } from "../remote/device.js";
import { createTurnSnapshot } from "../treeSnapshot.js";
import { repoRootFor } from "../gitPlane.js";
import type { CommandOutcome, DaemonCommandDeps } from "./dependencies.js";

export async function handleSessionLifecycleCommand(
  daemon: Pick<
    DaemonCommandDeps,
    | "buildReverseConversationCache"
    | "clearConversationDeliveryAndResumeState"
    | "collectGitSweepTargets"
    | "currentAgentStatus"
    | "hibernateSessionNow"
    | "killConversationBackends"
    | "killConversationBackendsForAgentSwitch"
    | "log"
    | "pendingAgentSwitches"
    | "readConfig"
    | "readConversationCache"
    | "resumeSessionCache"
    | "sessionProcessesOutsideTree"
    | "startedSessionTmux"
    | "stopLocalSessionBackends"
    | "stopSessionProcessesOutsideTree"
    | "switchConversationBackend"
    | "syncServiceRef"
    | "takeTurnSnapshot"
    | "tmuxSessionsCreatedBy"
    | "turnCompletedAtFor"
  >,
  commandOutcome: CommandOutcome,
  command: string,
  commandArgs: string | undefined,
): Promise<void> {
  const {
    buildReverseConversationCache,
    clearConversationDeliveryAndResumeState,
    collectGitSweepTargets,
    currentAgentStatus,
    hibernateSessionNow,
    killConversationBackends,
    killConversationBackendsForAgentSwitch,
    log,
    pendingAgentSwitches,
    readConfig,
    readConversationCache,
    resumeSessionCache,
    sessionProcessesOutsideTree,
    startedSessionTmux,
    stopLocalSessionBackends,
    stopSessionProcessesOutsideTree,
    switchConversationBackend,
    takeTurnSnapshot,
    tmuxSessionsCreatedBy,
    turnCompletedAtFor,
  } = daemon;
  switch (command) {
    case "kill_session": {
      const parsed = commandArgs ? JSON.parse(commandArgs) : {};
      const conversationId = parsed.conversation_id;
      if (!conversationId) {
        commandOutcome.error = "Missing conversation_id";
        break;
      }
      const sessionIdHint =
        typeof parsed.session_id === "string" && parsed.session_id
          ? parsed.session_id
          : undefined;
      // A kill wins over a backend switch in progress: the switch stops without starting the other
      // side, and the kill waits for it to let go so a resume behind this kill (a Restart) can run.
      await cancelBackendSwitch(conversationId, sessionIdHint);
      const switchKill =
        parsed.switch_agent === true ||
        pendingAgentSwitches.has(conversationId);
      const killed = switchKill
        ? await killConversationBackendsForAgentSwitch(
            conversationId,
            sessionIdHint,
          )
        : await killConversationBackends(
            conversationId,
            sessionIdHint,
            parsed.keep_workspace !== true,
          );
      commandOutcome.result = killed.result;
      commandOutcome.error = killed.error;
      break;
    }
    // `cast hibernate <session>`: park the pane now. Being asked by a person
    // excuses the fleet cap and the idle bar, never the safety rules: the
    // same refusals the pass applies, through the same function.
    case "hibernate_session": {
      const parsed = commandArgs ? JSON.parse(commandArgs) : {};
      const sessionId: string | undefined =
        typeof parsed.session_id === "string" ? parsed.session_id : undefined;
      const conversationId: string | undefined =
        typeof parsed.conversation_id === "string"
          ? parsed.conversation_id
          : undefined;
      if (!sessionId) {
        commandOutcome.error = "Missing session_id";
        break;
      }
      // A session moving between backends is not parked; the switch decides where it runs.
      if (backendSwitchHeld(sessionId, conversationId)) {
        commandOutcome.result = JSON.stringify({
          parked: false,
          reason: "switching backend",
        });
        commandOutcome.error =
          "not parked: the session is switching between the terminal and the Agent SDK";
        break;
      }
      const outcome = await hibernateSessionNow(sessionId, conversationId);
      commandOutcome.result = outcome.result;
      commandOutcome.error = outcome.error;
      break;
    }
    case "switch_claude_backend": {
      // A person moved a Claude conversation between the terminal and the
      // Agent SDK (the header's "Runs in" control). Same session id and
      // transcript; a running turn is refused unless interrupt is set.
      const parsed = commandArgs ? JSON.parse(commandArgs) : {};
      const conversationId: string | undefined =
        typeof parsed.conversation_id === "string"
          ? parsed.conversation_id
          : undefined;
      const target =
        parsed.backend === "sdk" || parsed.backend === "tmux"
          ? parsed.backend
          : undefined;
      if (!conversationId || !target) {
        commandOutcome.error =
          "switch_claude_backend: missing conversation_id or backend";
        break;
      }
      const switched = await switchConversationBackend(
        conversationId,
        typeof parsed.session_id === "string" ? parsed.session_id : undefined,
        target,
        parsed.interrupt === true,
        typeof parsed.project_path === "string"
          ? parsed.project_path
          : undefined,
      );
      // A refusal reaches the control that asked (its sessionCommands row); nothing moved, so the
      // session itself carries no error.
      commandOutcome.result = switched.result;
      commandOutcome.error = switched.error;
      break;
    }
    case "quiesce_session": {
      // A migration is about to transfer this session's transcript, so the
      // agent here must stop first — otherwise the copy is a snapshot of a
      // turn still being written. Targeted at the CURRENT owner (us);
      // ownership is untouched, the flip is a later mutation. "idle" refuses
      // while a turn is in progress so the runner can keep waiting; "force"
      // interrupts it (the runner's idle wait ran out, or the human said so).
      const parsed = commandArgs ? JSON.parse(commandArgs) : {};
      const conversationId: string | undefined =
        typeof parsed.conversation_id === "string"
          ? parsed.conversation_id
          : undefined;
      const sessionId: string | undefined =
        typeof parsed.session_id === "string" ? parsed.session_id : undefined;
      const mode: "idle" | "force" = parsed.mode === "force" ? "force" : "idle";
      if (!conversationId || !sessionId) {
        commandOutcome.error =
          "quiesce_session: missing conversation_id/session_id";
        break;
      }
      const status = currentAgentStatus(sessionId);
      if (mode === "idle" && MID_TURN_AGENT_STATUSES.has(status ?? "")) {
        commandOutcome.result = JSON.stringify({
          quiesced: false,
          reason: `status-${status}`,
        });
        log(
          `[MIGRATE] quiesce ${sessionId.slice(0, 8)} refused — turn in progress (${status})`,
        );
        break;
      }
      const hadPane =
        resumeSessionCache.has(sessionId) ||
        startedSessionTmux.has(conversationId);
      log(
        `[MIGRATE] quiescing ${sessionId.slice(0, 8)} (${mode}${status ? `, status ${status}` : ""})`,
      );
      // Named now, stopped at release: a move that fails after this point
      // restarts the agent here, and a background render must survive that.
      const outside = await sessionProcessesOutsideTree(sessionId).catch(
        () => [] as ResourceProcess[],
      );
      const outsideTmux = await tmuxSessionsCreatedBy(sessionId);
      await stopLocalSessionBackends(conversationId, sessionId).catch(() => {});
      await clearConversationDeliveryAndResumeState(
        conversationId,
        sessionId,
        "quiesce_session",
      ).catch(() => {});
      commandOutcome.result = JSON.stringify({
        quiesced: true,
        mode,
        had_pane: hadPane,
        status: status ?? null,
        outside: [
          ...outsideTmux.map((name) => ({ name: `tmux session ${name}` })),
          ...outside.map((p) => ({
            pid: p.pid,
            name: p.name,
            via: p.detached,
          })),
        ],
      });
      break;
    }
    case "rewind_files": {
      // "Rewind to here" (rewindTree.ts, rewindFilesDaemon.ts), routed to the owning device.
      const parsed = commandArgs ? JSON.parse(commandArgs) : {};
      const { REWIND_FILES_OPS } = await import("@codecast/daemon/rewindFiles");
      if (
        typeof parsed.conversation_id !== "string" ||
        !(REWIND_FILES_OPS as readonly string[]).includes(parsed.op)
      ) {
        commandOutcome.error = "rewind_files: missing conversation_id or op";
        break;
      }
      const sessionId = buildReverseConversationCache(readConversationCache())[
        parsed.conversation_id
      ];
      const [target] = sessionId ? collectGitSweepTargets([sessionId]) : [];
      const root = target
        ? ((await repoRootFor(target.cwd)) ?? target.cwd)
        : "";
      const lastStop = sessionId ? turnCompletedAtFor(sessionId) : undefined;
      const { runRewindFilesForDaemon } =
        await import("../rewindFilesDaemon.js");
      ({ result: commandOutcome.result, error: commandOutcome.error } =
        await runRewindFilesForDaemon(parsed, {
          checkout: target ? { root, cwd: target.cwd } : null,
          // Any agent mid-turn in this checkout, not only this session's.
          busy: async () => {
            const working = Object.keys(readConversationCache()).filter((sid) =>
              MID_TURN_AGENT_STATUSES.has(currentAgentStatus(sid) ?? ""),
            );
            for (const t of collectGitSweepTargets(working))
              if (((await repoRootFor(t.cwd)) ?? t.cwd) === root) return true;
            return false;
          },
          lastTurnEnd: lastStop,
          snapshotsOff: readConfig()?.wip_snapshots_enabled === false,
          recordLastTurn: lastStop
            ? () =>
                takeTurnSnapshot(
                  root,
                  new Map([[parsed.conversation_id, lastStop]]),
                )
            : undefined,
          advanceChain: async () => {
            await createTurnSnapshot(root);
          },
          log,
        }));
      break;
    }
    case "release_session": {
      // Ownership was reassigned AWAY from this device ("Run here" on another
      // machine). Targeted at us — the previous owner — so we must NOT sit
      // behind the SESSION_COMMANDS single-owner guard (which would skip this
      // precisely because we no longer own the conversation). Reap every
      // local backend so no stale tmux/agent copy keeps running here — the
      // same teardown move_to_device runs on the source after a transfer.
      const parsed = commandArgs ? JSON.parse(commandArgs) : {};
      const conversationId: string | undefined = parsed.conversation_id;
      const sessionId: string | undefined = parsed.session_id;
      if (!conversationId) {
        commandOutcome.error = "release_session: missing conversation_id";
        break;
      }
      // Race guard: if ownership bounced back to us (A→B→A before we polled
      // move 1's release), this command is stale — tearing down would kill a
      // session we rightfully run. Fail-open on lookup error: the command
      // only exists because ownership moved away, so cleanup is the norm.
      try {
        const info =
          await daemon.syncServiceRef?.getConversationOwnerInfo(conversationId);
        if (info?.ownerDeviceId === deviceId()) {
          log(
            `[RELEASE] skipping ${conversationId.slice(0, 12)} — ownership is back on this device`,
          );
          commandOutcome.result = JSON.stringify({
            released: false,
            reason: "owner_again",
          });
          break;
        }
      } catch {
        /* fall through and release */
      }
      log(
        `[RELEASE] releasing ${conversationId.slice(0, 12)} — ownership moved to another device`,
      );
      await stopLocalSessionBackends(conversationId, sessionId).catch(() => {});
      const stopped = sessionId
        ? await stopSessionProcessesOutsideTree(sessionId)
        : [];
      await clearConversationDeliveryAndResumeState(
        conversationId,
        sessionId,
        "release_session",
      ).catch(() => {});
      commandOutcome.result = JSON.stringify({
        released: true,
        stopped: stopped.map((p) => ({
          pid: p.pid,
          name: p.name,
          via: p.detached,
        })),
      });
      break;
    }
  }
}
