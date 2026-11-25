// Pure heartbeat rules for managed_sessions rows: no reads, no writes.
import {
  ACTIVE_AGENT_STATUSES,
  HEARTBEAT_REFRESH_MS,
} from "@codecast/sessions/agentStatus";

type StatusStamps = {
  agent_status?: string;
  agent_status_updated_at?: number;
  agent_status_write_at?: number;
};

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

// A status write older than the last applied one, or a different status at the
// same instant, loses.
export function statusWriteIsStale(
  session: StatusStamps,
  status: string,
  clientTs?: number,
): boolean {
  const previous =
    session.agent_status_write_at ?? session.agent_status_updated_at;
  return (
    clientTs !== undefined &&
    previous !== undefined &&
    (clientTs < previous ||
      (clientTs === previous && status !== session.agent_status))
  );
}
