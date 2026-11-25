import {
  agentForksNatively,
  type AgentClientId,
} from "@codecast/agent-clients/agentClients";
import * as fs from "fs";
import { randomUUID } from "node:crypto";
import { markClaudeSessionLive } from "../ccLiveGate.js";
import { setPosition } from "../positionTracker.js";
import { AGENT_ENV_SCRUB, launchTokenEnv } from "../agentEnv.js";
import { launchTokenLedger } from "../launchToken.js";
import { TMUX_SIZE_ARGS } from "../terminal/daemonBridge.js";
import {
  fetchExport,
  generateCodexJsonl,
  writeCodexSession,
  generateGrokSession,
  writeGrokSession,
  generatePiSession,
  piSessionFilePath,
  chooseClaudeTailMessagesForTokenBudget,
  generateClaudeCodeJsonl,
  writeClaudeCodeSession,
} from "../jsonlGenerator.js";
import {
  isValidResumeSessionId,
  chooseClaudeAutoTrim,
  CLAUDE_AUTO_TRIM_TARGET_TOKENS,
} from "../resumeCommand.js";
import { launchBinary } from "../launchCommand.js";
import { type Config } from "../config/types.js";
import { readTitleCache } from "../titleCache.js";
import type {
  CommandOutcome,
  DaemonCommandDeps,
  ReparentedCheckout,
  ResumeOptions,
} from "./dependencies.js";

