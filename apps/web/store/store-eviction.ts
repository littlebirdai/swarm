import { cacheEvictionEnabled, withCacheEvictions } from "./cache-eviction";
import {
  detailRowsToEvict,
  isDetailPinned,
  type DetailKey,
} from "../lib/detail-rows";
import { sessionIdleAt } from "../lib/liveness";
import { REPLICATION_CLASSIFICATION } from "./clientSyncRegistry";
import { noteEvictedRows } from "./idb-collection-diff";
import type { InboxStoreState } from "./inboxStore";

export const MESSAGE_CACHE_BUDGET_BYTES =
  (globalThis.navigator?.product === "ReactNative" ? 16 : 32) * 1024 * 1024;

const MESSAGE_CACHE_LOW_WATER_BYTES = MESSAGE_CACHE_BUDGET_BYTES * 0.75;

export const MESSAGE_CACHE_PAGE_OVERHEAD = 64;

export const messageWarmState = {
  full: false,
  coldIds: new Set<string>(),
  inlineEvictedAtCount: new Map<string, number>(),
  inFlight: new Set<string>(),
  rowTried: new Set<string>(),
  syncedCount: new Map<string, number>(),
};

export function messageRowBytes(value: unknown): number {
  if (typeof value === "string") return 24 + value.length * 2;
  if (value === null || typeof value !== "object") return 8;
  let bytes = 32;
  for (const child of Object.values(value)) bytes += 8 + messageRowBytes(child);
  return bytes;
}

export function omitRedundantInlineImages<
  Row extends { images?: Array<{ storage_id?: string; data?: string }> },
>(rows: Row[]): Row[] {
  let compacted: Row[] | undefined;
  for (const [index, row] of rows.entries()) {
    if (!row.images?.some((image) => image?.storage_id && image.data)) continue;
    compacted ??= rows.slice();
    compacted[index] = {
      ...row,
      images: row.images.map((image) => {
        if (!image?.storage_id || !image.data) return image;
        const { data: _data, ...reference } = image;
        return reference;
      }),
    };
  }
  return compacted ?? rows;
}

type MessageCacheDraft = Pick<
  InboxStoreState,
  | "messages"
  | "pagination"
  | "userMessages"
  | "pendingMessages"
  | "queuedMessages"
  | "pendingSessionCreates"
  | "sessions"
  | "currentConversation"
  | "currentSessionId"
  | "sidePanelSessionId"
  | "viewingDismissedId"
  | "pendingNavigateId"
  | "messageCacheBytes"
  | "messageCacheBytesByConversation"
  | "inlineImageConversationIds"
  | "_lastViewedAt"
>;

const openViews = new Map<string, number>();

export function retainOpenMessageView(id: string): () => void {
  openViews.set(id, (openViews.get(id) ?? 0) + 1);
  let retained = true;
  return () => {
    if (!retained) return;
    retained = false;
    const count = openViews.get(id) ?? 0;
    if (count <= 1) openViews.delete(id);
    else openViews.set(id, count - 1);
  };
}

export function adjustMessageCacheBytes(
  draft: MessageCacheDraft,
  id: string,
  delta: number,
): void {
  if (!delta) return;
  const bytes = (draft.messageCacheBytesByConversation[id] ?? 0) + delta;
  if (bytes) draft.messageCacheBytesByConversation[id] = bytes;
  else delete draft.messageCacheBytesByConversation[id];
  draft.messageCacheBytes += delta;
}

export function dropCachedMessages(draft: MessageCacheDraft, id: string): void {
  delete draft.messages[id];
  delete draft.pagination[id];
  delete draft.userMessages[id];
  delete draft.inlineImageConversationIds[id];
  adjustMessageCacheBytes(
    draft,
    id,
    -(draft.messageCacheBytesByConversation[id] ?? 0),
  );
}

