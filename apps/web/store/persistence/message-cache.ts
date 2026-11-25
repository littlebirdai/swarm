import type { CachedConversation } from "./storage";
import { captureException } from "@sentry/react";
import Dexie from "dexie";
import { MESSAGE_PAGE_SIZE, persistedMessageTail } from "../cacheRetention";
import { sameValue } from "../sameValue";
import { db, type ConversationMessageRow } from "./db";
import { _hydrating, takeBootReadPhase } from "./hydration";
import { diffMessageTail } from "./messageTailDiff";
import { persistenceOwned } from "./ownership";
import { deleteInBatches, RETENTION_DELETE_BATCH } from "./retention";
import { storageTimings, timeBootRead } from "./storage-timings";
import type { BootPhase } from "./timing-samples";

// A continuous stream flushes at most once per interval. Keep the latest
// snapshot readable until its row edits and metadata commit together.
type MessageSnapshot = { messages: any[]; pagination: any };
let _pendingMsgWrites = new Map<string, MessageSnapshot>();
const _inFlightMsgWrites = new Set<string>();
let _msgWriteTimer: ReturnType<typeof setTimeout> | null = null;
const MSG_WRITE_DEBOUNCE_MS = 300;

// Hold a few hot tails for exact, mostly referential comparisons without
// keeping every inline image that was ever opened alive in memory.
const MESSAGE_SHADOW_LIMIT = 8;
const _messageShadows = new Map<string, Map<string, ConversationMessageRow>>();

// Prune off the debounced write path. The cap is near the session-row cache
// floor so a conversation the inbox can show usually has its tail on disk.
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
  if (!persistenceOwned() || _pendingMsgWrites.size === 0) return;
  for (const [convId, snapshot] of _pendingMsgWrites) {
    if (_inFlightMsgWrites.has(convId)) continue;
    void _writeMessageSnapshot(convId, snapshot);
    if (!immediate) {
      if (_pendingMsgWrites.size > _inFlightMsgWrites.size)
        _scheduleMessageWrites(0);
      break;
    }
  }
  _maybePruneConversations();
}

async function _writeMessageSnapshot(
  convId: string,
  snapshot: MessageSnapshot,
) {
  _inFlightMsgWrites.add(convId);
  const pending = _pendingMsgWrites;
  try {
    const tailStarted = performance.now();
    const { messages, pagination } = snapshot;
    const tail = persistedMessageTail(messages, pagination);
    const latestTimestamp = _latestTs(tail.messages);
    const tailMs = performance.now() - tailStarted;
    const { conversationMessageMeta: meta, conversationMessageRows: rows } = db;
    const committed = await db.transaction("rw", meta, rows, async () => {
      if (pending !== _pendingMsgWrites || !persistenceOwned()) return;
      const priorMeta = await meta.get(convId);
      // Read keys only on the hot path. A revision lets a transaction detect
      // writes from another window or a DB reset without reading image bodies.
      const shadow = _messageShadows.get(convId);
      const previous = new Map<string, ConversationMessageRow>();
      const missing: Array<[string, string]> = [];
      await rows
        .where("[convId+position+messageKey+revision]")
        .between([convId, Dexie.minKey], [convId, Dexie.maxKey])
        .eachKey((compoundKey) => {
          if (!Array.isArray(compoundKey)) return;
          const [, , key, revision] = compoundKey;
          if (typeof key !== "string" || typeof revision !== "string") return;
          const cached = shadow?.get(key);
          if (cached?.revision === revision) previous.set(key, cached);
          else missing.push([convId, key]);
        });
      if (missing.length) {
        for (const row of await rows.bulkGet(missing)) {
          if (row) previous.set(row.messageKey, row);
        }
      }

      const diffStarted = performance.now();
      const { puts, deletes, next } = diffMessageTail(previous, tail.messages);
      if (pending !== _pendingMsgWrites || !persistenceOwned()) return;
      const revision = puts.length
        ? crypto.getRandomValues(new Uint32Array(4)).join("-")
        : "";
      const rowPuts = puts.map((put) => ({ convId, revision, ...put }));
      const writeMeta =
        !priorMeta ||
        latestTimestamp !== priorMeta.latestTimestamp ||
        !sameValue(tail.pagination, priorMeta.pagination);
      if (deletes.length || rowPuts.length || writeMeta) {
        storageTimings.recordWrite(
          "message_prepare",
          tailMs + (performance.now() - diffStarted),
        );
      }
      if (deletes.length)
        await rows.bulkDelete(deletes.map((key) => [convId, key]));
      if (rowPuts.length) await rows.bulkPut(rowPuts);
      if (writeMeta) {
        await meta.put({
          convId,
          pagination: tail.pagination,
          latestTimestamp,
        });
      }

      for (const row of rowPuts) previous.set(row.messageKey, row);
      // Reuse the latest immutable refs even if the feeder rebuilt equal rows.
      return new Map(
        [...next].map(([key, row]) => [key, { ...previous.get(key)!, ...row }]),
      );
    });
    if (committed && pending === _pendingMsgWrites) {
      _messageShadows.delete(convId);
      _messageShadows.set(convId, committed);
      if (_messageShadows.size > MESSAGE_SHADOW_LIMIT) {
        const oldest = _messageShadows.keys().next().value;
        if (oldest !== undefined) _messageShadows.delete(oldest);
      }
    }
    if (pending.get(convId) === snapshot) pending.delete(convId);
  } catch (error) {
    captureException(error, { tags: { source: "conversation-cache" } });
  } finally {
    _inFlightMsgWrites.delete(convId);
    const newest = _pendingMsgWrites.get(convId);
    if (newest && newest !== snapshot) _scheduleMessageWrites();
  }
}