export async function resumeFallback(
  daemon: Pick<
    DaemonCommandDeps,
    | "autoResumeSession"
    | "blankLaunchAccount"
    | "buildBlankLaunchArgs"
    | "clearConversationDeliveryAndResumeState"
    | "conversationCacheRef"
    | "conversationResumeFailures"
    | "discoverAndLinkSession"
    | "findSessionFile"
    | "log"
    | "logConvexFailure"
    | "mayReconstituteResumeTranscript"
    | "placeArrivedSession"
    | "pushSessionIdBinding"
    | "readBranch"
    | "readConversationCache"
    | "rebindConversationSession"
    | "rebuildOpencodeSession"
    | "refuseResumeNoLocalCheckout"
    | "remapConversationSession"
    | "repairAndResumeSession"
    | "resolveResumeCwdOrRefuse"
    | "restartingSessionIds"
    | "resumeFatalReasons"
    | "resumeOrRepair"
    | "sanitizeBinaryArgs"
    | "saveConversationCache"
    | "sendReparentNotice"
    | "setTmuxSessionOption"
    | "stampCodexPaneAccount"
    | "startedSessionGuard"
    | "startedSessionTmux"
    | "syncServiceRef"
    | "tmuxExec"
    | "typeIntoPane"
    | "writeRebuiltDeltaTranscript"
  >,
  commandOutcome: CommandOutcome,
  config: Config,
  parsed: any,
  conversationId: any,
  resumeAgentType: AgentClientId | undefined,
  sessionId: any,
  projectPath: any,
  resumeOptions: ResumeOptions,
  forceReconstitute: boolean,
  reparented: boolean,
  reparentCheckout: ReparentedCheckout | undefined,
  priorCwd: any,
): Promise<void> {
  const {
    autoResumeSession,
    blankLaunchAccount,
    buildBlankLaunchArgs,
    clearConversationDeliveryAndResumeState,
    conversationResumeFailures,
    discoverAndLinkSession,
    findSessionFile,
    log,
    logConvexFailure,
    mayReconstituteResumeTranscript,
    placeArrivedSession,
    pushSessionIdBinding,
    readBranch,
    readConversationCache,
    rebindConversationSession,
    rebuildOpencodeSession,
    refuseResumeNoLocalCheckout,
    remapConversationSession,
    repairAndResumeSession,
    resolveResumeCwdOrRefuse,
    restartingSessionIds,
    resumeFatalReasons,
    resumeOrRepair,
    sanitizeBinaryArgs,
    saveConversationCache,
    sendReparentNotice,
    setTmuxSessionOption,
    stampCodexPaneAccount,
    startedSessionGuard,
    startedSessionTmux,
    tmuxExec,
    typeIntoPane,
    writeRebuiltDeltaTranscript,
  } = daemon;

  // Native fork: the client copies its own session state under the new id
  // (registry `forkCmd` — grok's `--resume <parent> --fork-session
  // --session-id <new>`). The server offers it only for at-tip plain forks
  // and passes the parent id; this branch never falls through to the
  // rebuild path, because a client that forks natively is one whose
  // transcript codecast cannot write. The new id must be one the client
  // accepts, so a key it would reject is replaced by a fresh UUID and the
  // row rebound — the same shape as a claude reconstitution. The
  // session→conversation map is written BEFORE launch so the watcher
  // links the child's transcript instead of minting a doppelgänger.
  // No delivery-state reset afterwards: the branch's seed message is
  // already in flight against this very launch (its delivery joined the
  // in-flight resume), and clearing it re-delivers the seed (observed
  // 2026-09-05). Nothing stale can exist for a session that never ran.
  if (
    parsed.fork === true &&
    conversationId &&
    resumeAgentType &&
    agentForksNatively(resumeAgentType) &&
    typeof parsed.parent_session_id === "string" &&
    parsed.parent_session_id !== sessionId &&
    !findSessionFile(sessionId)
  ) {
    const parentId = parsed.parent_session_id as string;
    const nativeId = isValidResumeSessionId(resumeAgentType, sessionId)
      ? sessionId
      : randomUUID();
    log(
      `[REMOTE] Native fork ${parentId.slice(0, 8)} → ${nativeId.slice(0, 8)} (${resumeAgentType}) for conv ${conversationId.slice(0, 12)}`,
    );
    try {
      const cache = readConversationCache();
      cache[nativeId] = conversationId;
      saveConversationCache(cache);
      if (daemon.conversationCacheRef)
        daemon.conversationCacheRef[nativeId] = conversationId;
      if (nativeId !== sessionId) {
        remapConversationSession(sessionId, nativeId, conversationId);
        await pushSessionIdBinding(
          conversationId,
          nativeId,
          projectPath || undefined,
        );
      }
      const forked = await autoResumeSession(
        nativeId,
        "",
        readTitleCache(),
        projectPath,
        conversationId,
        resumeAgentType,
        { ...resumeOptions, forkFromSessionId: parentId },
      );
      if (forked) {
        daemon.syncServiceRef
          ?.markSessionActive(conversationId)
          .catch(logConvexFailure);
        conversationResumeFailures.delete(conversationId);
        commandOutcome.result = JSON.stringify({
          forked: true,
          session_id: nativeId,
        });
        log(
          `[REMOTE] Native fork ${nativeId.slice(0, 8)} running for conv ${conversationId.slice(0, 12)}`,
        );
      } else {
        commandOutcome.error = `Native ${resumeAgentType} fork of ${parentId.slice(0, 8)} failed`;
        await daemon.syncServiceRef
          ?.setSessionError(conversationId, commandOutcome.error)
          .catch(logConvexFailure);
      }
    } finally {
      restartingSessionIds.delete(sessionId);
    }
    return;
  }
  let resumed = false;
  if (forceReconstitute) {
    log(
      `[REMOTE] Force-reconstituting session ${sessionId.slice(0, 8)} from DB${projectPath ? ` in ${projectPath}` : ""}`,
    );
    resumed = await repairAndResumeSession(
      sessionId,
      "",
      readTitleCache(),
      projectPath,
      conversationId,
      resumeAgentType,
      resumeOptions,
    );
  } else {
    log(
      `[REMOTE] Force-resuming session ${sessionId.slice(0, 8)}${projectPath ? ` in ${projectPath}` : ""}`,
    );
    const outcome = await resumeOrRepair(
      sessionId,
      () =>
        autoResumeSession(
          sessionId,
          "",
          readTitleCache(),
          projectPath,
          conversationId,
          resumeAgentType,
          resumeOptions,
        ),
      () => {
        log(
          `[REMOTE] Auto-resume failed for ${sessionId.slice(0, 8)}, attempting repair...`,
        );
        return repairAndResumeSession(
          sessionId,
          "",
          readTitleCache(),
          projectPath,
          conversationId,
          resumeAgentType,
          resumeOptions,
        );
      },
    );
    if (outcome === "cancelled") {
      log(
        `[REMOTE] Not resuming ${sessionId.slice(0, 8)}: its transcript transfer was cancelled`,
      );
      restartingSessionIds.delete(sessionId);
      commandOutcome.result = JSON.stringify({
        skipped: true,
        reason: "transfer_cancelled",
      });
      return;
    }
    resumed = outcome !== null;
  }
  if (resumed) {
    if (conversationId) {
      const cache = readConversationCache();
      cache[sessionId] = conversationId;
      saveConversationCache(cache);
      if (daemon.syncServiceRef) {
        daemon.syncServiceRef
          .markSessionActive(conversationId)
          .catch(logConvexFailure);
        // Don't force "connected" here — autoResumeSession already publishes the
        // accurate status (connected once the input prompt is visible, else resuming).
        // Overriding it would re-report the false-live signal fix #1 removes.
      }
    }
    restartingSessionIds.delete(sessionId);
    if (conversationId) conversationResumeFailures.delete(conversationId);
    // A resume revives the tmux pane just like a kill+restart does, so it shares the
    // same redelivery contract: clear the local injection dedup and re-pend injected
    // messages, else the re-queued pending message hits the "injected Ns ago" dedup
    // branch and never reaches the freshly-resumed pane. (Server resumeSession already
    // re-pends in Convex; this clears the *local* state that would otherwise suppress it.)
    await clearConversationDeliveryAndResumeState(
      conversationId,
      sessionId,
      "resume_session",
    );
    commandOutcome.result = JSON.stringify({
      resumed: true,
      session_id: sessionId,
    });
    log(`[REMOTE] Force-resume succeeded for ${sessionId.slice(0, 8)}`);
    if (reparented && conversationId) {
      await placeArrivedSession(sessionId, reparentCheckout?.path, priorCwd);
      await sendReparentNotice({
        conversationId,
        sessionId,
        priorCwd,
        checkout: reparentCheckout,
        command: parsed,
      });
    }
  } else if (conversationId && projectPath) {
    // Reconstitution AND the blank-session fallback below both run in `cwd`.
    // Resolve it to a real local checkout or refuse — never $HOME, which
    // would reconstitute/spawn in the home dir and mislabel the project.
    const cwd = await resolveResumeCwdOrRefuse({
      recordedCwd: projectPath,
      cwdOverride: projectPath,
      conversationId,
    });
    if (!cwd) {
      commandOutcome.error = await refuseResumeNoLocalCheckout(
        sessionId,
        conversationId,
        projectPath,
      );
      restartingSessionIds.delete(sessionId);
      return;
    }
    log(
      `[REMOTE] Resume failed for ${sessionId.slice(0, 8)}, reconstituting session from DB in ${cwd}...`,
    );
    let reconstituted = false;

    // cursor-agent and opencode own their session stores (SQLite), and
    // pi/grok own their JSONL trees under ~/.pi and ~/.grok — none of them
    // may have a Claude JSONL fabricated for them. Skip DB reconstitution
    // for every store-owning client (mayReconstituteResumeTranscript is
    // the single predicate both resume sites share) and fall through to
    // the fresh spawn below.
    if (
      config?.convex_url &&
      config?.auth_token &&
      mayReconstituteResumeTranscript(resumeAgentType)
    ) {
      try {
        const siteUrl = config.convex_url.replace(".cloud", ".site");
        const exportData = await fetchExport(
          siteUrl,
          config.auth_token!,
          conversationId,
        );
        if (exportData.messages.length > 0) {
          const reconAgent = resumeAgentType || "claude";
          let reconJsonl: string;
          let newSessionId: string;
          let reconFilePath: string;
          if (reconAgent === "codex") {
            ({ jsonl: reconJsonl, sessionId: newSessionId } =
              generateCodexJsonl(exportData, { sessionId, cwd }));
            ({ filePath: reconFilePath } = writeCodexSession(
              reconJsonl,
              newSessionId,
            ));
          } else if (reconAgent === "grok") {
            const files = generateGrokSession(exportData, {
              tailMessages: chooseClaudeAutoTrim(exportData),
              cwd,
            });
            ({ sessionId: newSessionId, filePath: reconFilePath } =
              writeGrokSession(files));
          } else if (reconAgent === "pi") {
            const pi = generatePiSession(exportData, {
              tailMessages: chooseClaudeAutoTrim(exportData),
              cwd,
            });
            newSessionId = pi.sessionId;
            reconFilePath = piSessionFilePath(pi.cwd, pi.sessionId);
            await writeRebuiltDeltaTranscript(
              "pi",
              pi.jsonl,
              reconFilePath,
              pi.sessionId,
            );
          } else if (reconAgent === "opencode") {
            const sesId = await rebuildOpencodeSession(exportData, cwd);
            if (!sesId) throw new Error("opencode serve sidecar unavailable");
            newSessionId = sesId;
            reconFilePath = "";
          } else {
            const TOKEN_BUDGET = CLAUDE_AUTO_TRIM_TARGET_TOKENS;
            const tailMessages = chooseClaudeTailMessagesForTokenBudget(
              exportData,
              TOKEN_BUDGET,
            );
            ({ jsonl: reconJsonl, sessionId: newSessionId } =
              generateClaudeCodeJsonl(exportData, {
                tailMessages,
                sessionId,
                cwd,
              }));
            ({ filePath: reconFilePath } = writeClaudeCodeSession(
              reconJsonl,
              newSessionId,
              cwd,
            ));
          }
          if (reconFilePath)
            setPosition(reconFilePath, fs.statSync(reconFilePath).size);
          log(
            `[REMOTE] Reconstituted ${reconAgent} JSONL for ${sessionId.slice(0, 8)} (${exportData.messages.length} msgs)`,
          );

          const reconResumed = await autoResumeSession(
            newSessionId,
            "",
            readTitleCache(),
            cwd,
            conversationId,
            resumeAgentType,
            resumeOptions,
          );
          if (reconResumed) {
            rebindConversationSession(
              sessionId,
              newSessionId,
              conversationId,
              cwd,
            );
            if (daemon.syncServiceRef) {
              daemon.syncServiceRef
                .markSessionActive(conversationId)
                .catch(logConvexFailure);
              daemon.syncServiceRef
                .updateSessionAgentStatus(conversationId, "connected")
                .catch(logConvexFailure);
            }
            restartingSessionIds.delete(sessionId);
            if (conversationId)
              conversationResumeFailures.delete(conversationId);
            // Same redelivery contract as the plain-resume branch above — clear local
            // dedup so re-pended messages reach the reconstituted pane.
            await clearConversationDeliveryAndResumeState(
              conversationId,
              newSessionId,
              "resume_session_reconstitute",
            );
            commandOutcome.result = JSON.stringify({
              reconstituted: true,
              session_id: newSessionId,
            });
            log(
              `[REMOTE] Reconstituted + resumed session ${sessionId.slice(0, 8)}`,
            );
            reconstituted = true;
            if (reparented) {
              // cwd (not projectPath): the refuse-or-resolve step above is
              // what actually decided where this session lives now.
              await placeArrivedSession(newSessionId, cwd, priorCwd);
              await sendReparentNotice({
                conversationId,
                sessionId: newSessionId,
                priorCwd,
                checkout:
                  reparentCheckout?.path === cwd
                    ? reparentCheckout
                    : {
                        path: cwd,
                        cloned: false,
                        branch: readBranch(cwd),
                      },
                command: parsed,
              });
            }
          }
        }
      } catch (reconErr) {
        log(
          `[REMOTE] Reconstitution failed for ${sessionId.slice(0, 8)}: ${reconErr instanceof Error ? reconErr.message : String(reconErr)}`,
        );
      }
    }

    // resume_session is only triggered by explicit user actions (kill & restart,
    // repair). Always fall through to blank session — the user is asking us to restart,
    // not silently give up. Clear any stale fatal reason so it doesn't block future
    // auto-resume attempts either.
    if (!reconstituted) {
      resumeFatalReasons.delete(sessionId);
    }

    if (!reconstituted) {
      const existingStarted = startedSessionTmux.get(conversationId);
      if (
        existingStarted &&
        startedSessionGuard(existingStarted, false) === "skip_booting"
      ) {
        log(
          `[REMOTE] Fresh session ${existingStarted.tmuxSession} already started for ${conversationId.slice(0, 12)}, skipping duplicate`,
        );
        commandOutcome.result = JSON.stringify({
          started_fresh: true,
          tmux_session: existingStarted.tmuxSession,
          deduplicated: true,
        });
        return;
      }
      const blankAgentType = resumeAgentType || "claude";
      log(`[REMOTE] Starting blank ${blankAgentType} session in ${cwd}`);
      const shortId = Math.random().toString(36).slice(2, 8);
      const tmuxSession = `cc-${blankAgentType}-${shortId}`;
      // Registry-sourced binary (adds pi; cursor -> cursor-agent) — the same
      // launchBinary the fresh-start path uses, so no client is silently dropped
      // to claude here.
      const blankBinary = launchBinary(blankAgentType, { warn: log });
      // Inject the default permission flags exactly like start_session and
      // auto-resume. Building from config args alone here launched a bare
      // `claude` that fell into the project's dontAsk default — the agent
      // came back stranded with every tool denied.
      // Without an assigned id, discovery waits for a transcript the
      // pane never writes until someone types into it: a restart with
      // nothing to redeliver left the pane unlinked and the conversation
      // stuck on its old session id.
      const blankSessionId =
        blankAgentType === "claude" ? randomUUID() : undefined;
      const safeBlankArgs = sanitizeBinaryArgs(
        buildBlankLaunchArgs(blankAgentType, config, blankSessionId),
      );
      // Same account rule as every other Claude launch (blankLaunchAccount).
      const blankAccount =
        blankAgentType === "claude"
          ? await blankLaunchAccount(conversationId)
          : {
              prefix: "" as string,
              account: undefined as string | undefined,
            };
      const blankCmdText = `${blankAccount.prefix}${AGENT_ENV_SCRUB}${launchTokenEnv(launchTokenLedger().issue(tmuxSession, blankSessionId))} ${[blankBinary, ...safeBlankArgs].join(" ")}`;
      try {
        await tmuxExec(
          [
            "new-session",
            "-d",
            ...TMUX_SIZE_ARGS,
            "-s",
            tmuxSession,
            "-c",
            cwd,
          ],
          { timeout: 5000 },
        );
        // Tag like the other creation paths so this session is discoverable
        // by conversation (findLiveTmuxForConversation / warm-restart). Without
        // the tag it is orphaned: a later fresh-start can't see it and spawns
        // a duplicate.
        await setTmuxSessionOption(
          tmuxSession,
          "@codecast_conversation_id",
          conversationId,
        ).catch(() => {});
        await setTmuxSessionOption(
          tmuxSession,
          "@codecast_agent_type",
          blankAgentType,
        ).catch(() => {});
        await setTmuxSessionOption(
          tmuxSession,
          "@codecast_project_path",
          cwd,
        ).catch(() => {});
        if (blankAgentType === "claude") {
          if (blankAccount.account)
            await setTmuxSessionOption(
              tmuxSession,
              "@codecast_cc_account",
              blankAccount.account,
            ).catch(() => {});
          markClaudeSessionLive(tmuxSession, blankAccount.account);
        }
        await stampCodexPaneAccount(
          blankAgentType,
          tmuxSession,
          conversationId,
        );
        await typeIntoPane(tmuxSession, blankCmdText);
        startedSessionTmux.set(conversationId, {
          tmuxSession,
          projectPath: cwd,
          startedAt: Date.now(),
          agentType: blankAgentType,
          sessionId: blankSessionId,
        });
        discoverAndLinkSession(conversationId, tmuxSession, cwd).catch(
          (err) => {
            log(
              `Session discovery failed for ${conversationId.slice(0, 12)}: ${err}`,
            );
          },
        );
        // Same redelivery contract as the resume branches above: a first
        // message that exhausted its budget against the old pane, or on
        // the previous owner, has to reach this one.
        await clearConversationDeliveryAndResumeState(
          conversationId,
          undefined,
          "resume_session_blank",
        );
        commandOutcome.result = JSON.stringify({
          started_fresh: true,
          tmux_session: tmuxSession,
        });
        // A blank pane links to the conversation only once a prompt shows up
        // in it; this line names the new session so a pane that never links
        // can be traced back to here.
        log(
          `[REMOTE] Started fresh session ${tmuxSession} for conversation ${conversationId.slice(0, 12)} newSid=${blankSessionId?.slice(0, 8) ?? "-"} (the old session could not be resumed)`,
          "warn",
        );
      } catch (spawnErr) {
        commandOutcome.error = `Failed to start fresh session: ${spawnErr instanceof Error ? spawnErr.message : String(spawnErr)}`;
      }
    }
  } else {
    commandOutcome.error = `Failed to resume session ${sessionId.slice(0, 8)} — session file may not exist locally`;
  }
  if (!resumed && conversationId) {
    const prev = conversationResumeFailures.get(conversationId) || {
      count: 0,
      lastFailure: 0,
    };
    conversationResumeFailures.set(conversationId, {
      count: prev.count + 1,
      lastFailure: Date.now(),
    });
  }
  return;
}
