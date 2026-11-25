import { stepTimer } from "../stepTimer.js";
import {
  isHostedAgentType,
  type AgentClientId,
  fromConvexAgentType,
  findModelOption,
  modelOptionKey,
} from "@codecast/agent-clients/agentClients";
import {
  type StableLaunchPrefs,
  STABLE_ENV_MODE,
  STABLE_ENV_EXCLUDE,
  STABLE_ENV_CONVERSATION_ID,
} from "@codecast/snippets/stableContext";
import { type AgentDefinitionSpec } from "@codecast/agents/agentDefinitions";
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "node:crypto";
import { execSync } from "../proc.js";
import { isRemoteDevice, deviceId } from "../remote/device.js";
import {
  cloneDestination,
  creatableStartFolder,
  noLocalCheckoutBannerActionable,
  noLocalCheckoutError,
  missingFolderError,
  excludedFolderStartError,
} from "../resumePlacement.js";
import { hostAgentSocketEnv } from "../cloud/agentBridge.js";
import { worktreeEnvPrefix } from "../worktreeEnv.js";
import { launchAccountPrefix } from "../ccAccounts.js";
import { shellEscapeForSh } from "../supervision.js";
import { launchTokenEnv, agentEnvScrub, AGENT_ENV_SCRUB } from "../agentEnv.js";
import { launchTokenLedger } from "../launchToken.js";
import { diskFullFailReason } from "../diskFull.js";
import { type WorktreeResult } from "../worktreeLegacy.js";
import { ensureGrokFolderTrusted } from "../grokFolderTrust.js";
import { launchScopeRefusal, markLaunched } from "../syncScope.js";
import {
  prepareLaunchStableContext,
  refreshStableCache,
  ensureStableHookForLaunch,
} from "../stableContext.js";
import { CLAUDE_UUID_RE, grokStableRulesFragment } from "../resumeCommand.js";
import {
  resolveLocalProjectPath,
  conventionSeed,
} from "../projectPathResolver.js";
import {
  launchBinary,
  buildLaunchArgs,
  getConfiguredAgentArgs,
  getPermissionFlags,
  getDefaultParamFlags,
} from "../launchCommand.js";
import { type Config } from "../config/types.js";
import { providerKeySourcePrefix } from "../providerKeyLaunch.js";
import type { CommandOutcome, DaemonCommandDeps } from "./dependencies.js";
import { launchSession } from "./launch-session.js";