function _scheduleMessageWrites(delay = MSG_WRITE_DEBOUNCE_MS) {
  if (!_msgWriteTimer) _msgWriteTimer = setTimeout(_flushMessageWrites, delay);
}

// The writable index walk lets Chromium clean up entries stranded by timestamp
// updates. Delete whole conversations in batches that bound the number of rows
// in each transaction, rechecking touches and timestamps after the walk.
async function _pruneConversations() {
  try {
    const now = Date.now();
    const {
      conversationMessageMeta: meta,
      conversationMessageRows: rows,
      conversationUserMessages: userMessages,
    } = db;
    for (const [convId, ts] of _touchedAt) {
      if (now - ts > PROTECT_RECENT_MS) _touchedAt.delete(convId);
    }
    const pending = _pendingMsgWrites;
    const ordered = new Map<string, number>();
    await db.transaction("rw", meta, () =>
      meta.orderBy("latestTimestamp").eachKey((ts, cursor) => {
        ordered.set(cursor.primaryKey as string, ts as number);
      }),
    );
    const overCap = ordered.size - MAX_CACHED_CONVERSATIONS;
    const doomed: string[] = [];
    let index = 0;
    for (const [id, timestamp] of ordered) {
      if (
        (index++ < overCap || timestamp < now - CONVERSATION_TTL_MS) &&
        !_touchedAt.has(id) &&
        !_pendingMsgWrites.has(id)
      )
        doomed.push(id);
    }
    await deleteInBatches(
      {
        bulkDelete: (ids) =>
          db.transaction("rw", meta, rows, userMessages, async () => {
            if (pending !== _pendingMsgWrites || !persistenceOwned()) return;
            const current = await meta.bulkGet(ids);
            const drop = current.flatMap((row) =>
              row &&
              ordered.get(row.convId) === row.latestTimestamp &&
              !_touchedAt.has(row.convId) &&
              !_pendingMsgWrites.has(row.convId)
                ? [row.convId]
                : [],
            );
            if (!drop.length) return;
            const keys = await rows.where("convId").anyOf(drop).primaryKeys();
            await rows.bulkDelete(keys);
            await userMessages.bulkDelete(drop);
            await meta.bulkDelete(drop);
            for (const id of drop) _messageShadows.delete(id);
          }),
      },
      doomed,
      Math.floor(RETENTION_DELETE_BATCH / MESSAGE_PAGE_SIZE),
    );
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

async function _loadUserMessages(
  convId: string,
  phase: BootPhase | undefined,
): Promise<any[] | undefined> {
  try {
    return (
      await timeBootRead(phase, "conversationUserMessages", () =>
        db.conversationUserMessages.get(convId),
      )
    )?.userMessages;
  } catch {
    return undefined;
  }
}

export async function loadConversationMessages(
  convId: string,
): Promise<CachedConversation | null> {
  // Read-your-writes: a just-written-but-not-yet-flushed payload is the freshest
  // truth, so serve it before falling back to the persisted IDB row.
  const phase = takeBootReadPhase("focusedMessages");
  const userMessages = await _loadUserMessages(convId, phase);
  const pending = _pendingMsgWrites.get(convId);
  if (pending) {
    const tail = persistedMessageTail(pending.messages, pending.pagination);
    return {
      messages: tail.messages,
      pagination: tail.pagination,
      latestTimestamp: _latestTs(tail.messages),
      userMessages,
    };
  }
  try {
    const { conversationMessageMeta: meta, conversationMessageRows: rows } = db;
    return await db.transaction("r", meta, rows, async () => {
      const row = await timeBootRead(phase, "conversationMessageMeta", () =>
        meta.get(convId),
      );
      // A navigator list can arrive before the first message page.
      if (!row)
        return userMessages
          ? {
              messages: [],
              pagination: undefined,
              latestTimestamp: 0,
              userMessages,
            }
          : null;
      const ordered = await timeBootRead(phase, "conversationMessageRows", () =>
        rows
          .where("[convId+position+messageKey+revision]")
          .between([convId, Dexie.minKey], [convId, Dexie.maxKey])
          .toArray(),
      );
      return {
        messages: ordered.map((entry) => entry.message),
        pagination: row.pagination,
        latestTimestamp: row.latestTimestamp,
        userMessages,
      };
    });
  } catch {
    return null;
  }
}

// Small row, written straight through: the store already dedups no-op ticks
// (setUserMessages), so every call here is a real change.
export function writeConversationUserMessages(
  convId: string,
  userMessages: any[],
) {
  if (_hydrating || !persistenceOwned()) return;
  _touchedAt.set(convId, Date.now());
  db.conversationUserMessages.put({ convId, userMessages }).catch(() => {});
}

export function writeConversationMessages(
  convId: string,
  messages: any[],
  pagination: any,
) {
  if (_hydrating || !persistenceOwned()) return;
  _touchedAt.set(convId, Date.now());
  _pendingMsgWrites.set(convId, { messages, pagination });
  if (!_inFlightMsgWrites.has(convId)) _scheduleMessageWrites();
}

export function dropPendingMessageWrites() {
  if (_msgWriteTimer) clearTimeout(_msgWriteTimer);
  _msgWriteTimer = null;
  _pendingMsgWrites = new Map();
  _messageShadows.clear();
  _touchedAt.clear();
  _lastPruneAt = 0;
}
