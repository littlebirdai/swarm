import { settledCodexRecord } from "../codexTurnRecovery.js";
import { decideEscape, turnLooksActive } from "../escapeInterrupt.js";
import {
  type TmuxLiveState,
  glyphlessPromptPattern,
} from "../tmuxPaneState.js";
import type {
  CommandOutcome,
  DaemonCommandDeps,
  PermissionMode,
} from "./dependencies.js";

export async function handleSessionInputCommand(
  daemon: Pick<
    DaemonCommandDeps,
    | "PERMISSION_MODES"
    | "appServerConversations"
    | "buildReverseConversationCache"
    | "captureTmuxLiveState"
    | "claudeSdkBackend"
    | "cloudAgents"
    | "codexAppServerInstance"
    | "detectSessionAgentType"
    | "findActiveTurnForThread"
    | "lastHookStatus"
    | "latestInjectionTsFor"
    | "log"
    | "logConvexFailure"
    | "nextSdkPermissionMode"
    | "observeSessionInput"
    | "parsePermissionModeFooter"
    | "persistAppServerThreadRegistrations"
    | "persistedAppServerThreads"
    | "readConversationCache"
    | "recordObservedPermissionMode"
    | "resolveCommandSessionId"
    | "resolveSessionCommandPane"
    | "stepPermissionMode"
    | "syncServiceRef"
    | "tmuxExec"
    | "turnStartedAtFor"
    | "withPanePermissionModeLock"
  >,
  commandOutcome: CommandOutcome,
  command: string,
  commandArgs: string | undefined,
): Promise<void> {
  const {
    PERMISSION_MODES,
    appServerConversations,
    buildReverseConversationCache,
    captureTmuxLiveState,
    cloudAgents,
    detectSessionAgentType,
    findActiveTurnForThread,
    lastHookStatus,
    latestInjectionTsFor,
    log,
    logConvexFailure,
    nextSdkPermissionMode,
    observeSessionInput,
    parsePermissionModeFooter,
    persistAppServerThreadRegistrations,
    persistedAppServerThreads,
    readConversationCache,
    recordObservedPermissionMode,
    resolveCommandSessionId,
    resolveSessionCommandPane,
    stepPermissionMode,
    tmuxExec,
    turnStartedAtFor,
    withPanePermissionModeLock,
  } = daemon;
  switch (command) {
    case "escape": {
      const parsed = commandArgs ? JSON.parse(commandArgs) : {};
      const conversationId = parsed.conversation_id;
      if (!conversationId) {
        commandOutcome.error = "Missing conversation_id";
        break;
      }
      // The web forwards every press and shows the interruption line at once;
      // this handler holds the facts (see escapeInterrupt.ts) and decides.
      const pressedAt =
        typeof parsed.pressed_at === "number" ? parsed.pressed_at : null;
      const lastInjectedAt = latestInjectionTsFor(conversationId);
      // A "stop and send" (release_queued) left its message queued for the
      // end of the turn the Escape stops. When there is no turn to stop, no
      // settle will come to release it, so it goes now. A turn a newer
      // message started keeps the row queued behind it.
      const releaseStopAndSend = (): void => {
        if (parsed.release_queued)
          void daemon.syncServiceRef
            ?.releaseQueued(conversationId)
            .catch(logConvexFailure);
      };
      const skipEscape = (
        verdict: { action: "skip"; reason: string },
        where: string,
      ): void => {
        if (verdict.reason !== "message_injected_after_press")
          releaseStopAndSend();
        commandOutcome.result = `escape_${verdict.reason}`;
        log(
          `[REMOTE] Escape skipped for ${conversationId.slice(0, 12)} (${where}): ${verdict.reason}${pressedAt ? ` pressed ${Date.now() - pressedAt}ms ago` : ""}${lastInjectedAt ? `, last injection ${Date.now() - lastInjectedAt}ms ago` : ""}`,
        );
      };

      // A Claude SDK session: a real interrupt, answered once the turn has drained.
      if (daemon.claudeSdkBackend?.owns(conversationId)) {
        // The interrupt is sent now; its drain runs off the command queue, so a long turn's
        // wind-down never holds the commands queued behind this one. A stop-and-send message
        // is released once the turn has drained.
        if (!daemon.claudeSdkBackend.isRunning(conversationId)) {
          commandOutcome.result = "escape_no_active_turn";
          releaseStopAndSend();
          break;
        }
        commandOutcome.result = "escape_sent";
        void daemon.claudeSdkBackend
          .interrupt(conversationId)
          .catch((err) =>
            log(
              `[claude-sdk] interrupt failed for ${conversationId.slice(0, 12)}: ${err instanceof Error ? err.message : String(err)}`,
            ),
          )
          .finally(releaseStopAndSend);
        break;
      }

      // A cloud agent: Escape cancels its running turn.
      try {
        const cloudEscape = await cloudAgents.interrupt(conversationId);
        if (cloudEscape) {
          commandOutcome.result =
            cloudEscape === "sent" ? "escape_sent" : "escape_no_active_turn";
          if (cloudEscape !== "sent") releaseStopAndSend();
          break;
        }
      } catch (err) {
        commandOutcome.error = err instanceof Error ? err.message : String(err);
        break;
      }

      const escapeThreadId =
        appServerConversations.get(conversationId) ??
        persistedAppServerThreads.get(conversationId)?.threadId;
      if (escapeThreadId) {
        const activeTurnId = findActiveTurnForThread(escapeThreadId);
        const persisted = persistedAppServerThreads.get(conversationId);
        if (persisted?.activeTurnId) {
          persistedAppServerThreads.set(
            conversationId,
            settledCodexRecord(persisted, persisted.activeTurnId),
          );
          persistAppServerThreadRegistrations();
        }
        // turn/start is the app-server's injection; its mark is this daemon's clock.
        const turnStartedAt = turnStartedAtFor(escapeThreadId);
        const verdict = decideEscape({
          pressedAt,
          now: Date.now(),
          lastInjectedAt:
            Math.max(lastInjectedAt ?? 0, turnStartedAt ?? 0) || null,
          turnActive:
            !!activeTurnId && !!daemon.codexAppServerInstance?.running,
        });
        if (verdict.action === "skip") {
          skipEscape(
            verdict,
            `app-server thread ${escapeThreadId.slice(0, 8)}`,
          );
          break;
        }
        await daemon.codexAppServerInstance!.turnInterrupt(
          escapeThreadId,
          activeTurnId!,
        );
        commandOutcome.result = "escape_interrupted";
        log(
          `[REMOTE] Interrupted app-server turn ${activeTurnId!.slice(0, 8)} on thread ${escapeThreadId.slice(0, 8)}`,
        );
        break;
      }

      const sessionId = await resolveCommandSessionId(conversationId);
      if (!sessionId) {
        releaseStopAndSend();
        commandOutcome.error = `No session found for conversation ${conversationId}`;
        break;
      }
      const agentType = detectSessionAgentType(sessionId);
      const { tmuxTarget, proc } = await resolveSessionCommandPane(
        conversationId,
        sessionId,
        agentType,
      );
      if (!tmuxTarget && !proc) {
        releaseStopAndSend();
        commandOutcome.error = `No running process for session ${sessionId.slice(0, 8)}`;
        break;
      }
      const hookStatus = lastHookStatus.get(sessionId)?.status;
      let paneState: TmuxLiveState | null = null;
      if (tmuxTarget) {
        try {
          ({ state: paneState } = await captureTmuxLiveState(
            tmuxTarget,
            glyphlessPromptPattern(agentType),
            25,
          ));
        } catch (captureErr) {
          log(
            `[REMOTE] Escape: could not read pane ${tmuxTarget} (${captureErr instanceof Error ? captureErr.message : String(captureErr)}); judging by hook status ${hookStatus ?? "unknown"}`,
          );
        }
      }
      const verdict = decideEscape({
        pressedAt,
        now: Date.now(),
        lastInjectedAt,
        turnActive: turnLooksActive(hookStatus, paneState),
      });
      if (verdict.action === "skip") {
        skipEscape(
          verdict,
          `session ${sessionId.slice(0, 8)} pane=${paneState ?? "none"} hook=${hookStatus ?? "unknown"}`,
        );
        break;
      }
      if (tmuxTarget) {
        await tmuxExec(["send-keys", "-t", tmuxTarget, "Escape", "Escape"]);
        observeSessionInput(sessionId, { kind: "escape" });
        commandOutcome.result = "escape_sent";
        log(
          `[REMOTE] Sent double Escape to session ${sessionId.slice(0, 8)} via tmux ${tmuxTarget} (pane=${paneState ?? "unread"} hook=${hookStatus ?? "unknown"})`,
        );
      } else {
        // A SIGINT reaching claude at its prompt EXITS the process (observed
        // 2026-08-28: pid 41092 died on an escape sent to an idle session), so
        // the no-pane path only runs once the hook status proves a turn.
        try {
          process.kill(proc!.pid, "SIGINT");
          observeSessionInput(sessionId, { kind: "ctrl-c" });
          commandOutcome.result = "escape_sent_sigint";
          log(
            `[REMOTE] Sent SIGINT to session ${sessionId.slice(0, 8)} pid=${proc!.pid}`,
          );
        } catch (killErr) {
          commandOutcome.error = `Failed to send SIGINT to pid ${proc!.pid}: ${killErr}`;
        }
      }
      break;
    }
    case "rewind": {
      const parsed = commandArgs ? JSON.parse(commandArgs) : {};
      const conversationId = parsed.conversation_id;
      const stepsBack = parsed.steps_back;
      if (!conversationId || stepsBack === undefined || stepsBack < 1) {
        commandOutcome.error = "Missing conversation_id or invalid steps_back";
        break;
      }
      const cache = readConversationCache();
      const reverse = buildReverseConversationCache(cache);
      const sessionId = reverse[conversationId];
      if (!sessionId) {
        commandOutcome.error = `No session found for conversation ${conversationId}`;
        break;
      }
      const agentType = detectSessionAgentType(sessionId);
      if (agentType !== "claude") {
        commandOutcome.error = `Rewind not yet supported for ${agentType} sessions`;
        break;
      }
      const { tmuxTarget, proc } = await resolveSessionCommandPane(
        conversationId,
        sessionId,
        agentType,
      );
      if (!proc && !tmuxTarget) {
        commandOutcome.error = `No running process for session ${sessionId.slice(0, 8)}`;
        break;
      }
      if (!tmuxTarget) {
        commandOutcome.error = `No tmux pane found for session ${sessionId.slice(0, 8)}`;
        break;
      }

      const safeSteps = Math.min(
        Math.max(1, Math.floor(Number(stepsBack))),
        50,
      );

      const PROMPT_RE = /[❯›]/;
      const BUSY_RE =
        /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|Wandering|Vibing|Coasting|Working|thinking/;
      const NAVIGATOR_RE = /Enter to continue/;
      const RESTORE_RE = /Restore conversation/;

      const captureLast = async (): Promise<string> => {
        const { stdout } = await tmuxExec([
          "capture-pane",
          "-p",
          "-J",
          "-t",
          tmuxTarget,
          "-S",
          "-8",
        ]);
        return stdout.split("\n").slice(-15).join("\n");
      };

      const isAtPrompt = async (): Promise<boolean> => {
        const last = await captureLast();
        return PROMPT_RE.test(last) && !BUSY_RE.test(last);
      };

      const waitFor = async (
        test: (text: string) => boolean,
        label: string,
        maxWait = 10000,
      ): Promise<boolean> => {
        const start = Date.now();
        while (Date.now() - start < maxWait) {
          const last = await captureLast();
          if (test(last)) return true;
          await new Promise((r) => setTimeout(r, 300));
        }
        log(`[REWIND] Timed out waiting for: ${label}`);
        return false;
      };

      // Step 1: Get to idle prompt (double Escape to interrupt if busy)
      if (!(await isAtPrompt())) {
        log(
          `[REWIND] Session not at prompt, sending double Escape to interrupt`,
        );
        await tmuxExec(["send-keys", "-t", tmuxTarget, "Escape", "Escape"]);
        const gotPrompt = await waitFor(
          (text) => PROMPT_RE.test(text) && !BUSY_RE.test(text),
          "prompt after interrupt",
          30000,
        );
        if (!gotPrompt) {
          commandOutcome.error = "Timed out waiting for prompt after interrupt";
          break;
        }
        log(`[REWIND] Got prompt after interrupt`);
      }

      // Step 2: Clear any existing text (double Escape clears in CC)
      log(`[REWIND] Clearing prompt with double Escape`);
      await tmuxExec(["send-keys", "-t", tmuxTarget, "Escape", "Escape"]);
      await new Promise((r) => setTimeout(r, 300));

      // Step 3: Navigate history with Up arrows
      // First Up opens the visual navigator, subsequent Ups move back
      log(`[REWIND] Sending ${safeSteps} Up arrows to open navigator`);
      const upKeys = Array.from({ length: safeSteps }, () => "Up");
      await tmuxExec(["send-keys", "-t", tmuxTarget, ...upKeys]);

      // Step 4: Verify navigator opened
      const navigatorOpened = await waitFor(
        (text) => NAVIGATOR_RE.test(text),
        "navigator to open",
      );
      if (!navigatorOpened) {
        log(`[REWIND] Navigator did not open after ${safeSteps} Up arrows`);
        commandOutcome.error = `No message found at history position ${safeSteps}`;
        break;
      }

      // Step 5: Select message in navigator (first Enter)
      log(`[REWIND] Selecting message in navigator`);
      await tmuxExec(["send-keys", "-t", tmuxTarget, "Enter"]);

      // Step 6: Confirm "Restore conversation" (second Enter)
      const atRestore = await waitFor(
        (text) => RESTORE_RE.test(text),
        "restore confirmation",
      );
      if (atRestore) {
        log(`[REWIND] Confirming restore`);
        await tmuxExec(["send-keys", "-t", tmuxTarget, "Enter"]);
      } else {
        log(`[REWIND] No restore confirmation shown, sending Enter anyway`);
        await tmuxExec(["send-keys", "-t", tmuxTarget, "Enter"]);
      }

      // Wait for forked session prompt with the rewound message pre-filled
      // Don't submit — let the user review/edit the message in the web UI
      await waitFor(
        (text) => PROMPT_RE.test(text) && !BUSY_RE.test(text),
        "prompt with rewound message",
        15000,
      );

      commandOutcome.result = "rewind_sent";
      log(
        `[REWIND] Rewind ${stepsBack} steps sent to session ${sessionId.slice(0, 8)}`,
      );
      break;
    }
    case "send_keys": {
      const parsed = commandArgs ? JSON.parse(commandArgs) : {};
      const conversationId = parsed.conversation_id;
      const keys = parsed.keys;
      if (!conversationId || !keys) {
        commandOutcome.error = "Missing conversation_id or keys";
        break;
      }
      const ALLOWED_KEYS = new Set([
        "BTab",
        "Escape",
        "Enter",
        "Tab",
        "Up",
        "Down",
        "Left",
        "Right",
        "Space",
        "BSpace",
      ]);
      const keyList = keys.split(" ");
      const invalidKey = keyList.find((k: string) => !ALLOWED_KEYS.has(k));
      if (invalidKey) {
        commandOutcome.error = `Key '${invalidKey}' not in allowlist`;
        break;
      }
      const sessionId = await resolveCommandSessionId(conversationId);
      if (!sessionId) {
        commandOutcome.error = `No session found for conversation ${conversationId}`;
        break;
      }
      const { tmuxTarget, proc } = await resolveSessionCommandPane(
        conversationId,
        sessionId,
        detectSessionAgentType(sessionId),
      );
      if (!proc && !tmuxTarget) {
        commandOutcome.error = `No running process for session ${sessionId.slice(0, 8)}`;
        break;
      }
      if (tmuxTarget) {
        const groups: string[][] = [];
        for (const k of keyList) {
          if (
            k === "Escape" ||
            k === "Enter" ||
            (groups.length > 0 && k !== groups[groups.length - 1][0])
          ) {
            groups.push([k]);
          } else if (groups.length === 0) {
            groups.push([k]);
          } else {
            groups[groups.length - 1].push(k);
          }
        }
        for (let i = 0; i < groups.length; i++) {
          if (i > 0) {
            const prevKey = groups[i - 1][0];
            const needsDelay = prevKey === "Escape" || prevKey === "Enter";
            await new Promise((r) => setTimeout(r, needsDelay ? 600 : 150));
          }
          await tmuxExec(["send-keys", "-t", tmuxTarget, ...groups[i]]);
        }
        commandOutcome.result = "keys_sent";
        log(
          `[REMOTE] Sent ${keys} (${groups.length} groups) to session ${sessionId.slice(0, 8)} via tmux ${tmuxTarget}`,
        );
      } else {
        commandOutcome.error = `No tmux pane found for session ${sessionId.slice(0, 8)}`;
      }
      break;
    }
    // Shift+tab through Claude Code's permission modes and read back where
    // it landed (stepPermissionMode). With `target`, press until the footer
    // names that mode. The observed mode is published like a hook post, so
    // the web's pill moves within the second instead of at the next turn.
    case "set_permission_mode": {
      const parsed = commandArgs ? JSON.parse(commandArgs) : {};
      const conversationId = parsed.conversation_id;
      const target =
        typeof parsed.target === "string" ? parsed.target : undefined;
      if (!conversationId) {
        commandOutcome.error = "Missing conversation_id";
        break;
      }
      if (target && !PERMISSION_MODES.has(target)) {
        commandOutcome.error = `Unknown permission mode '${target}'`;
        break;
      }
      // A Claude SDK session changes mode through its host: no footer to press.
      if (daemon.claudeSdkBackend?.owns(conversationId)) {
        const current =
          daemon.claudeSdkBackend.permissionModeFor(conversationId);
        const mode = target ?? nextSdkPermissionMode(current);
        if (
          await daemon.claudeSdkBackend.setPermissionMode(conversationId, mode)
        ) {
          commandOutcome.result = mode;
          log(
            `[REMOTE] set_permission_mode: SDK session for ${conversationId.slice(0, 12)} now ${mode}`,
          );
        } else
          commandOutcome.error = `The Claude SDK session for ${conversationId} is not running`;
        break;
      }
      const sessionId = await resolveCommandSessionId(conversationId);
      if (!sessionId) {
        commandOutcome.error = `No session found for conversation ${conversationId}`;
        break;
      }
      const { tmuxTarget } = await resolveSessionCommandPane(
        conversationId,
        sessionId,
        detectSessionAgentType(sessionId),
      );
      if (!tmuxTarget) {
        commandOutcome.error = `No tmux pane found for session ${sessionId.slice(0, 8)}`;
        break;
      }
      const capture = async () =>
        (
          await tmuxExec([
            "capture-pane",
            "-p",
            "-J",
            "-t",
            tmuxTarget,
            "-S",
            "-8",
          ])
        ).stdout;
      // One press-and-read at a time per pane: commands in one batch run
      // concurrently, and two presses racing one footer read each report
      // the other's landing mode (seen with a drained burst, 2026-09-12).
      const outcome = await withPanePermissionModeLock(tmuxTarget, () =>
        stepPermissionMode(
          {
            press: async () => {
              await tmuxExec(["send-keys", "-t", tmuxTarget, "BTab"]);
            },
            readMode: async () => parsePermissionModeFooter(await capture()),
          },
          target as PermissionMode | undefined,
        ),
      );
      if ("error" in outcome) {
        commandOutcome.error = outcome.error;
        log(
          `[REMOTE] set_permission_mode${target ? ` → ${target}` : ""} for session ${sessionId.slice(0, 8)} failed: ${outcome.error}`,
        );
        break;
      }
      recordObservedPermissionMode(
        sessionId,
        conversationId,
        outcome.mode,
        await capture(),
      );
      commandOutcome.result = outcome.mode;
      log(
        `[REMOTE] set_permission_mode${target ? ` → ${target}` : ""}: session ${sessionId.slice(0, 8)} now ${outcome.mode} after ${outcome.presses} press(es) via tmux ${tmuxTarget}`,
      );
      break;
    }
  }
}