export function rekeyCachedMessages(
  draft: MessageCacheDraft,
  oldId: string,
  newId: string,
): void {
  const movePage = <Row extends object>(
    pages: Record<string, Row[]>,
    replace: boolean,
  ) => {
    const moved = pages[oldId];
    if (!moved) return;
    const existing = pages[newId];
    if (existing) {
      let bytes = MESSAGE_CACHE_PAGE_OVERHEAD;
      for (const row of replace ? existing : moved)
        bytes += messageRowBytes(row);
      adjustMessageCacheBytes(draft, replace ? newId : oldId, -bytes);
    }
    if (replace || !existing) pages[newId] = moved;
    delete pages[oldId];
  };
  movePage(draft.messages, true);
  movePage(draft.userMessages, false);
  const bytes = draft.messageCacheBytesByConversation[oldId] ?? 0;
  if (bytes) {
    draft.messageCacheBytesByConversation[newId] =
      (draft.messageCacheBytesByConversation[newId] ?? 0) + bytes;
    delete draft.messageCacheBytesByConversation[oldId];
  }
  if (
    Object.hasOwn(draft.inlineImageConversationIds, oldId) ||
    Object.hasOwn(draft.inlineImageConversationIds, newId)
  ) {
    delete draft.inlineImageConversationIds[oldId];
    updateInlineImageIndex(draft, newId);
  }
}

function sessionProtectsMessages(
  session: MessageCacheDraft["sessions"][string] | undefined,
  now: number,
): boolean {
  return !!session && (session.has_pending || !sessionIdleAt(session, now));
}

function canEvictMessages(
  state: MessageCacheDraft,
  id: string,
  now: number,
): boolean {
  if (
    openViews.has(id) ||
    messageWarmState.inFlight.has(id) ||
    id === state.currentConversation?.conversationId ||
    id === state.currentSessionId ||
    id === state.sidePanelSessionId ||
    id === state.viewingDismissedId ||
    id === state.pendingNavigateId ||
    state.pendingMessages[id]?.length ||
    state.queuedMessages[id]?.length ||
    Object.hasOwn(state.pendingSessionCreates, id)
  )
    return false;
  return !sessionProtectsMessages(state.sessions[id], now);
}

function hasInlineOnlyImages(state: MessageCacheDraft, id: string): boolean {
  const containsInline = (
    rows?: Array<{ images?: Array<{ storage_id?: string; data?: string }> }>,
  ) =>
    rows?.some((row) =>
      row.images?.some((image) => image?.data && !image.storage_id),
    );
  return !!(
    containsInline(state.messages[id]) || containsInline(state.userMessages[id])
  );
}

function updateInlineImageIndex(draft: MessageCacheDraft, id: string): void {
  const indexed = Object.hasOwn(draft.inlineImageConversationIds, id);
  const hasImages = hasInlineOnlyImages(draft, id);
  if (indexed === hasImages) return;
  if (hasImages) draft.inlineImageConversationIds[id] = true;
  else delete draft.inlineImageConversationIds[id];
}

export function hasEvictableMessagesOverBudget(
  state: MessageCacheDraft,
  releasedId?: string,
): boolean {
  const overBudget = state.messageCacheBytes > MESSAGE_CACHE_BUDGET_BYTES;
  if (!overBudget && !releasedId) return false;
  const now = Date.now();
  if (
    releasedId &&
    canEvictMessages(state, releasedId, now) &&
    Object.hasOwn(state.inlineImageConversationIds, releasedId)
  )
    return true;
  if (!overBudget) return false;
  return Object.keys(state.messageCacheBytesByConversation).some((id) =>
    canEvictMessages(state, id, now),
  );
}

export function releasedInlineMessageIds(state: MessageCacheDraft): string[] {
  const now = Date.now();
  return Object.keys(state.inlineImageConversationIds).filter((id) =>
    canEvictMessages(state, id, now),
  );
}

export function queueMessageCacheTrim(
  state: MessageCacheDraft,
  prev: MessageCacheDraft,
  trim: (releasedIds: readonly string[]) => void,
): void {
  if (!state.messageCacheBytes) return;
  const protectionChanged =
    state.sessions !== prev.sessions ||
    state.pendingMessages !== prev.pendingMessages ||
    state.queuedMessages !== prev.queuedMessages ||
    state.pendingSessionCreates !== prev.pendingSessionCreates ||
    state.currentSessionId !== prev.currentSessionId ||
    state.currentConversation !== prev.currentConversation ||
    state.sidePanelSessionId !== prev.sidePanelSessionId ||
    state.viewingDismissedId !== prev.viewingDismissedId ||
    state.pendingNavigateId !== prev.pendingNavigateId;
  if (!protectionChanged) return;
  const released = releasedInlineMessageIds(state);
  if (released.length || hasEvictableMessagesOverBudget(state))
    queueMicrotask(() => trim(released));
}

