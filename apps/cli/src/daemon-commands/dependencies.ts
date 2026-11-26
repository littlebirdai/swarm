import { ClaudeSdkBackend } from "../claudeSdk/backend.js";
import { stepTimer } from "../stepTimer.js";
import { type TmuxDeliveryIdentity } from "../tmuxDeliveryJournal.js";
import { type AgentClientId } from "@codecast/agent-clients/agentClients";
import { type StableLaunchPrefs } from "@codecast/snippets/stableContext";
import { type ResourceProcess } from "@codecast/machines/systemResources";
import { type AgentDefinitionSpec } from "@codecast/agents/agentDefinitions";

import { AccountLifecycleGate } from "../accountLifecycleGate.js";
import { type PersistedCodexThread } from "../codexTurnRecovery.js";
import { TurnClaimLedger } from "../turnClaims.js";
import { type ConversationProjectInfo } from "../resumePlacement.js";
import { type ReparentCommandFacts } from "../sessionMoveNotice.js";
import { OpencodeServer } from "../opencodeServer.js";
import {
  CodexAppServer,
  type ApprovalPolicy,
  type SandboxMode,
} from "../codex-app-server.js";
import { type WorktreeResult } from "../worktreeLegacy.js";
import { SyncService } from "../syncService.js";
import { type InputIntent } from "../keystrokeInference.js";
import {
  type BuiltStableContext,
  type BuildStableContextOptions,
} from "../stableContext.js";
import { type FenceKind } from "../configFence.js";
import { type TmuxLiveState } from "../tmuxPaneState.js";
import { type ExportResult } from "../jsonlGenerator.js";
import { CloudAgentRegistry } from "../cloudAgents/index.js";
import type { AgentStatus } from "@codecast/sessions/agentStatus";
import { type Config } from "../config/types.js";
import { MintFlowControl } from "../mintFlowControl.js";
import { type ProviderKeyVerifier } from "../providerKeyCrypto.js";
import { type TitleCache } from "../titleCache.js";

export interface ConversationCache {
  [sessionId: string]: string;
}

/** What ensureReparentedCheckout prepared for a reparented session to resume in. */
export interface ReparentedCheckout {
  path: string;
  /** True when this machine cloned the repo just now; false when a checkout was already here. */
  cloned: boolean;
  /** The session ran in a bare home folder and resumes in this machine's home. */
  homeFolder?: boolean;
  remote?: string;
  branch?: string;
  /** Set when the source's working-tree snapshot was found and replayed. */
  restored?: RestoredWork;
}

// Deterministic per-remote checkout dir for a reparented session. Keyed by a
// hash of the remote so two repos with the same basename never collide.
/** A source-published working tree replayed into a reparent checkout. */
export interface RestoredWork {
  /** The session's real branch, from the snapshot — not the remote's default. */
  branch: string;
  /** True when uncommitted work was reproduced here. */
  appliedWork: boolean;
  applyError?: string;
}

