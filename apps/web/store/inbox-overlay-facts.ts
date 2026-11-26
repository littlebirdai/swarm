import {
  inWorkingSet,
  LIVE_INBOX_LEASE_END,
  WORKING_SET_RECENCY_MS,
  type InboxProjection,
  type WorkingSetRow,
} from "@codecast/inbox/inboxProjection";
import { HEARTBEAT_ALIVE_MS } from "@codecast/sessions/agentStatus";
import { isSessionKilled } from "../lib/sessionRetirement";
import type { InboxSession } from "./inboxStore";
import {
  INBOX_FACT_FIELDS,
  INBOX_PROJECTION_FIELDS,
} from "@codecast/inbox/inboxFields";
import { applySyncPatch, type PendingEntry } from "./syncProtocol";

const SESSIONS_STRIP_FIELD_SET: ReadonlySet<string> = new Set(
  INBOX_PROJECTION_FIELDS,
);
const INBOX_FACT_FIELD_SET: ReadonlySet<string> = new Set(INBOX_FACT_FIELDS);

// The one fact merge: an overlay row's FACTS onto a session row, field by
// field (stamps never reach a row), leaving an unchanged row's identity alone.
// An overlay row is the fact writer for its row, so every fact field it does
// not carry reads as null — never "keep what was there": the server's trusted
// status is undefined once the managed row is gone, the key is absent from
// the payload, and a stale "stopped" would otherwise outlive it and file a
// declared-done session under Needs You on this replica alone.
export function mergeOverlayFacts(
  target: Record<string, unknown>,
  incoming: Record<string, unknown>,
  pending: Record<string, PendingEntry>,
): Record<string, PendingEntry> {
  const { fields: facts, pending: nextPending } = applySyncPatch(
    "sessions",
    String(target._id),
    {
      ...Object.fromEntries(
        INBOX_FACT_FIELDS.map((key) => [key, incoming[key] ?? null]),
      ),
      ...incoming,
    },
    [],
    pending,
  );
  // An equal structured fact keeps the row's own object: a decoded payload
  // hands every one over fresh, and a new identity reads as a change to every
  // reader that compares by reference (row memos, wake signatures).
  for (const key of INBOX_FACT_FIELDS) {
    const next = facts[key] === undefined ? null : facts[key];
    if (!sameOverlayValue(target[key], next)) target[key] = next;
  }
  for (const key in facts) {
    if (SESSIONS_STRIP_FIELD_SET.has(key) || INBOX_FACT_FIELD_SET.has(key))
      continue;
    if (!sameOverlayValue(target[key], facts[key])) target[key] = facts[key];
  }
  return nextPending;
}

// True when merging `incoming` onto `base` would change nothing. An overlay
// payload carries the whole live set (~600 rows) on every push, and almost
// every row repeats the last one. The merge reads and writes through mutative
// draft proxies and looks each field up in the pending map: on a phone that
// was a quarter of the JS thread's busy time after a signed in launch. This
// check reads only plain objects, so an unchanged row never touches the draft.
// Mirrors mergeOverlayFacts: an absent fact reads as null, stamps are skipped.
export function overlayRowUnchanged(
  base: Record<string, unknown>,
  incoming: Record<string, unknown>,
): boolean {
  for (const key of INBOX_FACT_FIELDS) {
    if (!sameOverlayValue(base[key], incoming[key] ?? null)) return false;
  }
  for (const key in incoming) {
    if (SESSIONS_STRIP_FIELD_SET.has(key) || INBOX_FACT_FIELD_SET.has(key))
      continue;
    if (!sameOverlayValue(base[key], incoming[key])) return false;
  }
  return true;
}
function sameOverlayValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  // The few structured facts (open_tasks, activity) arrive as fresh objects.
  if (
    a === null ||
    b === null ||
    typeof a !== "object" ||
    typeof b !== "object"
  )
    return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

export function expireOmittedInboxLeases(
  sessions: Record<string, InboxSession>,
  baseSessions: Readonly<Record<string, InboxSession>>,
  liveness: Record<string, unknown>,
  projection: InboxProjection,
  isForeign: (row: InboxSession, viewerId: string) => boolean,
  workingSetRowOf: (row: InboxSession) => WorkingSetRow,
): void {
  const { user_id: viewerId, scope, team_id: teamId, epoch } = projection;
  if (typeof viewerId !== "string") return;
  const truncated = new Set(
    Array.isArray(projection.truncated) ? projection.truncated : [],
  );
  for (const id in baseSessions) {
    const base = baseSessions[id];
    if (
      (base.liveness_lease_end !== LIVE_INBOX_LEASE_END &&
        base.daemon_alive_until !== LIVE_INBOX_LEASE_END) ||
      Object.hasOwn(liveness, id)
    )
      continue;
    if (!ownsOmittedRow(base)) continue;

    const heartbeatEnd =
      base.last_heartbeat == null
        ? null
        : base.last_heartbeat + HEARTBEAT_ALIVE_MS;
    const leaseEnd =
      truncated.size > 0 &&
      Number.isFinite(epoch) &&
      !isSessionKilled(base) &&
      base.status !== "archived" &&
      couldBeTruncated(base)
        ? Math.max(heartbeatEnd ?? 0, epoch + HEARTBEAT_ALIVE_MS)
        : null;
    sessions[id].liveness_lease_end = leaseEnd;
    sessions[id].daemon_alive_until = leaseEnd ?? heartbeatEnd;
  }

  function ownsOmittedRow(row: InboxSession): boolean {
    const foreign = isForeign(row, viewerId);
    return scope === "mine"
      ? !foreign || (row.team_id == null && row.user_id === viewerId)
      : scope === "team" &&
          foreign &&
          typeof teamId === "string" &&
          row.team_id === teamId;
  }

  function couldBeTruncated(row: InboxSession): boolean {
    if (windowCouldHold(row)) return true;
    const parentId = row.is_subagent && row.parent_conversation_id;
    if (!parentId || row.message_count <= 0) return false;
    const parent = baseSessions[parentId];
    if (
      parent &&
      !Object.hasOwn(liveness, parentId) &&
      ownsOmittedRow(parent) &&
      windowCouldHold(parent)
    )
      return true;
    const workingRow = workingSetRowOf(row);
    return (
      scope === "mine" &&
      truncated.has("subagents") &&
      row.updated_at >= epoch - WORKING_SET_RECENCY_MS &&
      (workingRow.status === "active" || workingRow.status === "completed") &&
      !workingRow.inbox_pinned_at &&
      !row.inbox_dismissed_at &&
      !row.inbox_stashed_at &&
      !row.inbox_snoozed_until
    );
  }

  function windowCouldHold(row: InboxSession): boolean {
    if (isSessionKilled(row) || row.status === "archived") return false;
    const workingRow = workingSetRowOf(row);
    const windows = inWorkingSet(workingRow, epoch);
    if (scope === "mine")
      return windows.some((window) => truncated.has(window));
    if (
      scope !== "team" ||
      (!truncated.has("members") && !truncated.has("member_rows"))
    )
      return false;
    return (
      windows.includes("recent") ||
      (windows.includes("pinned") &&
        row.updated_at >= epoch - WORKING_SET_RECENCY_MS &&
        (workingRow.status === "active" || workingRow.status === "completed"))
    );
  }
}
