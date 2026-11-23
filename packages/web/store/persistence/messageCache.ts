import { captureException } from "@sentry/react";
import { persistedMessageTail } from "../cacheRetention";
import { _hydrating } from "./collectionWriter";
import { db } from "./db";
import { persistenceOwned } from "./ownership";

// IDB writes are coalesced per conversation. setMessages fires on nearly every
// live-sync tick for the focused conversation, and each write serializes the
// ENTIRE conversation — message bodies carry inline images, so a single put can
// be multiple MB. Writing the whole thing on every appended message is pure
// waste: this row is a reload cache, not the live source of truth (the in-memory
// store is, and it still updates synchronously). We keep only the latest payload
// per conv and flush on a short trailing timer, collapsing a burst of N ticks
// into one write. The timer is scheduled once per burst (not reset on each
// write), so a continuous stream still flushes at most every DEBOUNCE_MS rather
// than starving. Reads consult the pending buffer first for read-your-writes,
// and page-hide flushes so an abrupt close still persists the freshest state.
type MessageSnapshot = { messages: any[]; pagination: any };
const _pendingMsgWrites = new Map<string, MessageSnapshot>();
const _inFlightMsgWrites = new Set<string>();
let _msgWriteTimer: ReturnType<typeof setTimeout> | null = null;
const MSG_WRITE_DEBOUNCE_MS = 300;

// On-disk prune of the conversationMessages store. Every conversation ever opened
// leaves a row (up to several MB with inline images) and nothing ever deleted it,
// so the store climbed unbounded (~445MB in a past incident). We cap it at the N
// most-recently-active conversations and drop anything past a TTL, ordered by the
// latestTimestamp index. Runs lazily off the write path — piggybacked on the
// debounced flush and throttled — never on the hot per-tick path. The cap sits
// near the session-row cache floor (partitionSessionRetention keeps ~1200 rows):
// a row the list can show should have its tail on disk, so the click is local.
const MAX_CACHED_CONVERSATIONS = 1000;
const CONVERSATION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const PRUNE_THROTTLE_MS = 5 * 60 * 1000; // at most once per 5 min
const PROTECT_RECENT_MS = 10 * 60 * 1000; // never prune a conv touched this recently
// Wall-clock of the last write per conversation — a conversation open/on-screen is
// written continuously, so a recent touch marks it protected from pruning even if
// its newest message (its latestTimestamp) is old.
const _touchedAt = new Map<string, number>();
let _lastPruneAt = 0;

function _latestTs(messages: any[]): number {
  // Loop, not Math.max(...spread): spreading a long messages array risks a
  // call-stack overflow, and this now runs once per flush instead of per tick.
  let latest = 0;
  for (const m of messages) {
    const t = m?.timestamp || 0;
    if (t > latest) latest = t;
  }
  return latest;
}

function _flushMessageWrites(immediate = false) {
  if (_msgWriteTimer) {
    clearTimeout(_msgWriteTimer);
    _msgWriteTimer = null;
  }
  if (_pendingMsgWrites.size === 0) return;
  for (const [convId, snapshot] of _pendingMsgWrites) {
    if (_inFlightMsgWrites.has(convId)) continue;
    void _writeMessageSnapshot(convId, snapshot);
    if (!immediate) {
      if (_pendingMsgWrites.size > _inFlightMsgWrites.size) _scheduleMessageWrites(0);
      break;
    }
  }
  _maybePruneConversations();
}

async function _writeMessageSnapshot(convId: string, snapshot: MessageSnapshot) {
  _inFlightMsgWrites.add(convId);
  try {
    const { messages, pagination } = snapshot;
    const tail = persistedMessageTail(messages, pagination);
    await db.conversationMessages.put({ convId, messages: tail.messages, pagination: tail.pagination, latestTimestamp: _latestTs(tail.messages) });
    if (_pendingMsgWrites.get(convId) === snapshot) _pendingMsgWrites.delete(convId);
  } catch (error) {
    captureException(error, { tags: { source: "conversation-cache" } });
  } finally {
    _inFlightMsgWrites.delete(convId);
    const pending = _pendingMsgWrites.get(convId);
    if (pending && pending !== snapshot) _scheduleMessageWrites();
  }
}

function _scheduleMessageWrites(delay = MSG_WRITE_DEBOUNCE_MS) {
  if (!_msgWriteTimer) _msgWriteTimer = setTimeout(_flushMessageWrites, delay);
}

