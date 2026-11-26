import { type AgentClientId } from "@codecast/agent-clients/agentClients";
import { CODEX_EFFORT_LEVELS } from "@codecast/agent-clients/modelOptions";
import * as fs from "fs";
import { randomUUID } from "node:crypto";
import { threadForkTimeoutMsForBytes } from "../codex-app-server.js";
import { setPosition } from "../positionTracker.js";
import {
  fetchExport,
  generateCodexJsonl,
  writeCodexSession,
} from "../jsonlGenerator.js";
import { type Config } from "../config/types.js";
import type {
  CommandOutcome,
  DaemonCommandDeps,
  ReparentedCheckout,
  ResumeOptions,
} from "./dependencies.js";
import { resumeFallback } from "./resume-fallback.js";

export async function resumeForks(
  daemon: Pick<
    DaemonCommandDeps,
    | "autoResumeSession"
    | "blankLaunchAccount"
    | "buildBlankLaunchArgs"
    | "clearConversationDeliveryAndResumeState"
    | "conversationCacheRef"
    | "conversationResumeFailures"
    | "discoverAndLinkSession"
    | "ensureManagedSessionHeartbeat"
    | "ensureReparentedCheckout"
    | "findSessionFile"
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
    | "resumeOrRepair"
    | "sanitizeBinaryArgs"
    | "saveConversationCache"
    | "sendReparentNotice"
    | "setTmuxSessionOption"
    | "stampCodexPaneAccount"
    | "startedSessionGuard"
    | "startedSessionTmux"
    | "stopManagedSessionHeartbeat"
    | "syncServiceRef"
    | "tmuxExec"
    | "typeIntoPane"
    | "writeRebuiltDeltaTranscript"
  >,
  commandOutcome: CommandOutcome,
  config: Config,
  siteUrl: string,
  projectPath: any,
  reparented: boolean,
  conversationId: any,
  parsed: any,
  sessionId: any,
  resumeAgentType: AgentClientId | undefined,
  forceReconstitute: boolean,
  resumeOptions: ResumeOptions,
): Promise<void> {
  const {
    clearConversationDeliveryAndResumeState,
    conversationResumeFailures,
    ensureManagedSessionHeartbeat,
    ensureReparentedCheckout,
    getGitInfo,
    log,
    logConvexFailure,
    logError,
    pendingAppServerForkParents,
    pushSessionIdBinding,
    readyCodexAppServer,
    refuseResumeNoLocalCheckout,
    registerAppServerConversation,
    remapConversationSession,
    resolveCodexPermissionDefaults,
    resolveResumeCwdOrRefuse,
    restartingSessionIds,
    stopManagedSessionHeartbeat,
  } = daemon;

  // Reparented onto this machine: ensure the repo is checked out locally
  // (clone if missing) BEFORE resolving the resume cwd, so the resume and
  // its reconstruct-from-Convex JSONL write have a real directory. If no
  // checkout can be prepared, fall through — the normal resolution then
  // surfaces the "clone it first" banner as usual.
  // Where the session ran before this machine — captured before the
  // reparent checkout repoints projectPath, so the notice can name it.
  const priorCwd = projectPath;
  let pendingForkParentId: string | undefined;
  let reparentCheckout: ReparentedCheckout | undefined;
  if (reparented) {
    reparentCheckout = await ensureReparentedCheckout(
      conversationId,
      projectPath,
      parsed.git_remote_url,
    );
    if (reparentCheckout) {
      projectPath = reparentCheckout.path;
      log(
        `[REPARENT] ${sessionId.slice(0, 8)} resuming in ${reparentCheckout.cloned ? "fresh clone" : "existing checkout"} ${reparentCheckout.path}${reparentCheckout.branch ? ` on branch ${reparentCheckout.branch}` : ""}`,
      );
    }
  }
  if (
    resumeAgentType === "codex" &&
    (parsed.fork === true || forceReconstitute) &&
    conversationId
  ) {
    let forkTimeoutMs = 0;
    let forkFailed = false;
    try {
      const activeCodexAppServer = await readyCodexAppServer();
      if (!activeCodexAppServer) {
        throw new Error(
          "Codex app-server is unavailable; cannot import fork history",
        );
      }
      const exportData = await fetchExport(
        siteUrl,
        config.auth_token!,
        conversationId,
      );
      const recordedCwd =
        projectPath ||
        exportData.conversation.project_path ||
        exportData.conversation.git_root ||
        undefined;
      const cwd = await resolveResumeCwdOrRefuse({
        recordedCwd,
        cwdOverride: recordedCwd,
        conversationId,
      });
      if (!cwd) {
        await refuseResumeNoLocalCheckout(
          sessionId,
          conversationId,
          recordedCwd || "unknown project",
        );
        commandOutcome.result = JSON.stringify({
          forked: false,
          reason: "no_local_checkout",
        });
        return;
      }
      const { jsonl, sessionId: importSessionId } = generateCodexJsonl(
        exportData,
        { sessionId: randomUUID(), cwd },
      );
      const { filePath: importPath } = writeCodexSession(
        jsonl,
        importSessionId,
        "codecast-fork",
      );
      const importBytes = fs.statSync(importPath).size;
      setPosition(importPath, importBytes);
      const { approvalPolicy, sandbox } =
        resolveCodexPermissionDefaults(config);
      pendingAppServerForkParents.add(importSessionId);
      pendingForkParentId = importSessionId;
      forkTimeoutMs = threadForkTimeoutMsForBytes(importBytes);
      if (forkTimeoutMs > 60_000) {
        log(
          `[REMOTE] Codex history import is ${Math.ceil(importBytes / (1024 * 1024))} MiB; allowing ${Math.round(forkTimeoutMs / 1000)}s for thread/fork`,
        );
      }
      const forked = await activeCodexAppServer.threadFork(
        {
          threadId: "",
          path: importPath,
          cwd,
          ...(resumeOptions.model && resumeOptions.model !== "default"
            ? { model: resumeOptions.model }
            : {}),
          ...(resumeOptions.effort &&
          (CODEX_EFFORT_LEVELS as readonly string[]).includes(
            resumeOptions.effort,
          )
            ? { config: { model_reasoning_effort: resumeOptions.effort } }
            : {}),
          approvalPolicy,
          sandbox,
        },
        forkTimeoutMs,
      );
      const realThreadId = forked.thread.id;
      remapConversationSession(sessionId, realThreadId, conversationId);
      registerAppServerConversation(conversationId, realThreadId, {
        cwd,
        persist: true,
        approvalPolicy,
        sandbox,
      });
      if (forked.thread.path && fs.existsSync(forked.thread.path)) {
        setPosition(forked.thread.path, fs.statSync(forked.thread.path).size);
      }
      const forkGitInfo = await getGitInfo(cwd);
      await pushSessionIdBinding(
        conversationId,
        realThreadId,
        cwd,
        forkGitInfo?.repoRoot || forkGitInfo?.root,
        forkGitInfo?.remoteUrl,
      );
      daemon.syncServiceRef
        ?.claimSession(conversationId)
        .catch(logConvexFailure);
      daemon.syncServiceRef
        ?.markSessionActive(conversationId)
        .catch(logConvexFailure);
      daemon.syncServiceRef
        ?.registerManagedSession(
          realThreadId,
          process.pid,
          undefined,
          conversationId,
        )
        .catch(logConvexFailure);
      daemon.syncServiceRef
        ?.updateSessionAgentStatus(conversationId, "connected")
        .catch(logConvexFailure);
      ensureManagedSessionHeartbeat(realThreadId);
      conversationResumeFailures.delete(conversationId);
      const switchingAgent = parsed.switch_agent === true;
      await clearConversationDeliveryAndResumeState(
        conversationId,
        sessionId,
        switchingAgent ? "codex_app_server_switch" : "codex_app_server_fork",
      );
      commandOutcome.result = JSON.stringify({
        ...(switchingAgent ? { switched: true } : { forked: true }),
        session_id: realThreadId,
        transport: "app-server",
      });
      log(
        `[REMOTE] Codex ${switchingAgent ? "switch" : "fork"} ${sessionId.slice(0, 8)} imported as app-server thread ${realThreadId.slice(0, 8)} for conv ${conversationId.slice(0, 12)}`,
      );
    } catch (forkErr) {
      const message =
        forkErr instanceof Error ? forkErr.message : String(forkErr);
      logError(
        `[REMOTE] Codex app-server fork import failed for ${sessionId.slice(0, 8)}`,
        forkErr instanceof Error ? forkErr : new Error(message),
      );
      commandOutcome.error = `Codex history import failed: ${message}`;
      forkFailed = true;
      stopManagedSessionHeartbeat(sessionId);
      await daemon.syncServiceRef
        ?.unregisterManagedSession(sessionId)
        .catch(logConvexFailure);
      await daemon.syncServiceRef
        ?.setSessionError(conversationId, commandOutcome.error)
        .catch(logConvexFailure);
    } finally {
      if (pendingForkParentId) {
        // A fork that timed out on our side is usually still running in the
        // app-server, which keeps writing the replayed history into the new
        // rollout after we gave up. Keep the parent guarded for one more
        // timeout window so the watcher pins that rollout at EOF instead of
        // ingesting the replay as new messages (jx7652s, 2026-09-04).
        const releasedParentId = pendingForkParentId;
        if (forkFailed && forkTimeoutMs > 0) {
          setTimeout(
            () => pendingAppServerForkParents.delete(releasedParentId),
            forkTimeoutMs,
          ).unref();
        } else {
          pendingAppServerForkParents.delete(releasedParentId);
        }
      }
      restartingSessionIds.delete(sessionId);
    }
    return;
  }
  await resumeFallback(
    daemon,
    commandOutcome,
    config,
    parsed,
    conversationId,
    resumeAgentType,
    sessionId,
    projectPath,
    resumeOptions,
    forceReconstitute,
    reparented,
    reparentCheckout,
    priorCwd,
  );
}
