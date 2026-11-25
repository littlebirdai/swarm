import { chooseClaudeBackend, sdkBackendRefusal } from "../claudeSdk/select.js";
import { type AgentClientId } from "@codecast/agent-clients/agentClients";
import { type StableLaunchPrefs } from "@codecast/snippets/stableContext";
import { type AgentDefinitionSpec } from "@codecast/agents/agentDefinitions";
import { CODEX_EFFORT_LEVELS } from "@codecast/agent-clients/modelOptions";
import * as path from "path";
import { markClaudeSessionLive } from "../ccLiveGate.js";
import { type WorktreeResult } from "../worktreeLegacy.js";
import { hasTmux } from "../tmux.js";
import { TMUX_SIZE_ARGS } from "../terminal/daemon-bridge.js";
import { recordStableContext } from "../stableContext.js";
import { claudeProjectDirName } from "../projectPathResolver.js";
import { codexPermissionsFromArgs } from "../launchCommand.js";
import { type Config } from "../config/types.js";
import type { CommandOutcome, DaemonCommandDeps } from "./dependencies.js";
import type { ModelOption } from "@codecast/agent-clients/modelOptions";

export async function launchSession(
  daemon: Pick<
    DaemonCommandDeps,
    | "activeConfig"
    | "buildCodexStableContext"
    | "carryLaunchPrompt"
    | "claudeSdkBackend"
    | "discoverAndLinkSession"
    | "ensureManagedSessionHeartbeat"
    | "getInitialManagedSessionId"
    | "log"
    | "logConvexFailure"
    | "readyCodexAppServer"
    | "registerAppServerConversation"
    | "registerManagedStartedSession"
    | "setTmuxSessionOption"
    | "stampCodexPaneAccount"
    | "startClaudeSdkSession"
    | "startCodexThreadThenRecordStableContext"
    | "startedSessionTmux"
    | "syncServiceRef"
    | "tmuxExec"
    | "touchHostActivity"
    | "turnClaims"
    | "typeIntoPane"
    | "waitingLaunchPrompt"
  >,
  commandOutcome: CommandOutcome,
  config: Config,
  binaryArgs: string[],
  agentType: AgentClientId,
  cwd: string,
  stablePrefs: StableLaunchPrefs,
  conversationId: string | undefined,
  requestedModelOpt: ModelOption | undefined,
  requestedEffort: string | undefined,
  worktreeResult: WorktreeResult | null,
  expectedSessionId: string | undefined,
  assignedClaudeSessionId: string | undefined,
  parsed: any,
  startSteps: { mark(name: string): void; summary(): string },
  binary: string,
  requestedDefinition: AgentDefinitionSpec | undefined,
  stableEnvVars: Record<string, string>,
  launchToken: string,
  requestedAccount: string | undefined,
  cmdText: string,
  tmuxSession: string,
  launchedAccount: string | undefined,
): Promise<void> {
  const {
    buildCodexStableContext,
    carryLaunchPrompt,
    discoverAndLinkSession,
    ensureManagedSessionHeartbeat,
    getInitialManagedSessionId,
    log,
    logConvexFailure,
    readyCodexAppServer,
    registerAppServerConversation,
    registerManagedStartedSession,
    setTmuxSessionOption,
    stampCodexPaneAccount,
    startClaudeSdkSession,
    startCodexThreadThenRecordStableContext,
    startedSessionTmux,
    tmuxExec,
    touchHostActivity,
    turnClaims,
    typeIntoPane,
    waitingLaunchPrompt,
  } = daemon;

  let codexThreadId: string | null = null;
  const codexPermissions = codexPermissionsFromArgs(binaryArgs);
  const codexApprovalPolicy = codexPermissions.approvalPolicy;
  const activeCodexAppServer =
    agentType === "codex"
      ? await readyCodexAppServer().catch((err) => {
          log(
            `[codex-app-server] login refresh before session start failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          return null;
        })
      : null;
  if (agentType === "codex" && activeCodexAppServer) {
    try {
      const sandbox = codexPermissions.sandbox;
      const builtContext = await buildCodexStableContext(
        config,
        cwd,
        stablePrefs,
        conversationId || undefined,
      );
      const resp = await startCodexThreadThenRecordStableContext(
        () =>
          activeCodexAppServer.threadStart({
            cwd,
            sandbox,
            approvalPolicy: codexApprovalPolicy,
            ...(builtContext
              ? { developerInstructions: builtContext.text }
              : {}),
            ...(requestedModelOpt?.cliAlias
              ? { model: requestedModelOpt.cliAlias }
              : {}),
            ...(requestedEffort &&
            (CODEX_EFFORT_LEVELS as readonly string[]).includes(requestedEffort)
              ? { config: { model_reasoning_effort: requestedEffort } }
              : {}),
          }),
        builtContext && conversationId
          ? () => {
              void recordStableContext(config, {
                conversation_id: conversationId,
                data: builtContext.data,
              });
            }
          : undefined,
      );
      codexThreadId = resp.thread.id;
      log(
        `[codex-app-server] pre-created thread ${codexThreadId.slice(0, 8)} (approvalPolicy=${codexApprovalPolicy})`,
      );
    } catch (err) {
      log(
        `[codex-app-server] thread pre-create failed, falling back: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (agentType === "codex" && codexThreadId) {
    const resultObj: Record<string, any> = {
      agent_type: agentType,
      project_path: cwd,
      app_server_thread_id: codexThreadId,
    };
    if (worktreeResult) {
      resultObj.worktree_name = worktreeResult.worktreeName;
      resultObj.worktree_branch = worktreeResult.worktreeBranch;
      resultObj.worktree_path = worktreeResult.worktreePath;
      resultObj.port_index = worktreeResult.portIndex;
    }
    commandOutcome.result = JSON.stringify(resultObj);
    log(
      `[REMOTE] Started ${agentType} session via app-server: ${codexThreadId.slice(0, 8)} (cwd: ${cwd})`,
    );
    if (conversationId) {
      const initialManagedSessionId = getInitialManagedSessionId(
        agentType,
        expectedSessionId,
        codexThreadId,
      );
      registerAppServerConversation(conversationId, codexThreadId, {
        cwd,
        approvalPolicy: codexApprovalPolicy,
        sandbox: codexPermissions.sandbox,
        persist: true,
      });
      // This device now owns and runs the session — claim it and clear any
      // stale "clone it first" error a different device may have left.
      daemon.syncServiceRef
        ?.claimSession(conversationId)
        .catch(logConvexFailure);
      if (initialManagedSessionId && daemon.syncServiceRef) {
        daemon.syncServiceRef
          .markSessionActive(conversationId)
          .catch(logConvexFailure);
        daemon.syncServiceRef
          .registerManagedSession(
            initialManagedSessionId,
            process.pid,
            undefined,
            conversationId,
          )
          .catch(logConvexFailure);
        daemon.syncServiceRef
          .updateSessionAgentStatus(conversationId, "connected")
          .catch(logConvexFailure);
        ensureManagedSessionHeartbeat(initialManagedSessionId);
      }
      log(
        `[codex-app-server] registered conv=${conversationId.slice(0, 12)} -> thread=${codexThreadId.slice(0, 8)}`,
      );
    }
    return;
  }

  // A Claude session on the SDK backend runs in a host process instead of
  // a pane. Everything above (cwd, worktree, launch argv, account, stable
  // context, launch token) is the same launch; only the transport differs.
  // A refusal or a host that does not come up starts the tmux session below.
  if (
    agentType === "claude" &&
    conversationId &&
    assignedClaudeSessionId &&
    daemon.claudeSdkBackend &&
    chooseClaudeBackend(
      parsed.backend,
      process.env,
      (daemon.activeConfig ?? config).claude_backend,
    ) === "sdk"
  ) {
    startSteps.mark("prep");
    const refusal = await sdkBackendRefusal(binary);
    startSteps.mark("version");
    if (refusal) {
      log(
        `[claude-sdk] ${conversationId.slice(0, 12)} starts in tmux: ${refusal}`,
        "warn",
      );
    } else {
      try {
        // A start replaces whatever host ran the conversation, on purpose.
        turnClaims().releaseConversation(conversationId);
        await startClaudeSdkSession({
          conversationId,
          sessionId: assignedClaudeSessionId,
          cwd,
          binary,
          binaryArgs,
          definition: requestedDefinition,
          portIndex: worktreeResult?.portIndex,
          stableEnvVars,
          launchToken,
          account: requestedAccount,
          steps: startSteps,
        });
        const resultObj: Record<string, any> = {
          sdk_session: assignedClaudeSessionId,
          agent_type: agentType,
          project_path: cwd,
        };
        if (worktreeResult) {
          resultObj.worktree_name = worktreeResult.worktreeName;
          resultObj.worktree_branch = worktreeResult.worktreeBranch;
          resultObj.worktree_path = worktreeResult.worktreePath;
          resultObj.port_index = worktreeResult.portIndex;
        }
        commandOutcome.result = JSON.stringify(resultObj);
        startSteps.mark("host");
        log(
          `[REMOTE] Started claude session ${assignedClaudeSessionId.slice(0, 8)} on the SDK backend (cwd: ${cwd}) [START-TIMING] ${startSteps.summary()}`,
        );
        touchHostActivity();
        return;
      } catch (err) {
        log(
          `[claude-sdk] host for ${conversationId.slice(0, 12)} did not start, starting tmux instead: ${err instanceof Error ? err.message : String(err)}`,
          "warn",
        );
        turnClaims().releaseConversation(conversationId);
        await daemon.claudeSdkBackend
          .stop(conversationId, { forget: true })
          .catch(() => {});
      }
    }
  }

  if (!hasTmux()) {
    commandOutcome.error = "tmux is not installed";
    return;
  }

  // A message already waiting for this conversation (a spawn's brief)
  // rides the launch command as claude's prompt argument. Pasted into
  // the composer it would reach the model wrapped as third party text,
  // which a fresh worker may decline to act on (launchPrompt.ts).
  const launchPrompt =
    agentType === "claude" && conversationId
      ? await waitingLaunchPrompt(conversationId)
      : null;
  if (launchPrompt) cmdText += launchPrompt.fragment;

  try {
    // Kill-before-create makes start_session idempotent: clicking the folder
    // switcher repeatedly just keeps respawning into the latest cwd.
    if (conversationId) {
      // Belt-and-suspenders: also kill an untracked tmux that happens to use
      // this agent's deterministic name. The teardown above already handled
      // the tracked backend, started-session registry, and delivery state.
      try {
        await tmuxExec(["kill-session", "-t", tmuxSession]);
      } catch {}
    }
    await tmuxExec(
      ["new-session", "-d", ...TMUX_SIZE_ARGS, "-s", tmuxSession, "-c", cwd],
      { timeout: 5000 },
    );
    // Tag the tmux so warm-restart can rebuild startedSessionTmux from `tmux ls`.
    if (conversationId) {
      await setTmuxSessionOption(
        tmuxSession,
        "@codecast_conversation_id",
        conversationId,
      ).catch(() => {});
    }
    await setTmuxSessionOption(
      tmuxSession,
      "@codecast_agent_type",
      agentType,
    ).catch(() => {});
    await setTmuxSessionOption(
      tmuxSession,
      "@codecast_project_path",
      cwd,
    ).catch(() => {});
    if (agentType === "claude") {
      // The OAuth refresh gate: this pane holds the machine's active
      // credential unless it was pinned to a dormant profile's store. The
      // stamp carries the same account name accountSourcePrefix exports as
      // CODECAST_CC_ACCOUNT, so the gate survives a daemon restart even for
      // panes started by an older build (ct-49526).
      if (launchedAccount) {
        await setTmuxSessionOption(
          tmuxSession,
          "@codecast_cc_account",
          launchedAccount,
        ).catch(() => {});
      }
      markClaudeSessionLive(tmuxSession, launchedAccount);
    }
    await stampCodexPaneAccount(agentType, tmuxSession, conversationId);
    if (launchPrompt && conversationId && assignedClaudeSessionId) {
      carryLaunchPrompt(
        launchPrompt.messageId,
        {
          conversationId,
          tmuxSession,
          projectPath: cwd,
          sessionId: assignedClaudeSessionId,
          transcript: path.join(
            process.env.HOME || "",
            ".claude",
            "projects",
            claudeProjectDirName(cwd),
            `${assignedClaudeSessionId}.jsonl`,
          ),
        },
        launchPrompt.text,
      );
    }
    await typeIntoPane(tmuxSession, cmdText);
    const resultObj: Record<string, any> = {
      tmux_session: tmuxSession,
      agent_type: agentType,
      project_path: cwd,
    };
    if (worktreeResult) {
      resultObj.worktree_name = worktreeResult.worktreeName;
      resultObj.worktree_branch = worktreeResult.worktreeBranch;
      resultObj.worktree_path = worktreeResult.worktreePath;
      resultObj.port_index = worktreeResult.portIndex;
    }
    commandOutcome.result = JSON.stringify(resultObj);
    log(
      `[REMOTE] Started ${agentType} session in tmux: ${tmuxSession} (cwd: ${cwd})`,
    );
    touchHostActivity();
    if (conversationId) {
      const initialManagedSessionId =
        assignedClaudeSessionId ??
        getInitialManagedSessionId(agentType, expectedSessionId);
      startedSessionTmux.set(conversationId, {
        tmuxSession,
        projectPath: cwd,
        startedAt: Date.now(),
        agentType,
        sessionId: initialManagedSessionId,
        worktreeName: worktreeResult?.worktreeName,
        worktreeBranch: worktreeResult?.worktreeBranch,
        worktreePath: worktreeResult?.worktreePath,
      });
      log(
        `[REMOTE] Registered started session tmux for conversation ${conversationId.slice(0, 12)}`,
      );
      // This device now owns and runs the session — claim it and clear any
      // stale "clone it first" error a different device may have left.
      daemon.syncServiceRef
        ?.claimSession(conversationId)
        .catch(logConvexFailure);
      if (initialManagedSessionId) {
        registerManagedStartedSession(
          conversationId,
          initialManagedSessionId,
          tmuxSession,
        );
      }
      if (agentType === "claude") {
        // `--session-id <uuid>` makes the JSONL deterministically named and
        // ensures it lands in THIS conversation's tmux, so discovery
        // tmux-exact-matches it (no cwd-fallback hijack) and the server's
        // session_id already equals the uuid (no mismatch/overwrite). We do
        // NOT pre-register conversationCache here: that would let
        // deliverMessage resolve sessionId immediately and skip the
        // readiness-gated started-tmux path, injecting the first message
        // into a still-booting prompt. Let discovery/the watcher link it.
        discoverAndLinkSession(conversationId, tmuxSession, cwd).catch(
          (err) => {
            log(
              `Session discovery failed for ${conversationId.slice(0, 12)}: ${err}`,
            );
          },
        );
      }
    }
  } catch (spawnErr) {
    commandOutcome.error = `Failed to start session: ${spawnErr instanceof Error ? spawnErr.message : String(spawnErr)}`;
    log(`[REMOTE] start_session error: ${commandOutcome.error}`);
  }
  return;
}
