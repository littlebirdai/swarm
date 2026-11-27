import type { HibernationPolicy } from "./hibernation.js";
import type { ConversationLifecycle } from "./syncService.js";

export type HibernationTarget = {
  session: string;
  pane: string;
  /** The PANE's own process, which the tmux boundary checks before the kill. */
  pid: number;
  /** The agent process itself, which every identity check is made against. */
  agentPid: number;
  start: string;
  stamp: string;
  conversationStamp: string;
};

export type HibernationBoundary = {
  target: HibernationTarget;
  terminal(args: string[]): Promise<{ stdout: string }>;
  revalidate(): Promise<boolean>;
  unchanged(): boolean;
  beginCommit(): boolean;
};

export type HibernationPassIo = {
  attemptTimeoutMs?: number;
  terminal(args: string[]): Promise<{ stdout: string }>;
  policy(): HibernationPolicy;
  parkingRefusal?(
    conversationId: string,
    sessionId: string,
  ): Promise<string | null>;
  promptOpen?(sessionId: string): boolean;
  /** tmux session name to the number of clients attached to it. */
  tmuxSessions(): Promise<Map<string, number>>;
  awakeIdleMs(sessionId: string): number;
  /** Since a subagent of this session last wrote. Infinity when it has none. */
  subagentActiveAgoMs(sessionId: string): number;
  /** session id to conversation id, read once per pass. */
  conversationIds(): Record<string, string>;
  askSidecarMtimeMs(sessionId: string): Promise<number | null>;
  transcriptLastRealMs(sessionId: string): Promise<number | null>;
  lifecycle(
    conversationId: string,
    sessionId: string,
  ): Promise<ConversationLifecycle | null>;
  /** False when the session runs inside another session's process tree. */
  canReapPidTree(sessionId: string): boolean | Promise<boolean>;
  /** True when work is reaching this session right now. Read again at the kill. */
  deliveryActive(
    sessionId: string,
    conversationId: string | undefined,
  ): boolean;
  /** True when the pane is gone; false when the kill-time recheck refused it. */
  inspectTarget(
    sessionId: string,
    tmux: string,
    conversationId: string,
  ): Promise<HibernationTarget | null>;
  park(
    sessionId: string,
    tmux: string,
    convId: string | undefined,
    idleHours: number,
    boundary: HibernationBoundary,
  ): Promise<boolean>;
  now(): number;
};