// Drop conversationMessages rows beyond the cap (oldest by latestTimestamp) and
// past the TTL, skipping any conversation currently buffered or recently touched
// (open/on-screen). Reads only primary keys off the latestTimestamp index, so the
// multi-MB message payloads are never loaded; best-effort and never throws.
async function _pruneConversations() {
  try {
    const now = Date.now();
    const protectedIds = new Set<string>(_pendingMsgWrites.keys());
    for (const [convId, ts] of _touchedAt) {
      if (now - ts <= PROTECT_RECENT_MS) protectedIds.add(convId);
      else _touchedAt.delete(convId); // let the recency map self-bound
    }

    // One WRITABLE transaction, even when nothing gets deleted. Each flush of a
    // streaming conversation moves its latestTimestamp and strands the old index
    // entry; Chromium deletes those dead entries as a cursor steps over them, but
    // only in a writable transaction. Read-only, this walk re-paid for every
    // entry stranded since boot (153ms for 1000 rows in a day-old tab, 9ms by
    // primary key); writable, each prune pays only for the churn since the last.
    await db.transaction("rw", db.conversationMessages, db.conversationUserMessages, async () => {
      // Ascending by latestTimestamp (oldest first); everything past the cap is the
      // least-recently-active tail. primaryKeys() reads the index only, not the rows.
      const orderedKeys = await db.conversationMessages.orderBy("latestTimestamp").primaryKeys();
      const overCap =
        orderedKeys.length > MAX_CACHED_CONVERSATIONS
          ? orderedKeys.slice(0, orderedKeys.length - MAX_CACHED_CONVERSATIONS)
          : [];
      const expired = await db.conversationMessages
        .where("latestTimestamp")
        .below(now - CONVERSATION_TTL_MS)
        .primaryKeys();

      const doomed = new Set<string>([...overCap, ...expired]);
      for (const id of protectedIds) doomed.delete(id);
      if (doomed.size > 0) {
        const ids = [...doomed];
        await db.conversationMessages.bulkDelete(ids);
        await db.conversationUserMessages.bulkDelete(ids);
      }
    });
  } catch {
    // Maintenance is best-effort — the durable cache tolerates skipped prunes.
  }
}

function _maybePruneConversations() {
  const now = Date.now();
  if (now - _lastPruneAt < PRUNE_THROTTLE_MS) return;
  _lastPruneAt = now;
  void _pruneConversations();
}

// Flush any buffered conversation writes immediately (e.g. on page hide).
export function flushConversationMessages() {
  _flushMessageWrites(true);
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushConversationMessages);
  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushConversationMessages();
  });
}

export type CachedConversation = {
  messages: any[];
  pagination: any;
  latestTimestamp: number;
  // Present when the navigator list was persisted for this conversation.
  userMessages?: any[];
};

async function _loadUserMessages(convId: string): Promise<any[] | undefined> {
  try {
    return (await db.conversationUserMessages.get(convId))?.userMessages;
  } catch {
    return undefined;
  }
}

export async function loadConversationMessages(convId: string): Promise<CachedConversation | null> {
  // Read-your-writes: a just-written-but-not-yet-flushed payload is the freshest
  // truth, so serve it before falling back to the persisted IDB row.
  const userMessages = await _loadUserMessages(convId);
  const pending = _pendingMsgWrites.get(convId);
  if (pending) {
    const tail = persistedMessageTail(pending.messages, pending.pagination);
    return { messages: tail.messages, pagination: tail.pagination, latestTimestamp: _latestTs(tail.messages), userMessages };
  }
  try {
    const row = await db.conversationMessages.get(convId);
    // A conversation whose navigator list landed before any message page did
    // still hydrates that list; the caller treats empty messages as a miss.
    if (!row) return userMessages ? { messages: [], pagination: undefined, latestTimestamp: 0, userMessages } : null;
    return { messages: row.messages, pagination: row.pagination, latestTimestamp: row.latestTimestamp, userMessages };
  } catch {
    return null;
  }
}

// Small row, written straight through: the store already dedups no-op ticks
// (setUserMessages), so every call here is a real change.
export function writeConversationUserMessages(convId: string, userMessages: any[]) {
  if (_hydrating || !persistenceOwned()) return;
  _touchedAt.set(convId, Date.now());
  db.conversationUserMessages.put({ convId, userMessages }).catch(() => {});
}

export function writeConversationMessages(convId: string, messages: any[], pagination: any) {
  if (_hydrating || !persistenceOwned()) return;
  _touchedAt.set(convId, Date.now());
  _pendingMsgWrites.set(convId, { messages, pagination });
  if (!_inFlightMsgWrites.has(convId)) _scheduleMessageWrites();
}

export function dropPendingMessageWrites() {
  _pendingMsgWrites.clear();
}
