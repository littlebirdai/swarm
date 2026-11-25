import { detailRowsToEvict, type DetailKey } from "../lib/detailRows";
import { REPLICATION_CLASSIFICATION } from "./clientSyncRegistry";
import { noteEvictedRows } from "./idbCollectionDiff";
import type { InboxStoreState } from "./inboxStore";

type MessageEvictionDraft = {
  messages: Record<string, unknown>;
  pagination: Record<string, unknown>;
  userMessages: Record<string, unknown>;
  pendingMessages: Record<string, readonly unknown[]>;
  currentConversation: { conversationId?: string | null } | null;
  currentSessionId: string | null;
  sidePanelSessionId: string | null;
  viewingDismissedId: string | null;
  warmProtectedIds?: ReadonlySet<string>;
  liveInboxIds?: ReadonlySet<string>;
  _lastViewedAt?: Record<string, number>;
};

// Max conversations to keep messages for in the in-memory store. Generous on
// purpose — instant switching across a lot of recent conversations is the point —
// but bounded, because the store never prunes and message bodies carry inline
// images. Evicted conversations stay in IDB and reload instantly.
export const MAX_IN_MEMORY_CONVERSATIONS = 400;

export function evictInactiveMessages(
  draft: MessageEvictionDraft,
  activeConvId: string,
) {
  const loaded = Object.keys(draft.messages);
  if (loaded.length <= MAX_IN_MEMORY_CONVERSATIONS) return;

  const currentConvId = draft.currentConversation?.conversationId;
  // Never evict whatever is actually on screen...
  const keep = new Set(
    [
      activeConvId,
      currentConvId,
      draft.currentSessionId,
      draft.sidePanelSessionId,
      draft.viewingDismissedId,
    ].filter((id): id is string => Boolean(id)),
  );

  // ...nor the rows on screen (the warm loop's published set), so switching to
  // anything the user can see is instant. Before the first warm pass the live
  // inbox set stands in for it.
  //
  // We deliberately do NOT protect every id in draft.sessions. That map never
  // prunes (a session you've opened stays forever), so keeping messages for all
  // of them defeated this LRU entirely: every conversation ever opened was pinned
  // in memory, letting the store balloon to multiple GB over a few days of use.
  // Nor the whole live inbox set once the on-screen set exists: the live window
  // outgrew the cap (~870 rows vs 400), so protecting it left zero slack — every
  // row OUTSIDE it (exactly what the flat "All" view and the show-old fold add)
  // was evicted the moment the next one loaded, and the All view could never
  // hold a warm tail. The cap above is the real bound; anything past it reloads
  // from IDB on click.
  const shown: ReadonlySet<string> | undefined = draft.warmProtectedIds?.size
    ? draft.warmProtectedIds
    : draft.liveInboxIds;
  if (shown) for (const id of shown) keep.add(id);

  // Evict least-recently-viewed first
  // Never evict conversations with pending messages — the user just sent something
  // and evicting would make it vanish from the UI
  const viewedAt = draft._lastViewedAt || {};
  const candidates = loaded
    .filter(
      (id: string) => !keep.has(id) && !(draft.pendingMessages[id]?.length > 0),
    )
    .sort((a: string, b: string) => (viewedAt[a] ?? 0) - (viewedAt[b] ?? 0));

  const toEvict = candidates.slice(
    0,
    loaded.length - MAX_IN_MEMORY_CONVERSATIONS,
  );
  for (const id of toEvict) {
    delete draft.messages[id];
    // NEVER evict pendingMessages — these are the user's outbound messages
    // and must survive until confirmed by the server
    delete draft.pagination[id];
    delete draft.userMessages[id];
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
