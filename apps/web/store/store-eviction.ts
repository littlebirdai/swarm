import { detailRowsToEvict, type DetailKey } from "../lib/detailRows";
import { sessionIdleAt } from "../lib/liveness";
import { REPLICATION_CLASSIFICATION } from "./clientSyncRegistry";
import { noteEvictedRows } from "./idb-collection-diff";
import type { InboxStoreState } from "./inboxStore";

export const MESSAGE_CACHE_BUDGET_BYTES =
  (globalThis.navigator?.product === "ReactNative" ? 16 : 32) * 1024 * 1024;

export const MESSAGE_CACHE_LOW_WATER_BYTES = MESSAGE_CACHE_BUDGET_BYTES * 0.75;

export const MESSAGE_CACHE_PAGE_OVERHEAD = 64;

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
}

function canEvictMessages(
  state: MessageCacheDraft,
  id: string,
  now: number,
): boolean {
  if (
    openViews.has(id) ||
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
  const session = state.sessions[id];
  return !session || (!session.has_pending && sessionIdleAt(session, now));
}

export function hasEvictableMessagesOverBudget(
  state: MessageCacheDraft,
): boolean {
  if (state.messageCacheBytes <= MESSAGE_CACHE_BUDGET_BYTES) return false;
  const now = Date.now();
  return Object.keys(state.messageCacheBytesByConversation).some((id) =>
    canEvictMessages(state, id, now),
  );
}

export function evictInactiveMessages(
  draft: MessageCacheDraft,
  writtenId?: string,
): void {
  if (draft.messageCacheBytes <= MESSAGE_CACHE_BUDGET_BYTES) return;

  const now = Date.now();
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
    if (draft.messageCacheBytes <= MESSAGE_CACHE_LOW_WATER_BYTES) break;
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
  st: InboxStoreState,
  key: DetailKey,
  justWritten: readonly unknown[],
): void {
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
  // The rows leave disk too, where this window is the one that writes them:
  // the sync host for a shared key, any window for a per-window one.
  if (st.syncRole === "host" || REPLICATION_CLASSIFICATION[key] === "local")
    noteEvictedRows(key, gone);
  st.dropRows(key, gone);
}
