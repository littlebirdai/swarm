import { rowSigExcluding } from "../store/wakeSig";

// Conversation fields that the daemon bumps on every ~1s heartbeat but that don't
// change what the conversation view renders (idle duration is cosmetic and recomputed
// from Date.now() on any render anyway). When two successive conversation objects
// differ ONLY in these fields we hand back the previous object reference, so a bare
// heartbeat no longer rebuilds `conversation` → re-renders the entire 11k-line
// ConversationView monolith (~120ms each, ~4–5×/sec for a live session).
const LIVENESS_ONLY_CONV_FIELDS = new Set([
  "updated_at",
  "last_heartbeat",
  "liveness_lease_end",
  "daemon_alive_until",
  "last_metrics_at",
  "last_active_at",
  "last_message_at",
]);
export function conversationRenderEqual(
  a: Record<string, any>,
  b: Record<string, any>,
): boolean {
  if (a === b) return true;
  // The message array is the primary render signal — a new/changed message must
  // always re-render (mergedMessages keeps a stable ref when nothing changed).
  if (a.messages !== b.messages) return false;
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  for (const k of aKeys) {
    if (LIVENESS_ONLY_CONV_FIELDS.has(k)) continue;
    if (!Object.is(a[k], b[k])) return false;
  }
  return true;
}

// conversationRenderEqual stabilizes the conversation OBJECT, but useTrackedStore
// still WAKES this hook whenever a subscribed row's Object.is identity changes —
// and syncTable hands the session/conversation rows a fresh identity on every
// ~1s liveness bump. A bare heartbeat would therefore re-render InboxConversation
// → ConversationDiffLayout → the (un-memoized) 11k-line ConversationView even
// though nothing visible changed. Subscribing to a SIGNATURE that ignores
// LIVENESS_ONLY_CONV_FIELDS makes a bare heartbeat inert at the source: the dep
// value is unchanged, so the hook never re-renders. Lossless for object-valued
// fields via a stable per-reference id — a real change to a nested object still
// flips the signature. Fail-safe denylist: omit a field and you re-render more
// often, never render stale.
// The single-row signature primitive lives in store/wakeSig.ts (rowSigExcluding);
// the inbox sidebar uses the collection variant (sessionsWakeSig) for the same
// reason. Keep the denylist here — it is conversation-specific.
export const metaWakeSig = (
  row: Record<string, any> | undefined | null,
): string => rowSigExcluding(row, LIVENESS_ONLY_CONV_FIELDS);
