import { backendSwitchHeld } from "../claudeSdk/switchBackend.js";
import {
  isHostedAgentType,
  fromConvexAgentType,
  type AgentClientId,
  AGENT_CLIENTS,
} from "@codecast/agent-clients/agentClients";
import * as fs from "fs";
import { setPosition } from "../positionTracker.js";
import { markLaunched } from "../syncScope.js";
import {
  fetchExport,
  hasResumableMessages,
  generateGrokSession,
  writeGrokSession,
  generatePiSession,
  piSessionFilePath,
  generateClaudeCodeJsonl,
  writeClaudeCodeSession,
} from "../jsonlGenerator.js";
import { chooseClaudeAutoTrim, copyJsonlAsSession } from "../resumeCommand.js";
import { type Config } from "../config/types.js";
import { readTitleCache } from "../titleCache.js";
import type {
  CommandOutcome,
  DaemonCommandDeps,
  ResumeOptions,
} from "./dependencies.js";
import { resumeForks } from "./resume-forks.js";

export async function handleResumeSessionCommand(
  daemon: Pick<
    DaemonCommandDeps,
    | "CONVERSATION_RESUME_COOLDOWN_MS"
    | "CONVERSATION_RESUME_MAX_FAILURES"
    | "USER_RESUME"
    | "autoResumeSession"
    | "bindSdkSession"
    | "blankLaunchAccount"
    | "buildBlankLaunchArgs"
    | "buildReverseConversationCache"
    | "claudeSdkBackend"
    | "clearConversationDeliveryAndResumeState"
    | "cloudAgents"
    | "conversationCacheRef"
    | "conversationResumeFailures"
    | "discoverAndLinkSession"
    | "ensureManagedSessionHeartbeat"
    | "ensureOpencodeServer"
    | "ensureReparentedCheckout"
    | "findSessionFile"
    | "folderFetchFailures"
    | "getGitInfo"
    | "log"
    | "logConvexFailure"
    | "logError"
    | "mayReconstituteResumeTranscript"
    | "pendingAppServerForkParents"
    | "placeArrivedSession"
    | "pushSessionIdBinding"
    | "readBranch"
    | "readConversationCache"
    | "readyCodexAppServer"
    | "rebindConversationSession"
    | "rebuildOpencodeSession"
    | "refuseResumeNoLocalCheckout"
    | "registerAppServerConversation"
    | "remapConversationSession"
    | "repairAndResumeSession"
    | "resolveCodexPermissionDefaults"
    | "resolveResumeCwdOrRefuse"
    | "restartingSessionIds"
    | "resumeFatalReasons"
    | "resumeInFlight"
    | "resumeInFlightStarted"
    | "resumeOrRepair"
    | "sanitizeBinaryArgs"
    | "saveConversationCache"
    | "seedOpencodeForkSyncBaseline"
    | "sendReparentNotice"
    | "setTmuxSessionOption"
    | "stampCodexPaneAccount"
    | "startedSessionGuard"
    | "startedSessionTmux"
    | "stopManagedSessionHeartbeat"
    | "syncServiceRef"
    | "teardownConversationBackendsLive"
    | "tmuxExec"
    | "typeIntoPane"
    | "writeRebuiltDeltaTranscript"
  >,
  commandOutcome: CommandOutcome,
  command: string,
  config: Config,
  commandArgs: string | undefined,
  siteUrl: string,
): Promise<void> {
  const {
    CONVERSATION_RESUME_COOLDOWN_MS,
    CONVERSATION_RESUME_MAX_FAILURES,
    USER_RESUME,
    autoResumeSession,
    bindSdkSession,
    buildReverseConversationCache,
    clearConversationDeliveryAndResumeState,
    cloudAgents,
    conversationResumeFailures,
    ensureOpencodeServer,
    findSessionFile,
    folderFetchFailures,
    getGitInfo,
    log,
    logConvexFailure,
    mayReconstituteResumeTranscript,
    pushSessionIdBinding,
    readConversationCache,
    rebindConversationSession,
    rebuildOpencodeSession,
    refuseResumeNoLocalCheckout,
    resolveResumeCwdOrRefuse,
    restartingSessionIds,
    resumeInFlight,
    resumeInFlightStarted,
    saveConversationCache,
    seedOpencodeForkSyncBaseline,
    startedSessionGuard,
    startedSessionTmux,
    teardownConversationBackendsLive,
    writeRebuiltDeltaTranscript,
  } = daemon;
  switch (command) {
    // fork_session = resume_session whose JSONL is materialized by the fork
    // fast path (parsed.fork_fast_path) before the normal resume pipeline
    // runs. A separate command name only for backward compat: daemons that
    // predate the fast path must no-op it, not resume-and-reconstitute.
    case "fork_session":
    case "resume_session": {
      const parsed = commandArgs ? JSON.parse(commandArgs) : {};
      // Refused before any delivery or resume bookkeeping: a hosted
      // conversation runs in codecast's backend and no machine resumes it.
      if (isHostedAgentType(parsed.agent_type)) {
        commandOutcome.error = "hosted conversation: no machine resumes it";
        break;
      }
      const sessionId = parsed.session_id;
      const conversationId = parsed.conversation_id;
      const resumeOptions: ResumeOptions = {
        ...USER_RESUME,
        ...(typeof parsed.model === "string" ? { model: parsed.model } : {}),
        ...(typeof parsed.effort === "string" ? { effort: parsed.effort } : {}),
      };
      if (!sessionId) {
        commandOutcome.error = "Missing session_id";
        break;
      }
      if (conversationId) {
        folderFetchFailures.forgetConversation(conversationId);
        (await import("../sessionTransfer.js")).forgetSessionFetchFailures(
          conversationId,
        );
        // A resume sent through codecast is a launch of a conversation that
        // already lives there: its transcript syncs whatever the folder rules.
        markLaunched({ conversationId, sessionId });
      }
      // A backend switch is moving this session and brings it back itself. A Restart, an agent
      // switch or a repair now would rebuild or rebind it under the switch.
      if (backendSwitchHeld(sessionId, conversationId)) {
        commandOutcome.error =
          "This session is switching between the terminal and the Agent SDK; try again when it has moved";
        break;
      }
      // A cloud agent session has no process on this machine to restart (a
      // blank local pane would hijack it): its messages go to the provider,
      // and a held one is tried again on its own.
      if (conversationId && cloudAgents.forConversation(conversationId)) {
        await clearConversationDeliveryAndResumeState(
          conversationId,
          sessionId,
          "resume_session_cloud",
        );
        commandOutcome.result = JSON.stringify({ cloud_agent: true });
        break;
      }
      // A Restart of a Claude SDK conversation resumes in its own host or fails. The tmux repair,
      // reconstitution and blank-pane paths below would put it in two backends at once, or bind
      // the conversation to a session no process runs. Forks and agent switches go on below.
      if (
        conversationId &&
        daemon.claudeSdkBackend?.owns(conversationId) &&
        !parsed.fork &&
        !parsed.switch_agent &&
        !parsed.parent_session_id &&
        (!parsed.agent_type ||
          fromConvexAgentType(parsed.agent_type) === "claude")
      ) {
        try {
          const client = await daemon.claudeSdkBackend.ensure(conversationId, {
            userInitiated: true,
          });
          const sdkSession = daemon.claudeSdkBackend.sessionFor(conversationId);
          const sdkCwd = daemon.claudeSdkBackend.specFor(conversationId)?.cwd;
          if (client && sdkSession && sdkCwd) {
            // Running again: active, connected, claimed and beating, as every tmux resume marks it.
            await bindSdkSession(conversationId, sdkSession, sdkCwd);
            commandOutcome.result = JSON.stringify({ sdk_session: sdkSession });
          } else
            commandOutcome.error = `No Claude SDK session for ${conversationId}`;
        } catch (err) {
          commandOutcome.error = `Could not resume the Claude SDK session: ${err instanceof Error ? err.message : String(err)}`;
          daemon.syncServiceRef
            ?.setSessionError(conversationId, commandOutcome.error)
            .catch(() => {});
        }
        break;
      }
      // Fresh-session guard. If the conversation just had a session spawned
      // (startedSessionTmux still tracks it) and there's no linked Claude
      // session_id yet, an auto-resume from the UI's stuck-banner heuristic
      // will try `claude --resume <nanoid>` which can't succeed — the nanoid
      // is the optimistic id from the inline new-session flow, not a real
      // Claude UUID. We were churning through kill → repair → reconstitute
      // → start-fresh for every such call, racing the tryStartedTmux path
      // that was already about to deliver the user's first message.
      //
      // "Just" is the whole condition. A start record lives for a day, and a
      // pane that never linked (started here while another device owned the
      // conversation) sits in it that long. Treating that record as a boot in
      // progress made a transfer to this machine return here with nothing
      // started and no delivery scheduled. Past the boot window the pane is
      // replaced: it is torn down and the resume below starts a current one.
      if (conversationId) {
        const startedEntry = startedSessionTmux.get(conversationId);
        const linked =
          !!startedEntry &&
          !!buildReverseConversationCache(readConversationCache())[
            conversationId
          ];
        const guard = startedSessionGuard(startedEntry, linked);
        if (startedEntry && guard === "skip_booting") {
          log(
            `[REMOTE] Skipping resume for ${sessionId.slice(0, 8)} — conversation ${conversationId.slice(0, 12)} has a freshly started tmux (${startedEntry.tmuxSession}) that hasn't been linked yet; tryStartedTmux will handle delivery.`,
          );
          commandOutcome.result = JSON.stringify({
            skipped: true,
            reason: "fresh_session_unlinked",
          });
          break;
        }
        if (startedEntry && guard === "replace_stale") {
          log(
            `[REMOTE] Replacing stale started tmux ${startedEntry.tmuxSession} for conversation ${conversationId.slice(0, 12)}: unlinked ${Math.round((Date.now() - startedEntry.startedAt) / 60_000)}m after start`,
          );
          await teardownConversationBackendsLive(conversationId);
        }
      }
      let projectPath = parsed.project_path;
      const forceReconstitute = parsed.force_reconstitute === true;
      // Set by reparentSessionToDevice (cast pull): this session may be running
      // on this machine for the first time, so its repo isn't checked out here.
      const reparented = parsed.reparented === true;
      // Registry-driven normalization; `undefined` means "claude / unspecified"
      // (the downstream `|| "claude"` fallbacks and the findSessionFile detection
      // path own that case). fromConvexAgentType handles both spellings and every
      // client (opencode, pi, ...); claude then collapses back to undefined to
      // preserve the original semantics.
      const normalizedResumeAgent = fromConvexAgentType(parsed.agent_type);
      const resumeAgentType: AgentClientId | undefined =
        normalizedResumeAgent === "claude" ? undefined : normalizedResumeAgent;
      // Skip if a resume is already in flight for this session. An in-place
      // agent switch must not join that promise: it is the OLD agent, and
      // adopting it would silently no-op the switch.
      if (resumeInFlight.has(sessionId) && parsed.switch_agent !== true) {
        log(
          `[REMOTE] Resume already in flight for ${sessionId.slice(0, 8)}, skipping`,
        );
        commandOutcome.result = JSON.stringify({
          skipped: true,
          reason: "resume_in_flight",
        });
        break;
      }
      if (conversationId && parsed.switch_agent !== true) {
        const convFailures = conversationResumeFailures.get(conversationId);
        if (
          convFailures &&
          convFailures.count >= CONVERSATION_RESUME_MAX_FAILURES
        ) {
          if (
            Date.now() - convFailures.lastFailure <
            CONVERSATION_RESUME_COOLDOWN_MS
          ) {
            log(
              `[REMOTE] Resume circuit breaker for conv=${conversationId.slice(0, 12)}: ${convFailures.count} failures, cooling down`,
            );
            commandOutcome.result = JSON.stringify({
              skipped: true,
              reason: "circuit_breaker",
            });
            break;
          }
          conversationResumeFailures.delete(conversationId);
        }
      }
      // In-place agent switch: ignore the old transcript, rebuild as the
      // TARGET agent under a new native session id, rebind this conversation.
      // A live-pane reuse of the OLD agent would silently no-op the switch.
      if (
        parsed.switch_agent === true &&
        conversationId &&
        resumeAgentType !== "codex"
      ) {
        const targetAgent: AgentClientId = resumeAgentType || "claude";
        log(
          `[REMOTE] Agent switch conv=${conversationId.slice(0, 12)} ${sessionId.slice(0, 8)} → ${targetAgent}`,
        );
        resumeInFlight.delete(sessionId);
        resumeInFlightStarted.delete(sessionId);
        conversationResumeFailures.delete(conversationId);
        // Interrupt the old backend for real. Dropping the live map (or the
        // persisted record) without a turn interrupt leaves a Codex
        // app-server thread running, and its output keeps landing on this
        // conversation (ct-51691).
        await teardownConversationBackendsLive(conversationId, {
          interruptActiveTurn: true,
        });
        restartingSessionIds.set(sessionId, Date.now());
        try {
          const cwd = projectPath
            ? await resolveResumeCwdOrRefuse({
                recordedCwd: projectPath,
                cwdOverride: projectPath,
                conversationId,
              })
            : null;
          if (!cwd) {
            await refuseResumeNoLocalCheckout(
              sessionId,
              conversationId,
              projectPath,
            );
            commandOutcome.error = "No local checkout for agent switch";
            break;
          }
          let switched = false;
          if (
            config?.convex_url &&
            config?.auth_token &&
            mayReconstituteResumeTranscript(targetAgent)
          ) {
            try {
              const siteUrl = config.convex_url.replace(".cloud", ".site");
              const exportData = await fetchExport(
                siteUrl,
                config.auth_token,
                conversationId,
              );
              if (hasResumableMessages(exportData)) {
                const tailMessages = chooseClaudeAutoTrim(exportData);
                let newSessionId: string;
                let reconFilePath: string;
                if (targetAgent === "grok") {
                  const files = generateGrokSession(exportData, {
                    tailMessages,
                    cwd,
                  });
                  ({ sessionId: newSessionId, filePath: reconFilePath } =
                    writeGrokSession(files));
                } else if (targetAgent === "pi") {
                  const pi = generatePiSession(exportData, {
                    tailMessages,
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
                } else if (targetAgent === "opencode") {
                  const sesId = await rebuildOpencodeSession(exportData, cwd);
                  if (!sesId)
                    throw new Error("opencode serve sidecar unavailable");
                  newSessionId = sesId;
                  reconFilePath = "";
                } else {
                  let reconJsonl: string;
                  ({ jsonl: reconJsonl, sessionId: newSessionId } =
                    generateClaudeCodeJsonl(exportData, {
                      tailMessages,
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
                rebindConversationSession(
                  sessionId,
                  newSessionId,
                  conversationId,
                  cwd,
                );
                const resumed = await autoResumeSession(
                  newSessionId,
                  "",
                  readTitleCache(),
                  cwd,
                  conversationId,
                  targetAgent,
                  resumeOptions,
                );
                if (resumed) {
                  const cache = readConversationCache();
                  cache[newSessionId] = conversationId;
                  saveConversationCache(cache);
                  daemon.syncServiceRef
                    ?.markSessionActive(conversationId)
                    .catch(logConvexFailure);
                  conversationResumeFailures.delete(conversationId);
                  await clearConversationDeliveryAndResumeState(
                    conversationId,
                    newSessionId,
                    "agent_switch",
                  );
                  commandOutcome.result = JSON.stringify({
                    switched: true,
                    session_id: newSessionId,
                    agent_type: targetAgent,
                  });
                  log(
                    `[REMOTE] Agent switch reconstituted ${sessionId.slice(0, 8)} → ${newSessionId.slice(0, 8)} (${targetAgent})`,
                  );
                  switched = true;
                }
              }
            } catch (switchErr) {
              log(
                `[REMOTE] Agent switch reconstitution failed: ${switchErr instanceof Error ? switchErr.message : String(switchErr)}`,
              );
            }
          }
          if (!switched) {
            commandOutcome.error = `Failed to switch session ${sessionId.slice(0, 8)} to ${targetAgent}`;
          }
        } finally {
          restartingSessionIds.delete(sessionId);
        }
        break;
      }
      // opencode API fork. The parent's real ses_ id rode down in
      // parsed.parent_session_id (forkFromMessage). The session_id here is the
      // synthetic forked-<id> placeholder — it can't resolve in opencode.db, so
      // we mint a REAL forked ses_ via the serve sidecar, rebind this conversation
      // onto it, and resume THAT. The convex copy (advanceForkCopy) already gave
      // the fork its history; the sidecar fork just makes it a live, resumable
      // opencode session. On any failure we log the reason and fall through to the
      // generic path (blank spawn) — never a silent claim that a fork happened.
      if (
        resumeAgentType === "opencode" &&
        parsed.fork_api === true &&
        conversationId &&
        typeof parsed.parent_session_id === "string" &&
        parsed.parent_session_id !== sessionId &&
        AGENT_CLIENTS.opencode.capabilities.forkApi === true
      ) {
        // Idempotency: the dispatch outbox is at-least-once, so a redelivered fork
        // command must not mint a SECOND fork. If this conversation is already
        // bound to a real ses_ id, the fork already happened — re-resume that id
        // (autoResumeSession no-ops on a live pane) instead of forking again.
        const reverseCache = buildReverseConversationCache(
          readConversationCache(),
        );
        const boundReal = reverseCache[conversationId];
        let realForkId: string | null =
          typeof boundReal === "string" && boundReal.startsWith("ses_")
            ? boundReal
            : null;

        if (!realForkId) {
          const sidecar = await ensureOpencodeServer(config);
          if (!sidecar) {
            log(
              `[REMOTE] opencode fork for conv ${conversationId.slice(0, 12)}: serve sidecar unavailable — falling back to blank spawn`,
            );
          } else {
            try {
              // fork_message_id (partial forks) truncates to match the convex copy;
              // omitted at tip = a full fork. See forkFromMessage.
              const forkMessageId =
                typeof parsed.fork_message_id === "string"
                  ? parsed.fork_message_id
                  : undefined;
              const forked = await sidecar.fork(
                parsed.parent_session_id,
                forkMessageId ? { messageID: forkMessageId } : {},
              );
              realForkId = forked.id;
              // Map real id → conversation BEFORE the watcher sees it (else it
              // mints a doppelgänger), point convex at the real id, and baseline
              // the watcher past the copied history (opencode re-mints message
              // ids on fork, so re-syncing would duplicate).
              const cache = readConversationCache();
              cache[realForkId] = conversationId;
              saveConversationCache(cache);
              if (daemon.conversationCacheRef)
                daemon.conversationCacheRef[realForkId] = conversationId;
              seedOpencodeForkSyncBaseline(realForkId);
              const forkGitInfo = projectPath
                ? await getGitInfo(projectPath)
                : undefined;
              void pushSessionIdBinding(
                conversationId,
                realForkId,
                projectPath || undefined,
                forkGitInfo?.repoRoot || forkGitInfo?.root,
                forkGitInfo?.remoteUrl,
              );
              log(
                `[REMOTE] opencode fork: ${parsed.parent_session_id.slice(0, 12)} → ${realForkId.slice(0, 12)} for conv ${conversationId.slice(0, 12)}`,
              );
            } catch (forkErr) {
              log(
                `[REMOTE] opencode fork failed for conv ${conversationId.slice(0, 12)}: ${forkErr instanceof Error ? forkErr.message : String(forkErr)} — falling back to blank spawn`,
              );
            }
          }
        }

        if (realForkId) {
          restartingSessionIds.set(realForkId, Date.now());
          const resumed = await autoResumeSession(
            realForkId,
            "",
            readTitleCache(),
            projectPath,
            conversationId,
            "opencode",
            resumeOptions,
          );
          restartingSessionIds.delete(realForkId);
          if (resumed) {
            daemon.syncServiceRef
              ?.markSessionActive(conversationId)
              .catch(logConvexFailure);
            conversationResumeFailures.delete(conversationId);
            await clearConversationDeliveryAndResumeState(
              conversationId,
              realForkId,
              "opencode_fork",
            );
            commandOutcome.result = JSON.stringify({
              forked: true,
              session_id: realForkId,
            });
            log(
              `[REMOTE] opencode fork ${realForkId.slice(0, 12)} resumed for conv ${conversationId.slice(0, 12)}`,
            );
          } else {
            commandOutcome.error = `opencode fork ${realForkId.slice(0, 12)} resume failed`;
          }
          break; // fork committed — do NOT also blank-spawn a second session
        }
        // No real fork id (sidecar unavailable or fork threw): fall through to the
        // generic path below, which blank-spawns opencode with the copied history.
      }
      // Fork fast path: materialize the new session's JSONL by copying the
      // parent's local transcript (byte-stable message content → Claude's
      // prompt cache stays warm), then let the normal resume pipeline take
      // it from there. Emitted by forkFromMessage the moment the fork is
      // created — the server-side message copy runs in parallel.
      if (
        parsed.fork_fast_path &&
        parsed.parent_session_id &&
        parsed.parent_session_id !== sessionId &&
        !findSessionFile(sessionId)
      ) {
        let copied = false;
        const parentFile = findSessionFile(parsed.parent_session_id);
        if (parentFile && parentFile.agentType === "claude") {
          try {
            const newPath = copyJsonlAsSession(
              parentFile.path,
              parsed.parent_session_id,
              sessionId,
            );
            if (newPath) {
              // The server copy populates the fork conversation; start the
              // watcher at EOF so the copied history isn't re-ingested.
              setPosition(newPath, fs.statSync(newPath).size);
              // Map session → conversation BEFORE the watcher can see the
              // file, or it mints a doppelgänger conversation for it.
              if (conversationId) {
                const cache = readConversationCache();
                cache[sessionId] = conversationId;
                saveConversationCache(cache);
                if (daemon.conversationCacheRef)
                  daemon.conversationCacheRef[sessionId] = conversationId;
              }
              copied = true;
              log(
                `[REMOTE] Fork fast path: copied parent JSONL ${parsed.parent_session_id.slice(0, 8)} → ${sessionId.slice(0, 8)}`,
              );
            }
          } catch (copyErr) {
            log(
              `[REMOTE] Fork fast path copy failed for ${sessionId.slice(0, 8)}: ${copyErr instanceof Error ? copyErr.message : String(copyErr)}`,
            );
          }
        }
        if (!copied && parsed.fork_fast_path_strict) {
          // Parent transcript isn't on this machine. Do NOT fall through to
          // reconstitution — the server-side message copy may still be in
          // flight and would rebuild a truncated history. The deferred
          // command emitted at copy completion handles this fork instead.
          log(
            `[REMOTE] Fork fast path unavailable for ${sessionId.slice(0, 8)} (no local parent transcript), deferring to post-copy resume`,
          );
          commandOutcome.result = JSON.stringify({
            skipped: true,
            reason: "fork_fast_path_unavailable",
          });
          break;
        }
      }
      restartingSessionIds.set(sessionId, Date.now());
      await resumeForks(
        daemon,
        commandOutcome,
        config,
        siteUrl,
        projectPath,
        reparented,
        conversationId,
        parsed,
        sessionId,
        resumeAgentType,
        forceReconstitute,
        resumeOptions,
      );
      break;
    }
  }
}