export interface GitInfo {
  commitHash?: string;
  branch?: string;
  remoteUrl?: string;
  status?: string;
  diff?: string;
  diffStaged?: string;
  root?: string;
  repoRoot?: string;
  worktreeName?: string;
  worktreeBranch?: string;
  worktreePath?: string;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface RemoteLog {
  level: LogLevel;
  message: string;
  metadata?: {
    session_id?: string;
    error_code?: string;
    stack?: string;
  };
  timestamp: number;
}

// AgentStatus is imported from @codecast/sessions/agentStatus (the single source of
// truth). The old local union here was missing "starting", which would have made
// a CLI-first status addition throw on every heartbeatBatch validation and mark
// live sessions dead fleet-wide.
export type PermissionMode =
  | "default"
  | "plan"
  | "acceptEdits"
  | "bypassPermissions"
  | "dontAsk"
  | "auto";

export type PermissionModeIo = {
  press: () => Promise<void>;
  readMode: () => Promise<PermissionMode | undefined>;
  sleep?: (ms: number) => Promise<void>;
};

export type PermissionModeStep =
  | { mode: PermissionMode; presses: number }
  | { error: string };

export type ResumeOptions = {
  /**
   * This resume is an explicit human gesture (the resume_session / fork_session
   * command), not the daemon reviving something on its own — so it bypasses the
   * retired-conversation gate. It has to: restartSession leaves an existing row's
   * status/inbox_killed_at untouched when it enqueues the kill→resume pair, so a
   * "Restart" on a killed card reaches the daemon still looking killed, and
   * refusing it would break the one gesture that is meant to bring a session back.
   * Only the gate reads this; nothing downstream does.
   */
  userInitiated?: boolean;
  /** The resume a backend switch runs itself, past the hold it put on the session (claudeSdk/switchBackend.ts). */
  duringBackendSwitch?: boolean;
  /** The permission mode the session ran in on the backend it leaves (a backend switch), kept on resume. */
  permissionMode?: string;
  /**
   * Launch the client's native fork of this parent session (registry `forkCmd`)
   * under the new id instead of resuming an existing transcript. The parent's
   * local transcript supplies the cwd; the child's appears when the client
   * writes it.
   */
  forkFromSessionId?: string;
  delivery?: TmuxDeliveryIdentity;
  model?: string;
  effort?: string;
  /**
   * The process has been typed into the pane (or this resume will not spawn).
   * Production fires this so the account-switch gate can drop before the
   * readiness poll; the test double leaves it unset and holds until launch
   * returns, which is how the identity tests keep a switch off an in-flight
   * credential read.
   */
  onProcessSpawned?: () => void;
  /**
   * Runs a transcript transfer without the account-switch hold, keeping the
   * in-flight guard fresh while it runs; "superseded" when another resume
   * took over meanwhile, "closed" when the resume gate shut.
   */
  duringTransfer?: <T>(
    run: () => Promise<T>,
  ) => Promise<T | "superseded" | "closed">;
};

export type ResumeFatalReason =
  | "missing_conversation"
  | "session_not_found"
  | "invalid_session_id";

export type StartedSessionInfo = {
  tmuxSession: string;
  projectPath: string;
  startedAt: number;
  agentType: AgentClientId;
  sessionId?: string;
  worktreeName?: string;
  worktreeBranch?: string;
  worktreePath?: string;
};

// Messages a session was launched with as its prompt argument, by message id.
// In memory only: across a daemon restart the transcript echo settles the row.
export type LaunchPromptCarry = {
  conversationId: string;
  tmuxSession: string;
  projectPath: string;
  sessionId: string;
  transcript: string;
  startedAt: number;
};

export type SessionFileInfo = { path: string; agentType: AgentClientId };

export interface ClaudeSessionInfo {
  pid: number;
  tty: string;
  sessionId: string;
  termProgram?: string;
}

// Claim answers already in flight for a batch of commands. All three delivery
// paths hand the daemon a list and then execute it one at a time, so a claim
// started inside the executor cost one round trip per command before any of
// them ran. Starting them together makes a batch cost one round trip.
export type ClaimAnswer = {
  claimed?: boolean;
  released?: boolean;
  reason?: string;
} | null;

export type CommandOutcome = {
  result?: string;
  error?: string;
  afterReport?: () => void;
};

export interface DaemonCommandDeps {
  readonly accountLifecycleGate: AccountLifecycleGate;
  readonly activeConfig: Config | null;
  readonly applyServerSyncSettings: (data: {
    sync_mode?: string;
    sync_projects?: string[];
    sync_excluded?: string[];
  }) => void;
  readonly appServerConversations: Map<string, string>;
  readonly autoResumeSession: (
    sessionId: string,
    content: string,
    titleCache: TitleCache,
    cwdOverride?: string,
    conversationId?: string,
    agentTypeHint?: AgentClientId,
    opts?: ResumeOptions,
  ) => Promise<boolean>;
  readonly bindSdkSession: (
    conversationId: string,
    sessionId: string,
    cwd: string,
  ) => Promise<void>;
  readonly blankLaunchAccount: (
    conversationId: string | undefined,
  ) => Promise<{ prefix: string; account?: string }>;
  readonly buildBlankLaunchArgs: (
    agentType: AgentClientId,
    config: Config | null | undefined,
    assignedClaudeSessionId?: string,
  ) => string[];
  readonly buildCodexStableContext: (
    config: Config | null,
    cwd?: string,
    prefs?: StableLaunchPrefs,
    session?: string,
  ) => Promise<BuiltStableContext | undefined>;
  readonly buildReverseConversationCache: (
    cache: ConversationCache,
  ) => Record<string, string>;
  readonly captureTmuxLiveState: (
    target: string,
    glyphlessPattern: RegExp | null,
    captureLines: number,
  ) => Promise<{ stdout: string; region: string; state: TmuxLiveState }>;
  readonly carryLaunchPrompt: (
    messageId: string,
    carry: Omit<LaunchPromptCarry, "startedAt">,
    payload: string,
  ) => void;
  readonly claudeSdkBackend: ClaudeSdkBackend | null;
  readonly clearConversationDeliveryAndResumeState: (
    conversationId: string | undefined,
    sessionId: string | undefined,
    context: string,
  ) => Promise<void>;
  readonly cloneCheckout: (
    remote: string,
    dest: string,
    tag: string,
  ) => Promise<boolean>;
  readonly cloudAgents: CloudAgentRegistry;
  readonly cloudSpawnInFlight: Map<string, Promise<unknown>>;
  readonly codexAppServerInstance: CodexAppServer | null;
  readonly collectGitSweepTargets: (
    sessionIds: string[],
  ) => Array<{ sessionId: string; conversationId: string; cwd: string }>;
  readonly computeLocalProjectRoots: () => string[];
  readonly CONFIG_DIR: string;
  readonly CONVERSATION_RESUME_COOLDOWN_MS: number;
  readonly CONVERSATION_RESUME_MAX_FAILURES: 3;
  readonly conversationCacheRef: ConversationCache | null;
  readonly conversationResumeFailures: Map<
    string,
    { count: number; lastFailure: number }
  >;
  readonly createWorktree: (
    repoRoot: string,
    name: string,
  ) => Promise<WorktreeResult | { error: string }>;
  readonly currentAgentStatus: (sessionId: string) => AgentStatus | undefined;
  readonly daemonVersion: string | undefined;
  readonly detectSessionAgentType: (sessionId: string) => AgentClientId;
  readonly discardPrimedClaim: (
    commandId: string,
    siteUrl: string,
    apiToken: string,
  ) => void;
  readonly disclaimPrefix: () => string;
  readonly discoverAndLinkSession: (
    conversationId: string,
    tmuxSession: string,
    cwd: string,
  ) => Promise<void>;
  readonly dropClaim: (commandId: string) => void;
  readonly EDITED_IN_CODECAST: { why: string; automatic: boolean };
  readonly ensureManagedSessionHeartbeat: (
    sessionId: string,
    source?: "transcript",
  ) => void;
  readonly ensureOpencodeServer: (
    config: Config | null | undefined,
  ) => Promise<OpencodeServer | null>;
  readonly ensureReparentedCheckout: (
    conversationId: string | undefined,
    recordedPath: string | undefined,
    remoteHint?: string,
  ) => Promise<ReparentedCheckout | undefined>;
  readonly fencedTarget: (p: string, kind: FenceKind) => Promise<string | null>;
  readonly fetchFolderFromPeers: (
    conversationId: string,
    recorded: string,
  ) => Promise<string | null>;
  readonly findActiveTurnForThread: (threadId: string) => string | undefined;
  readonly findSessionFile: (
    sessionId: string,
    opts?: { staleOk?: boolean },
  ) => SessionFileInfo | null;
  readonly findSessionProcess: (
    sessionId: string,
    agentType?: AgentClientId,
  ) => Promise<ClaudeSessionInfo | null>;
  readonly FLEET_REREAD_WAIT_MS: number;
  readonly flushRemoteLogs: () => Promise<void>;
  readonly folderFetchFailures: {
    blocked: (key: string) => string | undefined;
    reason: (key: string) => string | undefined;
    fail: (key: string, reason: string) => void;
    clear: (key: string) => boolean;
    forgetConversation: (conversationId: string) => void;
  };
  readonly forgetProcessedCommand: (commandId: string) => void;
  readonly getGitInfo: (projectPath: string) => Promise<GitInfo | undefined>;
  readonly getInitialManagedSessionId: (
    agentType: AgentClientId,
    expectedSessionId?: string,
    appServerThreadId?: string,
  ) => string | undefined;
  readonly hibernateSessionNow: (
    sessionId: string,
    conversationId?: string,
  ) => Promise<{ result?: string; error?: string }>;
  readonly holdClaim: (commandId: string) => void;
  readonly hookListening: Promise<number>;
  readonly hookServerPort: number;
  readonly hostReports: () => Promise<
    import("../cloud/hostReports.js").HostReports
  >;
  readonly invalidateLocalProjectRoots: () => void;
  readonly isAutostartEnabled: () => boolean;
  readonly killConversationBackends: (
    conversationId: string,
    sessionIdHint?: string,
    retireWorkspace?: boolean,
    opts?: { keepTurnClaims?: boolean },
  ) => Promise<{ result?: string; error?: string }>;
  readonly killConversationBackendsForAgentSwitch: (
    conversationId: string,
    sessionIdHint?: string,
  ) => Promise<{ result?: string; error?: string }>;
  readonly killLocalPanesForConversation: (
    conversationId: string,
    sessionIdHint: string | undefined,
    context: string,
  ) => Promise<number>;
  readonly killTmuxSessionAndTree: (
    tmuxSession: string,
    reason?: string,
  ) => Promise<void>;
  readonly lastHookStatus: ReadonlyMap<
    string,
    { status: AgentStatus; turn_completed_at?: number }
  >;
  readonly latestInjectionTsFor: (conversationId: string) => number | null;
  readonly launchWorkflowRun: (
    siteUrl: string,
    apiToken: string,
    runId: string,
  ) => Promise<{ tmux_session: string } | { error: string }>;
  readonly liveSyncJobs: () => Promise<
    import("../cloud/liveSyncJobs.js").LiveSyncJobs
  >;
  readonly log: (
    message: string,
    level?: LogLevel,
    metadata?: RemoteLog["metadata"],
  ) => void;
  readonly logConvexFailure: (err: unknown) => void;
  readonly logError: (
    message: string,
    error?: Error,
    sessionId?: string,
  ) => void;
  readonly logLifecycle: (event: string, details?: string) => void;
  readonly logWarn: (message: string, sessionId?: string) => void;
  readonly maintainCcUsageSnapshots: (
    reason: string,
    opts?: { force?: boolean },
  ) => Promise<void>;
  readonly maintainCodexUsageSnapshot: (
    reason: string,
    opts?: { force?: boolean },
  ) => Promise<void>;
  readonly mayReconstituteResumeTranscript: (
    agentType: AgentClientId | undefined | null,
  ) => boolean;
  readonly MINT_FLOW_TMUX: "cc-mint-flow";
  readonly mintFlow: MintFlowControl;
  readonly mintUrlPath: () => string;
  readonly nextSdkPermissionMode: (
    current: string | null | undefined,
  ) => string;
  readonly observePaneInput: (target: string, bytes: ArrayLike<number>) => void;
  readonly observeSessionInput: (
    sessionId: string,
    intent: InputIntent,
  ) => void;
  readonly ownedByAnotherDevice: (
    info: { ownerDeviceId?: string | null } | null | undefined,
  ) => boolean;
  pacedAccountRevive: { profile: string; pending: number } | null;
  readonly parsePermissionModeFooter: (
    pane: string,
  ) => PermissionMode | undefined;
  readonly patchConfig: (updates: Partial<Config>) => void;
  readonly pendingAgentSwitches: Map<string, string>;
  readonly pendingAppServerForkParents: Set<string>;
  readonly PERMISSION_MODES: ReadonlySet<string>;
  readonly persistAppServerThreadRegistrations: () => boolean;
  readonly persistedAppServerThreads: Map<string, PersistedCodexThread>;
  readonly placeArrivedSession: (
    sessionId: string,
    cwd: string | undefined,
    recorded: string | undefined,
  ) => Promise<void>;
  readonly platform: NodeJS.Platform;
  readonly pushCredentialToRemoteHosts: (
    reason: string,
    opts?: { onlyIfChanged?: boolean },
  ) => Promise<void>;
  readonly pushProviderKeysToRemoteHosts: (
    reason: string,
    opts?: { onlyIfChanged?: boolean },
  ) => Promise<void>;
  readonly pushSessionIdBinding: (
    conversationId: string,
    sessionId: string,
    projectPath?: string,
    gitRoot?: string,
    gitRemoteUrl?: string,
  ) => Promise<void>;
  readonly readBranch: (cwd: string) => string | undefined;
  readonly readConfig: () => Config | null;
  readonly readConversationCache: () => ConversationCache;
  readonly readDaemonState: () => {
    lastSyncTime?: number;
    pendingQueueSize?: number;
  };
  readonly readyCodexAppServer: (
    conversationId?: string,
  ) => Promise<CodexAppServer | null>;
  readonly rebindConversationSession: (
    oldSessionId: string,
    newSessionId: string,
    conversationId: string,
    projectPath?: string,
    conversationCache?: ConversationCache,
  ) => void;
  readonly rebuildOpencodeSession: (
    exportData: ExportResult,
    cwd: string | undefined,
  ) => Promise<string | null>;
  readonly recordObservedPermissionMode: (
    sessionId: string,
    conversationId: string,
    mode: PermissionMode,
    pane: string,
  ) => void;
  readonly recordProjectMapping: (key: string, localDir: string) => void;
  readonly refreshLocalProjectRoots: () => Promise<void>;
  readonly refuseResumeNoLocalCheckout: (
    sessionId: string,
    conversationId: string | undefined,
    recordedCwd: string | undefined,
  ) => Promise<string>;
  readonly registerAppServerConversation: (
    conversationId: string,
    threadId: string,
    opts?: {
      cwd?: string;
      updatedAt?: number;
      persist?: boolean;
      approvalPolicy?: ApprovalPolicy;
      sandbox?: PersistedCodexThread["sandbox"];
    },
  ) => void;
  readonly registerManagedStartedSession: (
    conversationId: string,
    sessionId: string,
    tmuxSession: string,
  ) => void;
  readonly remapConversationSession: (
    oldSessionId: string,
    newSessionId: string,
    conversationId: string,
    conversationCache?: ConversationCache,
  ) => void;
  readonly repairAndResumeSession: (
    sessionId: string,
    content: string,
    titleCache: TitleCache,
    cwdOverride?: string,
    conversationId?: string,
    agentTypeHint?: AgentClientId,
    opts?: ResumeOptions,
  ) => Promise<boolean>;
  readonly republishLineProfileSoon: (
    root: string,
    onDone?: (outcome: { ok: boolean; detail?: string }) => void,
  ) => void;
  readonly resolveCodexPermissionDefaults: (config?: Config | null) => {
    sandbox: SandboxMode;
    approvalPolicy: ApprovalPolicy;
  };
  readonly resolveCommandSessionId: (
    conversationId: string,
  ) => Promise<string | undefined>;
  readonly resolveLocalRepo: (remotePath: string) => string | null;
  readonly resolveResumeCwdOrRefuse: (opts: {
    recordedCwd?: string;
    cwdOverride?: string;
    conversationId?: string;
    projectInfo?: ConversationProjectInfo | null;
  }) => Promise<string | null>;
  readonly resolveSessionCommandPane: (
    conversationId: string,
    sessionId: string,
    agentType: AgentClientId,
  ) => Promise<{ tmuxTarget: string | null; proc: ClaudeSessionInfo | null }>;
  readonly restartDaemonProcess: (reason: string) => void;
  readonly restartingSessionIds: Map<string, number>;
  readonly resumeFatalReasons: Map<string, ResumeFatalReason>;
  readonly resumeInFlight: Map<string, Promise<boolean>>;
  readonly resumeInFlightStarted: Map<string, number>;
  readonly resumeOrRepair: (
    sessionId: string,
    resume: () => Promise<boolean>,
    repair: () => Promise<boolean>,
  ) => Promise<"resumed" | "repaired" | "cancelled" | null>;
  readonly resumeSessionCache: Map<string, string>;
  readonly runApprovedCast: (
    decisionId: string,
    argv: string[],
    cwd: string | undefined,
  ) => Promise<void>;
  readonly runCastCommand: (
    args: string[],
    opts?: {
      timeoutMs?: number;
      killGroup?: boolean;
      env?: Record<string, string>;
      cwd?: string;
      inheritEnv?: boolean;
      onStdoutLine?: (line: string) => void;
    },
  ) => Promise<{ code: number | null; stdout: string; stderr: string }>;
  readonly runSelfUpdate: (why: string, at?: number) => Promise<void>;
  readonly sanitizeBinaryArgs: (args: string[]) => string[];
  readonly saveConversationCache: (cache: ConversationCache) => void;
  readonly seedOpencodeForkSyncBaseline: (forkSessionId: string) => number;
  readonly sendHeartbeat: () => Promise<void>;
  readonly sendReparentNotice: (opts: {
    conversationId: string;
    sessionId: string;
    priorCwd?: string;
    checkout?: ReparentedCheckout;
    command: ReparentCommandFacts;
  }) => Promise<void>;
  readonly sessionProcessesOutsideTree: (
    sessionId: string,
  ) => Promise<ResourceProcess[]>;
  readonly setTmuxSessionOption: (
    sessionName: string,
    optionName: string,
    value: string,
  ) => Promise<void>;
  readonly stableLaunchOptions: (
    config: Config | null,
    cwd?: string,
    prefs?: StableLaunchPrefs,
    session?: string,
  ) => BuildStableContextOptions | null;
  readonly stampCodexPaneAccount: (
    agentType: string,
    tmuxSession: string,
    conversationId?: string,
  ) => Promise<void>;
  readonly startClaudeSdkSession: (o: {
    conversationId: string;
    sessionId: string;
    cwd: string;
    binary: string;
    binaryArgs: string[];
    definition?: AgentDefinitionSpec;
    portIndex?: number;
    stableEnvVars: Record<string, string>;
    launchToken: string;
    account?: string;
    transcriptPath?: string;
    steps?: ReturnType<typeof stepTimer>;
  }) => Promise<void>;
  readonly startCodexThreadThenRecordStableContext: <T>(
    startThread: () => Promise<T>,
    record?: () => void,
  ) => Promise<T>;
  readonly startedSessionGuard: (
    entry: { startedAt: number } | undefined,
    linked: boolean,
    now?: number,
  ) => "proceed" | "skip_booting" | "replace_stale";
  readonly startedSessionTmux: Map<string, StartedSessionInfo>;
  readonly startLoginFlow: (
    email: string | undefined,
    force?: boolean,
    profile?: string,
    openBrowser?: boolean,
  ) => Promise<string>;
  readonly startMigrateChild: (
    key: string,
    args: string[],
  ) => { started: boolean; pid?: number; reason?: string; log?: string };
  readonly startMigrationRunner: (batchId: string) => {
    started: boolean;
    pid?: number;
    reason?: string;
    log?: string;
  };
  readonly startMintFlow: (
    profile: string,
    force?: boolean,
    startedAt?: number,
  ) => Promise<string>;
  readonly stepPermissionMode: (
    io: PermissionModeIo,
    target?: PermissionMode,
    opts?: { settleMs?: number; pollMs?: number },
  ) => Promise<PermissionModeStep>;
  readonly stopLocalSessionBackends: (
    conversationId: string,
    sessionId: string | undefined,
  ) => Promise<void>;
  readonly stopManagedSessionHeartbeat: (sessionId: string | undefined) => void;
  readonly stopSessionProcessesOutsideTree: (
    sessionId: string,
  ) => Promise<ResourceProcess[]>;
  readonly submitLoginCode: (code: string) => Promise<string>;
  readonly SWITCH_CONTINUE_SPACING_MS: 20000;
  readonly switchConversationBackend: (
    conversationId: string,
    sessionIdHint: string | undefined,
    target: "sdk" | "tmux",
    interrupt: boolean,
    projectPath: string | undefined,
  ) => Promise<{ result?: string; error?: string }>;
  readonly syncServiceRef: SyncService | null;
  readonly syncStats: {
    messagesSynced: number;
    conversationsCreated: number;
    sessionsActive: Set<string>;
    lastReportTime: number;
    errors: number;
    warnings: number;
  };
  readonly takePrimedClaim: (
    commandId: string,
    siteUrl: string,
    apiToken: string,
  ) => Promise<ClaimAnswer>;
  readonly takeTurnSnapshot: (
    root: string,
    turns: Map<string, number>,
  ) => Promise<void>;
  readonly teardownConversationBackendsLive: (
    conversationId: string,
    opts?: {
      interruptActiveTurn?: boolean;
      keepSdkBinding?: boolean;
      keepCodexResume?: boolean;
      keepTurnClaims?: boolean;
    },
  ) => Promise<{
    killedAppServer: boolean;
    killedTmux: boolean;
    killedSdk?: string;
    appServerThreadId?: string;
  }>;
  readonly terminalToken: () => string;
  readonly tmuxExec: (
    args: string[],
    opts?: {
      timeout?: number;
      killSignal?: string;
      env?: Record<string, string | undefined>;
    },
  ) => Promise<{ stdout: string; stderr: string }>;
  readonly tmuxSessionsCreatedBy: (sessionId: string) => Promise<string[]>;
  readonly touchHostActivity: () => void;
  readonly turnClaims: () => TurnClaimLedger;
  readonly turnCompletedAtFor: (sessionId: string) => number | undefined;
  readonly turnStartedAtFor: (sessionId: string) => number | null;
  readonly typeIntoPane: (target: string, command: string) => Promise<void>;
  readonly USER_RESUME: { readonly userInitiated: true };
  readonly validatePath: (p: string) => string | null;
  readonly verifyProviderKey: ProviderKeyVerifier;
  readonly waitingLaunchPrompt: (
    conversationId: string,
  ) => Promise<{ messageId: string; fragment: string; text: string } | null>;
  readonly withPanePermissionModeLock: <T>(
    tmuxTarget: string,
    run: () => Promise<T>,
  ) => Promise<T>;
  readonly writeGrokStableRulesFile: (
    config: Config | null,
    cwd: string | undefined,
    prefs: StableLaunchPrefs | undefined,
    key: string,
    conversationId?: string,
  ) => Promise<string | undefined>;
  readonly writeRebuiltDeltaTranscript: (
    client: "pi",
    content: string,
    finalPath: string,
    sessionId: string,
  ) => Promise<void>;
}