export async function handleStartSessionCommand(
  daemon: Pick<
    DaemonCommandDeps,
    | "CONFIG_DIR"
    | "activeConfig"
    | "applyServerSyncSettings"
    | "buildCodexStableContext"
    | "carryLaunchPrompt"
    | "claudeSdkBackend"
    | "clearConversationDeliveryAndResumeState"
    | "cloneCheckout"
    | "cloudAgents"
    | "codexAppServerInstance"
    | "createWorktree"
    | "disclaimPrefix"
    | "discoverAndLinkSession"
    | "ensureManagedSessionHeartbeat"
    | "fetchFolderFromPeers"
    | "getInitialManagedSessionId"
    | "log"
    | "logConvexFailure"
    | "readyCodexAppServer"
    | "recordProjectMapping"
    | "registerAppServerConversation"
    | "registerManagedStartedSession"
    | "resolveLocalRepo"
    | "sanitizeBinaryArgs"
    | "setTmuxSessionOption"
    | "stableLaunchOptions"
    | "stampCodexPaneAccount"
    | "startClaudeSdkSession"
    | "startCodexThreadThenRecordStableContext"
    | "startedSessionTmux"
    | "syncServiceRef"
    | "teardownConversationBackendsLive"
    | "tmuxExec"
    | "touchHostActivity"
    | "turnClaims"
    | "typeIntoPane"
    | "validatePath"
    | "waitingLaunchPrompt"
    | "writeGrokStableRulesFile"
  >,
  commandOutcome: CommandOutcome,
  command: string,
  config: Config,
  commandArgs: string | undefined,
): Promise<void> {
  const {
    CONFIG_DIR,
    applyServerSyncSettings,
    clearConversationDeliveryAndResumeState,
    cloneCheckout,
    cloudAgents,
    createWorktree,
    disclaimPrefix,
    fetchFolderFromPeers,
    log,
    recordProjectMapping,
    resolveLocalRepo,
    sanitizeBinaryArgs,
    stableLaunchOptions,
    teardownConversationBackendsLive,
    validatePath,
    writeGrokStableRulesFile,
  } = daemon;
  switch (command) {
    case "start_session": {
      const parsed = commandArgs ? JSON.parse(commandArgs) : {};
      const startSteps = stepTimer();
      // A hosted conversation runs in codecast's backend; no machine starts it.
      if (isHostedAgentType(parsed.agent_type)) {
        commandOutcome.error = "hosted conversation: no machine starts it";
        break;
      }
      const rawAgentType = parsed.agent_type;
      // Registry-driven normalization (accepts either the convex spelling or the
      // client id; unknown/claude → "claude"). Replaces a hand-rolled ternary that
      // silently downgraded any client it didn't enumerate (e.g. opencode) to claude.
      const agentType: AgentClientId = fromConvexAgentType(rawAgentType);
      const rawPath: string = parsed.project_path || process.env.HOME || "/tmp";
      const conversationId: string | undefined = parsed.conversation_id;
      const expectedSessionId: string | undefined = parsed.session_id;
      const isolated: boolean = parsed.isolated === true;
      const worktreeName: string | undefined = parsed.worktree_name;
      // Per-session launch overrides from the web picker (shared-contract
      // option key + effort level). Unknown values are dropped here, never
      // passed through to the CLI.
      const requestedModelKey: string | undefined =
        typeof parsed.model === "string" ? parsed.model : undefined;
      const requestedEffort: string | undefined =
        typeof parsed.effort === "string" ? parsed.effort : undefined;
      // `cast spawn --as`: the resolved definition rides the payload; its tool
      // policy and prompt are applied after the argv allowlist (see below).
      const requestedDefinition: AgentDefinitionSpec | undefined =
        parsed.definition &&
        typeof parsed.definition === "object" &&
        typeof parsed.definition.name === "string"
          ? parsed.definition
          : undefined;
      // Per-session Claude account: a saved profile whose credential store is
      // exported into this launch's env, so the session runs on that account
      // while the keychain login (and every other session) stays put.
      // Validated by name shape here; a profile with no launch credential is
      // logged and the launch falls back to the keychain (accountSourcePrefix).
      // No account asked for = the launch profile when a token switch set
      // one (the fleet runs there, not on the keychain), else the keychain.
      const requestedAccount: string | undefined =
        agentType === "claude"
          ? typeof parsed.cc_account === "string" &&
            /^[a-z0-9][a-z0-9._-]{0,40}$/i.test(parsed.cc_account)
            ? parsed.cc_account
            : undefined
          : undefined;
      // Per-session stable-context prefs from the new-session page. Same
      // ride-along contract as model/effort: unknown values dropped here.
      const stablePrefs: StableLaunchPrefs = {
        ...(parsed.stable_mode === "team" ||
        parsed.stable_mode === "solo" ||
        parsed.stable_mode === "off"
          ? { stable_mode: parsed.stable_mode }
          : {}),
        ...(Array.isArray(parsed.stable_exclude)
          ? {
              stable_exclude: parsed.stable_exclude.filter(
                (x: unknown): x is string =>
                  typeof x === "string" && /^[a-z0-9-]+$/i.test(x),
              ),
            }
          : {}),
      };

      // A blank-project start (quick-create) defaults to $HOME — fine on the
      // user's own Mac, wrong on a remote box (the session would mislabel as
      // /Users/<remote-user> and run outside any checkout). The local fleet
      // serves these; a remote only runs starts that name a real project.
      if (!parsed.project_path && isRemoteDevice()) {
        log(
          `[REMOTE] start_session: blank project on a remote device — staying silent`,
        );
        break;
      }

      // A conversation on the fenced execution rail (or quiescing onto it)
      // gets its runtime exclusively from the execution coordinator. This
      // legacy channel spawning one anyway would be a second, unmanaged
      // runtime beside the coordinator's binding — the split-brain the fence
      // exists to prevent. The gate re-checks at delivery time because a
      // start_session enqueued BEFORE the fence transition can arrive after.
      if (conversationId && daemon.syncServiceRef) {
        const protocolState = (
          await daemon.syncServiceRef
            .getProjectInfo(conversationId)
            .catch(() => null)
        )?.execution_protocol_state;
        startSteps.mark("projectInfo");
        if (protocolState) {
          log(
            `start_session refused: conversation ${conversationId} is ${protocolState} — runtime is coordinator-owned`,
          );
          break;
        }
      }

      // A cloud agent choice (a provider's cloud model key) runs on the
      // provider's machines, not in a pane here: record it, and the first
      // delivered message creates the agent.
      const cloudStart = conversationId
        ? await cloudAgents.start(
            agentType,
            conversationId,
            parsed.project_path,
            requestedModelKey,
            parsed.prompt,
          )
        : null;
      startSteps.mark("cloud");
      if (cloudStart) {
        if (cloudStart.error) commandOutcome.error = cloudStart.error;
        break;
      }

      const shortId = Math.random().toString(36).slice(2, 8);
      // Deterministic name keyed by conversation_id so kill/restart is a single
      // `tmux kill-session -t cc-<agent>-<convId>` with no lookup tables involved.
      const convSuffix = conversationId ? conversationId.slice(-12) : shortId;
      const tmuxSession = `cc-${agentType}-${convSuffix}`;

      // Assign claude's session id up front. `claude --session-id <uuid>` writes
      // its transcript to <uuid>.jsonl, so the daemon knows the JSONL path before
      // the process starts — no filesystem/process discovery, no cwd-based
      // matching, no hijack races. Reuse a caller-supplied id only if it's a real
      // UUID (the conversation_id is not), otherwise mint one.
      const assignedClaudeSessionId =
        agentType === "claude"
          ? expectedSessionId && CLAUDE_UUID_RE.test(expectedSessionId)
            ? expectedSessionId
            : randomUUID()
          : undefined;

      // Resolve a usable local cwd. If `rawPath` doesn't exist on this
      // machine (conversation came from another host or was forked from
      // someone else's session), look up a local checkout for the same
      // git_remote_url. Refuse to start the session if no local checkout
      // exists — silently falling back to $HOME hides the problem and
      // makes the user's messages land in a totally wrong agent context.
      let cwd: string;
      const validatedRaw = validatePath(rawPath);
      if (validatedRaw) {
        cwd = validatedRaw;
      } else if (conversationId && daemon.syncServiceRef) {
        const projectInfo = await daemon.syncServiceRef
          .getProjectInfo(conversationId)
          .catch(() => null);
        const recordedRoot = projectInfo?.git_root ?? null;
        let resolved = await resolveLocalProjectPath({
          projectPath: projectInfo?.project_path ?? rawPath,
          gitRoot: recordedRoot,
          gitRemoteUrl: projectInfo?.git_remote_url ?? null,
          findCandidates: (url) =>
            daemon.syncServiceRef!.findLocalCheckouts(url).catch(() => []),
        });
        // Fallback mirroring the resume path (resolveResumeCwd): when the
        // git-remote lookup can't place the session — no remote recorded, or
        // the remote string differs across machines (SSH vs HTTPS) so the
        // exact-match candidate query misses — fall back to the
        // user/learned/convention resolver. Key it on the REPO ROOT so its
        // basename is the repo name (not a leaf subdir like "outreach"), then
        // re-append the in-repo subpath. start_session lacked this step, so a
        // foreign recorded path that resume could repair still refused here.
        if (!resolved) {
          // Seed with the recorded git_root only when rawPath lives under it
          // (conventionSeed): a root stamped off an unrelated conversation
          // that exists locally would otherwise win verbatim and launch the
          // session in the wrong repo.
          const rootSeed = conventionSeed(rawPath, recordedRoot);
          const localRepoRoot = resolveLocalRepo(rootSeed);
          if (localRepoRoot) {
            const subpath =
              rootSeed !== rawPath ? rawPath.slice(rootSeed.length) : "";
            const full = subpath
              ? path.join(localRepoRoot, subpath)
              : localRepoRoot;
            const placed = validatePath(full) ?? localRepoRoot;
            resolved = {
              path: placed,
              remapped: true,
              reason: `convention-resolved ${rawPath} → ${placed}`,
            };
          }
        }
        if (!resolved) {
          // Don't clobber a session another device already owns. With device
          // routing this daemon shouldn't even receive a start_session it can't
          // run, but if it does (untargeted broadcast fallback), the machine
          // that actually has the checkout wins — we stay silent rather than
          // stamping a bogus "clone it first" banner over a live session.
          const owner = await daemon.syncServiceRef
            .getConversationOwner(conversationId)
            .catch(() => null);
          if (owner && owner !== deviceId()) {
            log(
              `[REMOTE] start_session: no local checkout, but ${String(conversationId).slice(0, 12)} is owned by ${owner.slice(0, 8)} — staying silent`,
            );
            break;
          }
          // The repo is the person's, and this is one of their machines:
          // bring the checkout here rather than refuse. Clone it to the same
          // place under home it holds on the machine the session was started
          // for, else take the folder from another of their machines.
          const clone = cloneDestination(
            rawPath,
            projectInfo,
            process.env.HOME,
          );
          if (
            clone &&
            projectInfo?.git_remote_url &&
            (await cloneCheckout(
              projectInfo.git_remote_url,
              clone.root,
              "[START]",
            ))
          ) {
            recordProjectMapping(path.basename(clone.root), clone.root);
            const placed = validatePath(clone.cwd) ?? clone.root;
            resolved = {
              path: placed,
              remapped: true,
              reason: `cloned ${projectInfo.git_remote_url} → ${clone.root}`,
            };
          }
          if (!resolved) {
            const fetched = await fetchFolderFromPeers(conversationId, rawPath);
            if (fetched)
              resolved = {
                path: fetched,
                remapped: true,
                reason: `fetched ${rawPath} from another machine → ${fetched}`,
              };
          }
          const creatable = resolved
            ? null
            : creatableStartFolder(rawPath, process.env.HOME, projectInfo);
          if (creatable) {
            try {
              fs.mkdirSync(creatable, { recursive: true });
              resolved = {
                path: creatable,
                remapped: false,
                reason: `created ${creatable}`,
              };
              log(`[REMOTE] start_session created folder ${creatable}`);
            } catch (err) {
              log(
                `[REMOTE] start_session could not create ${creatable}: ${err instanceof Error ? err.message : err}`,
              );
            }
          }
        }
        if (!resolved) {
          const remote = projectInfo?.git_remote_url ?? null;
          // Unlike a background resume, a start always has a person waiting on
          // its first message, so it never refuses in silence: with nothing to
          // clone, the banner names the folder this machine lacks.
          commandOutcome.error = noLocalCheckoutBannerActionable({
            remote,
            recordedPath: rawPath,
          })
            ? noLocalCheckoutError(remote, rawPath)
            : missingFolderError(rawPath);
          log(`[REMOTE] start_session refused: ${commandOutcome.error}`);
          daemon.syncServiceRef
            .setSessionError(conversationId, commandOutcome.error)
            .catch(() => {});
          break;
        }
        cwd = resolved.path;
        if (resolved.remapped) {
          log(`[REMOTE] start_session remapped path: ${resolved.reason}`);
        }
      } else {
        commandOutcome.error = `Project path ${rawPath} doesn't exist`;
        log(`[REMOTE] start_session refused: ${commandOutcome.error}`);
        break;
      }

      // Atomic pre-spawn claim: this daemon has resolved a runnable cwd, so now
      // race for ownership BEFORE spawning. Targeted commands already own the
      // conversation (no-op win). For a broadcast start_session (target couldn't
      // be resolved → every daemon with the checkout reaches here), Convex
      // serializes the claim so exactly one daemon wins; the losers skip,
      // preventing a double-spawn across machines.
      if (conversationId && daemon.syncServiceRef) {
        startSteps.mark("cwd");
        // The session's SessionStart hook renders its stable context from the
        // cache with no network wait; read it now so this session's own org
        // read and a fresh feed are there by the time the hook runs.
        const stableOpts = stableLaunchOptions(
          daemon.activeConfig ?? config,
          cwd,
          stablePrefs,
          conversationId,
        );
        if (stableOpts) {
          void (
            agentType === "claude"
              ? prepareLaunchStableContext(daemon.activeConfig ?? config, {
                  ...stableOpts,
                  session: conversationId,
                })
              : refreshStableCache(daemon.activeConfig ?? config, stableOpts)
          ).catch(() => {});
        }
        const claim =
          await daemon.syncServiceRef.claimConversationForStart(conversationId);
        startSteps.mark("claim");
        if (!claim.won) {
          log(
            `[REMOTE] start_session: ${String(conversationId).slice(0, 12)} owned by ${claim.owner?.slice(0, 8) ?? "another live device"} — skipping spawn`,
          );
          break;
        }
        // A launch is the person's choice to see this session in codecast, so
        // its transcript syncs even outside their selected folders. A folder
        // they excluded outright never uploads: say so on the session rather
        // than run an agent whose replies would never arrive.
        let scopeRefusal = launchScopeRefusal(
          cwd,
          daemon.activeConfig ?? config,
        );
        // The folder may have been synced moments ago (the banner's Sync
        // folder): read the person's lists fresh before refusing on them.
        if (scopeRefusal && !scopeRefusal.startsWith("excluded path")) {
          const fresh = await daemon.syncServiceRef
            .getSyncSettings()
            .catch(() => null);
          if (fresh) {
            applyServerSyncSettings(fresh);
            scopeRefusal = launchScopeRefusal(
              cwd,
              daemon.activeConfig ?? config,
            );
          }
        }
        if (scopeRefusal) {
          commandOutcome.error = excludedFolderStartError(
            cwd,
            scopeRefusal.startsWith("excluded path"),
          );
          log(`[REMOTE] start_session refused: ${scopeRefusal}`);
          daemon.syncServiceRef
            .setSessionError(conversationId, commandOutcome.error)
            .catch(() => {});
          break;
        }
        markLaunched({ conversationId, sessionId: assignedClaudeSessionId });
      }

      // One backend per conversation. A cross-agent reconfigure (Codex<->Claude)
      // or a same-agent restart enqueues a fresh start_session; tear down whatever
      // backend is currently bound BEFORE spawning so the prior agent's app-server
      // thread or tmux can't keep answering in parallel (the split-brain that
      // strands the first user turn and orphans a welcome-screen pane). This is
      // agent-agnostic, so it also clears stale delivery/resume state for the
      // Codex path, which previously only the tmux path did.
      if (conversationId) {
        const torn = await teardownConversationBackendsLive(conversationId, {
          interruptActiveTurn: true,
        });
        startSteps.mark("teardown");
        // Reset delivery/resume state only when a live backend was actually
        // torn down (a real reconfigure/restart). A brand-new conversation
        // (cast spawn) has nothing to tear down, and its FIRST message is
        // typically already in flight waiting for this very start_session to
        // register the tmux — wiping the in-flight/dedup state here let the
        // subscription re-process that message and inject the briefing twice
        // (ct-40212 incident, msg ns74720h).
        if (torn.killedAppServer || torn.killedTmux || torn.killedSdk) {
          await clearConversationDeliveryAndResumeState(
            conversationId,
            undefined,
            "RECONFIG",
          );
        }
      }

      // Before any worktree is made, so a refused start leaves none behind.
      if (
        agentType === "codex" &&
        daemon.codexAppServerInstance?.binaryMissing
      ) {
        commandOutcome.error =
          "Codex is not installed. Install it from https://codex.openai.com then restart your daemon.";
        if (conversationId) {
          daemon.syncServiceRef
            ?.setSessionError(conversationId, commandOutcome.error)
            .catch(() => {});
        }
        break;
      }

      let worktreeResult: WorktreeResult | null = null;

      if (isolated && cwd) {
        const gitRoot = (() => {
          try {
            return execSync("git rev-parse --show-toplevel", {
              cwd,
              encoding: "utf-8",
              stdio: ["pipe", "pipe", "ignore"],
            }).trim();
          } catch {
            return null;
          }
        })();
        if (gitRoot) {
          const wtName = worktreeName || `session-${shortId}`;
          const made = await createWorktree(gitRoot, wtName);
          // An isolated session never works in the main checkout: a line hand
          // there edits and commits on the checkout's own branch. A worktree
          // that cannot be made fails the start, and the run's station fails
          // with why. A full disk also stops the machine taking line runs
          // (diskFull.ts).
          if ("error" in made) {
            commandOutcome.error =
              diskFullFailReason(
                gitRoot,
                `could not make worktree ${wtName}: ${made.error}`,
              ) ?? `could not make worktree ${wtName}: ${made.error}`;
            log(`[WORKTREE] start refused: ${commandOutcome.error}`);
            if (conversationId)
              daemon.syncServiceRef
                ?.setSessionError(conversationId, commandOutcome.error)
                .catch(() => {});
            break;
          }
          worktreeResult = made;
          cwd = worktreeResult.worktreePath;
          log(
            `[WORKTREE] Created isolated worktree: ${worktreeResult.worktreeName} at ${cwd}`,
          );
        }
      }

      // `cast stable off` removes the Claude SessionStart hook, but the
      // new-session picker can opt one session back into Team/Solo. Install
      // the gated hook before spawning so its exported override is actually
      // consumed. Idempotent for machines already configured for stable mode.
      ensureStableHookForLaunch(agentType, config.stable_mode, stablePrefs);

      // Binary is a registry lookup; the per-client arg construction lives in
      // launchCommand.ts (buildLaunchArgs, unit-tested per client). The daemon
      // keeps the impure pieces: reading the config accessor + flag helpers, the
      // one-time codex-bypass notification, and the arg sanitizer.
      const binary = launchBinary(agentType, { warn: log });
      // A start carries a picker key ("opus") or a stored model id ("claude-opus-5-5"); both name one option.
      const requestedModelOpt = requestedModelKey
        ? (findModelOption(agentType, requestedModelKey) ??
          findModelOption(
            agentType,
            modelOptionKey(requestedModelKey, agentType),
          ))
        : undefined;
      const { binaryArgs: rawLaunchArgs, notifyCodexBypass } = buildLaunchArgs({
        agentType,
        configuredArgs: getConfiguredAgentArgs(agentType, config),
        permFlags: getPermissionFlags(agentType, config),
        defaultFlags: getDefaultParamFlags(agentType as AgentClientId, config),
        modelAlias: requestedModelOpt?.cliAlias,
        requestedEffort,
        assignedClaudeSessionId,
        hasCodexPermissionMode: !!config.agent_permission_modes?.codex,
      });
      if (notifyCodexBypass) {
        const flagFile = path.join(CONFIG_DIR, ".codex-bypass-notified");
        if (!fs.existsSync(flagFile)) {
          fs.writeFileSync(flagFile, new Date().toISOString());
          if (conversationId) {
            daemon.syncServiceRef
              ?.createSessionNotification({
                conversation_id: conversationId,
                type: "info" as any,
                title: "Codex running in full-access mode",
                message:
                  "Codex is running without permission prompts by default. Configure with: cast config codex_args",
              })
              .catch(() => {});
          }
        }
      }
      let binaryArgs = sanitizeBinaryArgs(rawLaunchArgs);
      // Export the per-session stable-context choice (and the conversation id,
      // so the SessionStart hook records against it directly with no lookup
      // race). Values are validated above / Convex ids — shell-safe tokens.
      const stableEnvVars: Record<string, string> = {
        ...(stablePrefs.stable_mode
          ? { [STABLE_ENV_MODE]: stablePrefs.stable_mode }
          : {}),
        ...(stablePrefs.stable_exclude?.length
          ? { [STABLE_ENV_EXCLUDE]: stablePrefs.stable_exclude.join(",") }
          : {}),
        ...(conversationId && /^[a-z0-9]+$/i.test(conversationId)
          ? { [STABLE_ENV_CONVERSATION_ID]: conversationId }
          : {}),
      };
      const stableEnvParts = Object.entries(stableEnvVars).map(
        ([k, v]) => `${k}=${v}`,
      );
      const stableEnv = stableEnvParts.length
        ? ` ${stableEnvParts.join(" ")}`
        : "";
      // PORT_<NAME> and the worktree identity from the workspace state, for
      // any cwd inside a codecast worktree — the ones this daemon made
      // (--isolated) and the ones `cast spawn --cloud` acquired on this host
      // before placing the session here. A session can then bind the port it
      // was allocated (vite --port "$PORT_WEB") instead of guessing from the
      // index. Same shell-safe token rule as the stable env above.
      // On the host, plus the laptop's forwarded ssh-agent while a bridge
      // is up (cloud/agentBridge.ts) — "" everywhere else.
      const wtEnvRaw = [worktreeEnvPrefix(cwd), hostAgentSocketEnv()]
        .filter(Boolean)
        .join(" ");
      const wtEnv = wtEnvRaw ? ` ${wtEnvRaw}` : "";
      // Which launch this pane is running (ct-49532): recorded before the
      // command is built, so a hook post from the process that occupied this
      // pane before now carries a superseded token and is dropped.
      const launchToken = launchTokenLedger().issue(
        tmuxSession,
        assignedClaudeSessionId || undefined,
      );
      const launchTokenEnvPart = launchTokenEnv(launchToken);
      // A shell's CLAUDE_CODE_EFFORT_LEVEL would beat the --effort this launch passes.
      const launchScrub = binaryArgs.includes("--effort")
        ? agentEnvScrub(undefined, { effortSet: true })
        : AGENT_ENV_SCRUB;
      const envPrefix = worktreeResult
        ? `${launchScrub}${launchTokenEnvPart} AGENT_RESOURCE_INDEX=${worktreeResult.portIndex}${wtEnv}${stableEnv}`
        : `${launchScrub}${launchTokenEnvPart}${wtEnv}${stableEnv}`;
      // Managed provider keys (opencode/pi) are sourced from a 0600 file so the
      // key never lands in `ps`/the pane; "" when nothing is managed (pl-207).
      const keyPrefix = providerKeySourcePrefix(agentType, CONFIG_DIR);
      // Same file-not-argv rule for the per-session Claude account store.
      // An empty prefix means the account did not resolve to a launch file and
      // the launch falls back to the keychain login — which the OAuth refresh
      // gate must then treat as held. Attribute what runs, not what was asked.
      const { prefix: accountPrefix, account: launchedAccount } =
        agentType === "claude"
          ? launchAccountPrefix(requestedAccount, log)
          : { prefix: "", account: undefined };
      // Launch through the disclaim wrapper so the agent is TCC
      // self-responsible: privacy prompts name the agent (its own signed
      // identity), not codecast/bun (see disclaim.ts). The wrapper execs
      // plain argv, which works here because envPrefix starts with `env`.
      let cmdText = `${accountPrefix}${keyPrefix}${disclaimPrefix()}${envPrefix} ${[binary, ...binaryArgs].join(" ")}`;
      if (
        agentType === "antigravity" &&
        cwd &&
        (await import("../antigravityLocal.js")).ensureAntigravityFolderTrusted(
          cwd,
        )
      ) {
        // Same reason as grok below: agy's first-launch trust dialog comes
        // before any transcript, so the session could never bind behind it.
        log(`antigravity folder trust granted for ${cwd}`);
      }
      if (agentType === "grok") {
        // Pre-trust the cwd so grok does not park on the first-launch folder
        // dialog. The pane classifier still answers `y` if the dialog appears.
        if (cwd && ensureGrokFolderTrusted(cwd)) {
          log(`grok folder trust granted for ${cwd}`);
        }
        // The feed rides `--rules` (grok has no hook channel for context); the
        // fragment is a shell substitution, so it is appended to the typed
        // command after the argv allowlist, never passed through it.
        try {
          const rulesFile = await writeGrokStableRulesFile(
            config,
            cwd,
            stablePrefs,
            conversationId || `launch-${Date.now()}`,
            conversationId,
          );
          cmdText += grokStableRulesFragment(rulesFile);
        } catch (err) {
          log(
            `grok stable rules skipped: ${err instanceof Error ? err.message : String(err)}`,
            "warn",
          );
        }
      }
      if (requestedDefinition) {
        // Tool flags are shell-escaped (deny rules carry parens and `*`) and
        // the prompt rides a 0600 file through `$(cat …)`, both appended
        // after the allowlist exactly like grok's rules fragment.
        // Loaded inside the one command that launches from a definition (boot graph guard).
        const { definitionLaunchFragment } = await import("../agentLaunch.js");
        const frag = definitionLaunchFragment(requestedDefinition, agentType, {
          dir: path.join(CONFIG_DIR, "agent-prompts"),
          key: conversationId || `launch-${Date.now()}`,
          escape: shellEscapeForSh,
        });
        cmdText += frag.fragment;
        if (frag.warning)
          log(
            `[definition ${requestedDefinition.name}] ${frag.warning}`,
            "warn",
          );
      }

      await launchSession(
        daemon,
        commandOutcome,
        config,
        binaryArgs,
        agentType,
        cwd,
        stablePrefs,
        conversationId,
        requestedModelOpt,
        requestedEffort,
        worktreeResult,
        expectedSessionId,
        assignedClaudeSessionId,
        parsed,
        startSteps,
        binary,
        requestedDefinition,
        stableEnvVars,
        launchToken,
        requestedAccount,
        cmdText,
        tmuxSession,
        launchedAccount,
      );
      break;
    }
  }
}
