// Pure heartbeat rules for managed_sessions rows: no reads, no writes.
import {
  ACTIVE_AGENT_STATUSES,
  HEARTBEAT_REFRESH_MS,
  type AgentStatus,
} from "@codecast/sessions/agentStatus";

import { isHostedAgentType } from "@codecast/agent-clients/agentClients";
import type { NoticeKind } from "@codecast/hosted-assistant/assistant";
import type { ThreadStateStatus } from "@codecast/sessions/threadState";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { statusWriteIsStale, type StatusStamps } from "./heartbeatPatch";
import { heartbeatRow } from "./sessionHeartbeat";

// Shared by heartbeat + heartbeatBatch: compute one session's heartbeat patch.
// The heartbeat carries the daemon's current
// agent_status so the server self-heals a dropped transition — but only
// overwrites when the incoming client_ts isn't older than the last applied write
// time, and only advances agent_status_updated_at on an ACTUAL status change
// (the heartbeat re-sends the current status, so bumping it unconditionally
// would track "last heard" instead of "entered this status", which idle
// detection depends on).
// Refresh last_heartbeat at most this often (HEARTBEAT_REFRESH_MS, owned by
// @codecast/sessions/agentStatus because the liveness window is derived from it).
// The legacy write invalidates projections that read the registry, so preserve
// the refresh throttle during expand.
// The throttle means the stamp advances on the first flush PAST it, not on the
// flush cadence: 60s apart in steady state and 85s behind a late flush, which
// is why HEARTBEAT_ALIVE_MS is derived from this number rather than guessed
// alongside it. A status change and an ACTIVE reassertion persist their
// ordering stamp immediately: a reasserted "working" must defeat a delayed
// older park write. A SETTLED reassertion (idle, done, stopped, dormant,
// hibernated) rides the same throttle as last_heartbeat: every beat carries a
// fresh client_ts, so stamping each one wrote every settled session's row on
// every 30s flush and re-ran each subscription that reads it (89k row writes
// an hour across 810 sessions, 707 of them settled, 2026-11-10).