export function evictInactiveMessages(
  draft: MessageCacheDraft,
  writtenId?: string,
  releasedIds?: readonly string[],
): void {
  const overBudget = draft.messageCacheBytes > MESSAGE_CACHE_BUDGET_BYTES;
  const now = Date.now();
  if (writtenId) updateInlineImageIndex(draft, writtenId);
  const ids = writtenId
    ? [writtenId]
    : (releasedIds ?? Object.keys(draft.inlineImageConversationIds));
  for (const id of ids) {
    if (
      Object.hasOwn(draft.inlineImageConversationIds, id) &&
      canEvictMessages(draft, id, now)
    ) {
      messageWarmState.inlineEvictedAtCount.set(
        id,
        draft.sessions[id]?.message_count ?? 0,
      );
      dropCachedMessages(draft, id);
      if (overBudget) messageWarmState.full = true;
    }
  }
  if (draft.messageCacheBytes <= MESSAGE_CACHE_BUDGET_BYTES) return;

  const viewedAt = draft._lastViewedAt;
  const candidates = Object.keys(draft.messageCacheBytesByConversation)
    .filter((id) => id !== writtenId && canEvictMessages(draft, id, now))
    .sort(
      (a, b) =>
        (viewedAt[a] ?? 0) - (viewedAt[b] ?? 0) ||
        (draft.sessions[a]?.updated_at ?? 0) -
          (draft.sessions[b]?.updated_at ?? 0),
    );

  for (const id of candidates) {
    dropCachedMessages(draft, id);
    messageWarmState.full = true;
    if (draft.messageCacheBytes <= MESSAGE_CACHE_LOW_WATER_BYTES) break;
  }
  if (
    writtenId &&
    draft.messageCacheBytes > MESSAGE_CACHE_BUDGET_BYTES &&
    canEvictMessages(draft, writtenId, now)
  ) {
    dropCachedMessages(draft, writtenId);
    messageWarmState.full = true;
  }
}

/**
 * Hold a detail collection to its cap while the window lives (lib/detailRows
 * DETAIL_ROW_CAPS): after a write that added rows, drop the least recently
 * opened ones past the cap. Never a row a surface in this window has on
 * screen, or one with an unsent write (a thread holding an optimistic
 * comment, a pending entry of its own); a row this write brought goes only
 * when the write alone is over the cap. Without this
 * the caps held only at boot, and a window left open kept the detail of every
 * pull request and every line project it ever showed.
 */
/** A thread holding a comment this window wrote and has not seen come back: its id is still the optimistic `temp_` one. */
export function holdsUnsentComment(
  row: { comments?: Array<{ _id?: unknown }> } | undefined,
): boolean {
  return !!row?.comments?.some(
    (c) => typeof c?._id === "string" && c._id.startsWith("temp_"),
  );
}

export function evictDetailRows(
  getState: () => InboxStoreState,
  key: DetailKey,
  justWritten: readonly unknown[],
): void {
  const st = getState();
  const rows = (st[key] ?? {}) as Record<
    string,
    { _cachedAt?: number; comments?: Array<{ _id?: unknown }> }
  >;
  const fresh = new Set(justWritten.map((row: any) => String(row?._id)));
  let unsent: Set<string> | null = null;
  const hasUnsentWrite = (id: string) => {
    if (holdsUnsentComment(rows[id])) return true;
    if (!unsent) {
      unsent = new Set();
      const prefix = `${key}:`;
      for (const k in st.pending ?? {})
        if (k.startsWith(prefix))
          unsent.add(k.slice(prefix.length).split(":")[0]);
    }
    return unsent.has(id);
  };
  const gone = detailRowsToEvict(key, rows, hasUnsentWrite, (id) =>
    fresh.has(id),
  );
  if (!gone.length) return;
  if (cacheEvictionEnabled()) {
    const current = getState();
    const live = current[key] as typeof rows;
    const pending = Object.keys(current.pending);
    const evictions = gone
      .filter(
        (id) =>
          live[id] === rows[id] &&
          !isDetailPinned(key, id) &&
          !holdsUnsentComment(live[id]) &&
          !pending.some(
            (entry) =>
              entry === `${key}:${id}` || entry.startsWith(`${key}:${id}:`),
          ),
      )
      .map((id) => ({ key, id, observed: rows[id] }));
    if (evictions.length)
      withCacheEvictions(evictions, () => {
        current.dropRows(
          key,
          evictions.map(({ id }) => id),
        );
      });
    return;
  }
  // The rows leave disk too, where this window is the one that writes them:
  // the sync host for a shared key, any window for a per-window one.
  if (st.syncRole === "host" || REPLICATION_CLASSIFICATION[key] === "local")
    noteEvictedRows(key, gone);
  st.dropRows(key, gone);
}