// Returns null when neither status ordering nor heartbeat freshness advances.
export function buildHeartbeatPatch(
  session: StatusStamps & { last_heartbeat?: number },
  agentStatus: string | undefined,
  clientTs: number | undefined,
  now: number,
): Record<string, any> | null {
  const patch: Record<string, any> = {};
  let statusChanged = false;
  // oxfmt-ignore
  const heartbeatStale = !session.last_heartbeat || now - session.last_heartbeat > HEARTBEAT_REFRESH_MS;
  if (agentStatus) {
    const tsStale = statusWriteIsStale(session, agentStatus, clientTs);
    const settledReassertion =
      agentStatus === session.agent_status &&
      !ACTIVE_AGENT_STATUSES.has(agentStatus);
    if (
      !tsStale &&
      (clientTs ?? now) > (session.agent_status_write_at ?? 0) &&
      (!settledReassertion || heartbeatStale)
    ) {
      patch.agent_status_write_at = clientTs ?? now;
    }
    // Only write agent_status when it actually changes — re-writing the same
    // value is a no-op mutation that still invalidates every reader.
    if (!tsStale && agentStatus !== session.agent_status) {
      patch.agent_status = agentStatus;
      patch.agent_status_updated_at = clientTs || now;
      // A new status is a new settle; the boundary claim described the old one
      // (ct-49533). undefined deletes the field.
      patch.agent_status_boundary = undefined;
      statusChanged = true;
    }
  }
  if (statusChanged || heartbeatStale) {
    patch.last_heartbeat = now;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

export async function applyHeartbeat(
  ctx: MutationCtx,
  session: Doc<"managed_sessions">,
  agentStatus: string | undefined,
  clientTs: number | undefined,
  now: number,
) {
  const patch = buildHeartbeatPatch(session, agentStatus, clientTs, now);
  // Expand keeps the original throttle and counts. Seed a missing side row
  // even when this beat falls within the legacy timestamp's refresh interval.
  // oxfmt-ignore
  await writeSessionHeartbeat(ctx, session._id, session.user_id, patch?.last_heartbeat ?? session.last_heartbeat);
  if (patch) await ctx.db.patch(session._id, patch);
  return patch;
}

export async function writeSessionHeartbeat(
  ctx: Pick<MutationCtx, "db">,
  id: Id<"managed_sessions">,
  userId: Id<"users">,
  at: number,
) {
  const row = await heartbeatRow(ctx, id);
  if (!row) {
    await ctx.db.insert("session_heartbeats", {
      managed_session_id: id,
      user_id: userId,
      heartbeat_at: at,
    });
  } else if (row.heartbeat_at !== at) {
    await ctx.db.patch(row._id, { heartbeat_at: at });
  }
}

export type AgentStatusWrite = {
  conversation_id: Id<"conversations">;
  agent_status: AgentStatus;
  client_ts?: number;
  permission_mode?: Doc<"managed_sessions">["permission_mode"];
  open_tasks?: Doc<"managed_sessions">["open_tasks"];
  presumed?: boolean;
  hibernated_at?: number | null;
  session_boundary?: boolean;
  turn_completed_at?: number;
};

export async function writeAgentStatus(
  ctx: MutationCtx,
  session: Doc<"managed_sessions">,
  args: AgentStatusWrite,
) {
  const patch: Record<string, any> = {
    agent_status: args.agent_status,
    agent_status_write_at: args.client_ts ?? Date.now(),
    agent_status_boundary: args.session_boundary === true ? true : undefined,
  };
  if (args.turn_completed_at !== undefined) {
    patch.turn_completed_at = args.turn_completed_at;
  }

  if (args.permission_mode !== undefined) {
    patch.permission_mode = args.permission_mode;
  }
  if (args.hibernated_at !== undefined) {
    patch.hibernated_at =
      args.hibernated_at === null ? undefined : args.hibernated_at;
  }
  if (args.open_tasks !== undefined) {
    patch.open_tasks = args.open_tasks;
    patch.open_tasks_at = Date.now();
  }

  if (args.agent_status !== session.agent_status) {
    patch.agent_status_updated_at = args.client_ts ?? Date.now();
  }

  if (ACTIVE_AGENT_STATUSES.has(args.agent_status)) {
    const at = Date.now();
    patch.last_heartbeat = at;
    await writeSessionHeartbeat(ctx, session._id, session.user_id, at);
  }

  if (Object.keys(patch).length > 0) {
    await ctx.db.patch(session._id, patch);
  }

  return patch;
}

export async function ensureHostedManagedSession(
  ctx: MutationCtx,
  conversation: Doc<"conversations">,
): Promise<Doc<"managed_sessions">> {
  if (!isHostedAgentType(conversation.agent_type)) {
    throw new Error(
      "Only a hosted assistant conversation has a hosted status row",
    );
  }
  const existing = await ctx.db
    .query("managed_sessions")
    .withIndex("by_conversation_id", (q: any) =>
      q.eq("conversation_id", conversation._id),
    )
    .first();
  if (existing) {
    if (existing.hosted) return existing;
    await ctx.db.patch(existing._id, { hosted: true });
    return { ...existing, hosted: true };
  }
  const now = Date.now();
  const id = await ctx.db.insert("managed_sessions", {
    session_id: conversation.session_id,
    conversation_id: conversation._id,
    user_id: conversation.user_id,
    pid: 0,
    started_at: now,
    last_heartbeat: 0,
    agent_status: "idle",
    agent_status_updated_at: now,
    hosted: true,
  });
  await writeSessionHeartbeat(ctx, id, conversation.user_id, 0);
  return (await ctx.db.get(id))!;
}

type HostedTurnFields = Omit<Doc<"assistant_turns">, "_id" | "_creationTime">;

export function insertHostedTurn(ctx: MutationCtx, fields: HostedTurnFields) {
  return ctx.db.insert("assistant_turns", fields);
}

export function patchHostedTurnStatus(
  ctx: MutationCtx,
  id: Id<"assistant_turns">,
  fields: Pick<HostedTurnFields, "status"> & Partial<HostedTurnFields>,
) {
  return ctx.db.patch(id, fields);
}

export function writeHostedStop(
  ctx: MutationCtx,
  id: Id<"conversations">,
  kind: NoticeKind | undefined,
) {
  return ctx.db.patch(id, { hosted_stop: kind });
}

export async function writeThreadState(
  ctx: MutationCtx,
  conv: Pick<Doc<"conversations">, "_id" | "message_count">,
  text: string,
  status: ThreadStateStatus,
  result?: string | null,
) {
  const at = Date.now();
  await ctx.db.patch(conv._id, {
    thread_state: text,
    thread_state_at: at,
    thread_state_msg_count: conv.message_count ?? 0,
    thread_state_status: status,
    thread_state_result: result ?? undefined,
    thread_state_result_at: result ? at : undefined,
  });
  return at;
}

type ConversationFields = Omit<Doc<"conversations">, "_id" | "_creationTime">;

export function patchConversationLifecycle(
  ctx: Pick<MutationCtx, "db">,
  id: Id<"conversations">,
  fields: Partial<ConversationFields>,
) {
  return ctx.db.patch(id, fields);
}

export function insertConversationWithStatus(
  ctx: Pick<MutationCtx, "db">,
  fields: ConversationFields,
) {
  return ctx.db.insert("conversations", fields);
}

type PendingMessageFields = Omit<
  Doc<"pending_messages">,
  "_id" | "_creationTime"
>;

export function writePendingStatus(
  ctx: Pick<MutationCtx, "db">,
  id: Id<"pending_messages">,
  fields: Pick<PendingMessageFields, "status"> & Partial<PendingMessageFields>,
) {
  return ctx.db.patch(id, fields);
}
