import { desktopWindowKeys } from "./desktop-window-keys";
import type { StoreApi } from "zustand";
import type { InboxStoreState, Message } from "./inboxStore";
import { queuedMessagesFromPending } from "./pendingMessageJournal";
import { healTabPaths } from "../lib/tabRoutes";
import {
  declareViewNav,
  freshHomeLaunchPending,
  settleFreshHomeLaunch,
} from "./viewNav";
import {
  cacheFloorUnderSnapshot,
  keysWithSnapshotDrops,
} from "./idbCollectionDiff";
import {
  loadCache,
  loadPaintCacheSync,
  writePatchesToIDB,
  setHydrating,
  loadConversationMessages,
  enqueueDispatch,
  removeDispatch,
  loadOutbox,
  salvageLocalFirstV2Data,
  setUpgradeBlockedListener,
  PERSISTENCE_AVAILABLE,
} from "./idb-cache";
import {
  HYDRATION_CRITICAL_READ_KEYS,
  HYDRATION_CRITICAL_KEYS,
  HYDRATION_PAINT_KEYS,
  HYDRATION_DEFERRED_KEYS,
  hydrationMergeStrategy,
} from "./clientSyncRegistry";

type HydrationStore = Pick<StoreApi<InboxStoreState>, "getState" | "setState">;

export function hydrateConversation(
  useInboxStore: HydrationStore,
  convId: string,
  currentHydrationEpoch: () => number,
  _idbHydrating: Map<string, Promise<boolean>>,
  _userMsgsProbed: Set<string>,
): Promise<boolean> {
  const store = useInboxStore.getState();
  const epoch = currentHydrationEpoch();
  const hasMessages = store.messages[convId]?.length > 0;
  // Already in memory — nothing to hydrate
  if (
    hasMessages &&
    (store.userMessages[convId] || _userMsgsProbed.has(convId))
  )
    return Promise.resolve(true);
  // In-flight hydration — don't double-load
  const inflight = _idbHydrating.get(convId);
  if (inflight) return inflight;
  if (hasMessages) _userMsgsProbed.add(convId);
  const p = loadConversationMessages(convId)
    .then((cached) => {
      _idbHydrating.delete(convId);
      if (epoch !== currentHydrationEpoch()) return false;
      const s = useInboxStore.getState();
      if (cached?.userMessages && !s.userMessages[convId])
        s.setUserMessages(convId, cached.userMessages, "cache");
      if (!cached || cached.messages.length === 0) return hasMessages;
      if (s.messages[convId]?.length > 0) return true;
      s.setMessages(convId, cached.messages, cached.pagination, "cache");
      return true;
    })
    .catch(() => {
      _idbHydrating.delete(convId);
      // Never reinterpret a storage error as an authoritative empty conversation.
      return hasMessages;
    });
  _idbHydrating.set(convId, p);
  return p;
}

// Cache-as-floor hydration merge for id-keyed collections. IndexedDB rows are
// the base; whatever live data already landed in the store wins per-id. A
// windowed live payload — listInboxSessions' recent window, tasks.webList's
// take(300) — must never empty-gate out the full cached collection: that race
// (live fills the store before the deferred IDB hydration runs) is what made
// tasks/sessions collapse to the live window on every load and stream back in.
// Union-merge backfills the omitted rows while keeping live freshness; genuine
// deletions are reconciled by the reconcile crawl's authoritative onComplete
// snapshot, not by hydration.
export function unionHydrate<T extends Record<string, unknown>>(
  idbVal: T | undefined,
  liveVal: T | undefined,
): T {
  if (!idbVal) return liveVal ?? ({} as T);
  if (!liveVal) return idbVal;
  if (
    Object.keys(idbVal).every((key) =>
      Object.prototype.hasOwnProperty.call(liveVal, key),
    )
  )
    return liveVal;
  return { ...(idbVal ?? {}), ...(liveVal ?? {}) } as T;
}

// How one cached value re-enters the store over whatever live sync already
// wrote, per the registry's merge strategy. "fill" keys (live-synced
// singletons) only land while the slot is still null; everything else merges
// by shape — objects union (cache as floor, live wins per key), arrays fill
// only an empty slot, scalars replace.
export function hydrateMergeValue(
  key: string,
  val: unknown,
  cur: unknown,
): { apply: boolean; value?: unknown } {
  if (key === "pendingMessages" && val && typeof val === "object") {
    const merged = { ...(val as Record<string, Message[]>) };
    for (const [convId, rows] of Object.entries(
      (cur ?? {}) as Record<string, Message[]>,
    )) {
      const combined = [...(merged[convId] ?? []), ...rows];
      merged[convId] = [
        ...new Map(
          combined.map((message) => [
            message._clientId || message._id,
            message,
          ]),
        ).values(),
      ];
    }
    return { apply: true, value: merged };
  }
  if (hydrationMergeStrategy(key) === "fill") {
    return cur == null ? { apply: true, value: val } : { apply: false };
  }
  if (Array.isArray(val)) {
    return (cur as unknown[] | undefined)?.length === 0
      ? { apply: true, value: val }
      : { apply: false };
  }
  if (typeof val === "object") {
    const live = cur as Record<string, unknown> | undefined;
    return {
      apply: true,
      value: unionHydrate(
        cacheFloorUnderSnapshot(key, val as Record<string, unknown>, live),
        live,
      ),
    };
  }
  return { apply: true, value: val };
}

// Drop persisted feedHasMore=false entries (in place) so they hydrate as
// "unknown" instead of as a dead latch. False used to stick durably off one
// bad page — the server could return an empty page mid-history (a window of
// filtered-out rows), the client persisted false, and the seed effect (which
// only writes when the key is absent) could never undo it: feed pagination
// stayed dead on that device forever. A true end-of-history loses nothing:
// feedCursors[key] === null short-circuits loadMore before any network.
export function dropLatchedFeedHasMore(feedHasMore: unknown): void {
  if (!feedHasMore || typeof feedHasMore !== "object") return;
  const map = feedHasMore as Record<string, unknown>;
  for (const key of Object.keys(map)) {
    if (map[key] === false) delete map[key];
  }
}

// -- IndexedDB cache: wire patch-driven writes + hydrate on load --

// Boot-seed liveInboxIds from its persisted twin. Guarded: only a non-empty
// cached array lands, and only while the in-memory set is still empty — if a
// live payload raced hydration and landed first (size > 0), the fresher server
// truth wins and the stale snapshot is discarded. Raw setState on purpose: the
// value came FROM disk, so re-persisting it through the sync() action would be
// a pointless IDB write during hydration.
export function seedLiveInboxIdsFromCache(
  useInboxStore: HydrationStore,
  cachedList: unknown,
) {
  if (!Array.isArray(cachedList) || cachedList.length === 0) return;
  if (useInboxStore.getState().liveInboxIds.size > 0) return;
  const ids = cachedList.filter((id): id is string => typeof id === "string");
  if (ids.length === 0) return;
  useInboxStore.setState({ liveInboxIds: new Set(ids), liveInboxIdList: ids });
}

// Team-mode analogue of seedLiveInboxIdsFromCache. Extra guards: only seeds
// when the client boots IN team scope with the SAME active team the snapshot
// was taken for — a snapshot from another team (or a client since switched to
// "mine") must never gate the board. Runs after clientState hydrates (the
// scope/team prefs live there), same synchronous pass.
export function seedTeamInboxIdsFromCache(
  useInboxStore: HydrationStore,
  cachedSnapshot: unknown,
) {
  const snap = cachedSnapshot as
    | { team_id?: string | null; ids?: unknown }
    | null
    | undefined;
  if (!snap || !Array.isArray(snap.ids) || snap.ids.length === 0) return;
  const state = useInboxStore.getState();
  if (state.teamInboxIds.size > 0) return; // live payload raced hydration — server truth wins
  const ui = state.clientState.ui;
  if ((ui?.inbox_scope ?? "mine") !== "team") return;
  if ((snap.team_id ?? null) !== (ui?.active_team_id ?? null)) return;
  const ids = snap.ids.filter((id): id is string => typeof id === "string");
  if (ids.length === 0) return;
  useInboxStore.setState({
    teamInboxIds: new Set(ids),
    teamInboxIdSnapshot: { team_id: snap.team_id ?? null, ids },
  });
}

// -- IndexedDB cache: wire patch-driven writes + hydrate on load --
async function hydrateInboxCacheFromIDB(
  useInboxStore: HydrationStore,
  currentHydrationEpoch: () => number,
  bootLinkTarget: (
    sessions: InboxStoreState["sessions"],
  ) => string | null | undefined,
  resolveInboxHome: (
    ui: InboxStoreState["clientState"]["ui"],
  ) => "board" | "feed",
  ensureHydrated: (convId: string) => Promise<boolean>,
): Promise<boolean> {
  if (!PERSISTENCE_AVAILABLE) return false;
  // A clear during this hydration (an account boundary) moves the epoch; from
  // then on every step here is a no-op and the store stays as the clear left it.
  const epoch = currentHydrationEpoch();
  const superseded = () => epoch !== currentHydrationEpoch();

  (useInboxStore.getState() as any)._setIDBWrite(writePatchesToIDB);
  (useInboxStore.getState() as any)._setOutbox(
    enqueueDispatch,
    removeDispatch,
    loadOutbox,
  );
  const setStorageDegraded = (next: InboxStoreState["storageDegraded"]) => {
    if (useInboxStore.getState().storageDegraded === next) return;
    useInboxStore.setState({ storageDegraded: next });
  };
  (useInboxStore.getState() as any)._setStorageHealth?.((healthy: boolean) => {
    // A write stuck behind a blocked upgrade trips the watchdog too; keep the
    // actionable cause rather than downgrading it to a generic stall.
    if (!healthy && useInboxStore.getState().storageDegraded === "blocked")
      return;
    setStorageDegraded(healthy ? false : "stalled");
  });
  setUpgradeBlockedListener((blocked) =>
    setStorageDegraded(blocked ? "blocked" : false),
  );

  // Salvage any writes parked in the retired local-first v2 databases, then
  // delete those databases. Runs before the first drain can matter: the drain
  // re-fires below once salvage lands rows.
  void salvageLocalFirstV2Data().then((salvaged) => {
    if (salvaged > 0) (useInboxStore.getState() as any)._drainOutbox?.();
  });

  setHydrating(true);
  // Native first paint reads only the live inbox rows (no getAllKeys of the
  // whole SQLite cache, no conversations twin). That runs before the first
  // await so bootPersistence() at module eval already has sessions in the
  // store. The full critical set still loads below, after splash can hide.
  // Desktop IndexedDB has no sync read; loadPaintCacheSync returns null.
  const paintCached = loadPaintCacheSync();

  const apply = (source: Record<string, any> | null, pick: string[]) => {
    if (!source || superseded()) return;
    const state = useInboxStore.getState();
    const updates: Record<string, any> = {};
    for (const key of pick) {
      const val = source[key];
      if (val == null) continue;
      const cur = (state as any)[key];
      if (key === "clientState" && state.clientStateInitialized) {
        // Merge tips (set_union)
        const cachedTips = val?.tips;
        if (cachedTips) {
          const cur = state.clientState.tips ?? ({} as any);
          const merged: Record<string, any> = {};
          let changed = false;
          for (const k of ["seen", "dismissed", "completed"] as const) {
            const union = [
              ...new Set([
                ...((cur as any)[k] ?? []),
                ...(cachedTips[k] ?? []),
              ]),
            ];
            if (union.length > ((cur as any)[k]?.length ?? 0)) {
              merged[k] = union;
              changed = true;
            }
          }
          if (changed) state.updateClientTips(merged);
        }
        // Merge ui fields that may only exist in IDB (saved_views, etc.)
        const cachedUI = val?.ui;
        if (cachedUI) {
          const curUI = state.clientState.ui ?? {};
          const uiPatch: Record<string, any> = {};
          for (const [uk, uv] of Object.entries(cachedUI)) {
            // Stamps ride along with their base key below, never alone — a
            // bare stale ":ts" would misdate whatever value is already live.
            if (uk.endsWith(":ts")) continue;
            // Fill keys the live bag is missing, and let a NEWER cached stamp
            // overlay an older live value. `[]` is not null, so a boot that
            // took an empty server list wholesale would otherwise keep it
            // and drop a pin still on disk (ct-51761).
            const liveVal = (curUI as any)[uk];
            const liveTs = (curUI as any)[`${uk}:ts`];
            const cachedTs = (cachedUI as any)[`${uk}:ts`];
            const liveMissing = liveVal == null;
            const cachedNewer =
              typeof cachedTs === "number" &&
              (typeof liveTs !== "number" || cachedTs > liveTs);
            if (uv != null && (liveMissing || cachedNewer)) {
              uiPatch[uk] = uv;
              // Keep the ORIGINAL write time (updateClientUI honors a passed
              // stamp) so this boot-time restore can't outrank a genuinely
              // newer write from another device.
              if (typeof cachedTs === "number") uiPatch[`${uk}:ts`] = cachedTs;
            }
          }
          if (Object.keys(uiPatch).length > 0) state.updateClientUI(uiPatch);
        }
        continue;
      }
      if (key === "clientState") {
        // Cold-start path. clientState may have a small localStorage seed
        // (sidebar_collapsed, zen_mode, etc.) — preserve those and fill in
        // everything else from IDB. Deep-merge nested objects (ui, dismissed,
        // layouts, tips) so a single seeded ui key doesn't shadow the rest.
        const merged: Record<string, any> = { ...val };
        for (const subKey of Object.keys(cur || {})) {
          const curSub = (cur as any)[subKey];
          const cachedSub = (val as any)[subKey];
          if (
            curSub &&
            typeof curSub === "object" &&
            !Array.isArray(curSub) &&
            cachedSub &&
            typeof cachedSub === "object" &&
            !Array.isArray(cachedSub)
          ) {
            // Local seed wins per-key; cached fills in the rest.
            merged[subKey] = { ...cachedSub, ...curSub };
          } else if (curSub != null) {
            merged[subKey] = curSub;
          }
        }
        updates[key] = merged;
        continue;
      }
      const merge = hydrateMergeValue(key, val, cur);
      if (merge.apply) updates[key] = merge.value;
    }
    if (updates.pendingMessages)
      updates.queuedMessages = queuedMessagesFromPending(
        updates.pendingMessages,
      );
    if (Object.keys(updates).length > 0) {
      useInboxStore.setState(updates);
    }
  };

  if (paintCached) {
    apply(paintCached, [...HYDRATION_PAINT_KEYS]);
    seedLiveInboxIdsFromCache(useInboxStore, paintCached.liveInboxIdList);
    seedTeamInboxIdsFromCache(useInboxStore, paintCached.teamInboxIdSnapshot);
    const paintFocus = (paintCached.lastFocusedConversationId ?? null) as
      | string
      | null;
    if (paintFocus && !useInboxStore.getState().lastFocusedConversationId) {
      useInboxStore.setState({ lastFocusedConversationId: paintFocus });
    }
    if (!useInboxStore.getState().clientStateInitialized) {
      useInboxStore.setState({ clientStateInitialized: true });
    }
  }

  const windowKeys = desktopWindowKeys();
  const scopedKeys = windowKeys && new Set<string>(windowKeys);
  const criticalKeys = scopedKeys
    ? HYDRATION_CRITICAL_KEYS.filter((key) => scopedKeys.has(key))
    : HYDRATION_CRITICAL_KEYS;
  const deferredKeys = scopedKeys
    ? HYDRATION_DEFERRED_KEYS.filter((key) => scopedKeys.has(key))
    : HYDRATION_DEFERRED_KEYS;
  const cached = scopedKeys
    ? await loadCache(
        HYDRATION_CRITICAL_READ_KEYS.filter(
          (key) => scopedKeys.has(key) || key === "lastFocusedConversationId",
        ),
      )
    : await loadCache(HYDRATION_CRITICAL_READ_KEYS);
  if (superseded()) return false;

  // Strip stale large fields from cached conversations (git_diff, git_diff_staged, available_skills)
  if (cached?.conversations && typeof cached.conversations === "object") {
    for (const conv of Object.values(cached.conversations) as any[]) {
      if (conv) {
        delete conv.git_diff;
        delete conv.git_diff_staged;
        delete conv.available_skills;
      }
    }
  }

  // Legacy disk rows under unregistered keys (the old monolithic messages /
  // pagination meta blobs) can't leak in: apply() walks registry-derived key
  // lists only. Messages load per-conversation from their own IDB table.

  // A persisted optimistic message whose image is still `uploading` was
  // orphaned by a reload mid-upload: the in-memory upload+send task didn't
  // survive, and resolvePendingUploads (which clears the flag) never ran. It
  // can't complete on its own, so surface it as failed instead of a forever
  // spinner, and drop the now-dead blob preview.
  if (cached?.pendingMessages && typeof cached.pendingMessages === "object") {
    for (const msgs of Object.values(cached.pendingMessages) as Message[][]) {
      if (!Array.isArray(msgs)) continue;
      for (const m of msgs) {
        if ((m as any)?.images?.some((img: any) => img?.uploading)) {
          (m as any)._isFailed = true;
          (m as any).images = (m as any).images.filter(
            (img: any) => !img?.uploading,
          );
        }
      }
    }
  }

  // A persisted feedHasMore=false is dropped at hydration (treated as
  // unknown) — it used to latch durably off one bad page and nothing could
  // ever undo it (the seed effect only writes when the key is absent), which
  // killed feed pagination on that device for good. A true end-of-history is
  // re-confirmed for free: feedCursors[key] === null short-circuits loadMore
  // before any network.
  dropLatchedFeedHasMore(cached?.feedHasMore);

  // Critical path: everything needed for first paint (sidebar, current
  // conversation, tabs, label groups, team feed). Derived from the registry —
  // a persisted key hydrates here unless it opted into the deferred phase or
  // "manual" handling, so a new key can never silently skip hydration (the
  // ct-34920 / buckets-pop-in bug class).
  apply(cached, criticalKeys);

  // Seed the authoritative active set from its persisted twin (manual
  // hydration — see clientSyncRegistry). Same synchronous pass as the
  // sessions apply above, so the first frame that shows cached sessions
  // already filters them to the last-known server set: no cold-boot flash of
  // aged-out rows. The live subscription / recovery poll replace it within
  // ~1s of connecting.
  seedLiveInboxIdsFromCache(useInboxStore, cached?.liveInboxIdList);
  seedTeamInboxIdsFromCache(useInboxStore, cached?.teamInboxIdSnapshot);

  // Restore the selected session before React effects can auto-select the
  // first session (QueuePageClient's fallback effect). Prefer this client's
  // OWN last position (lastFocusedConversationId, local-only); the per-user
  // synced pointer is a fallback for clients with no local history ONLY —
  // it is writable by every other client (devices, agent-driven tabs), and
  // restoring from it here is what kept teleporting the desktop into random
  // sessions after every dev reload (ct-36951; the round-1 fix gated the
  // server-sync pull but this hydration path was the live door).
  const st = useInboxStore.getState();
  // A tab persisted with a path the shell cannot render (older builds
  // stamped the live URL unchecked) heals to the inbox before first paint.
  const healedTabs = healTabPaths(st.tabs);
  if (healedTabs !== st.tabs) useInboxStore.setState({ tabs: healedTabs });
  const ownId = (
    scopedKeys ? null : (cached?.lastFocusedConversationId ?? null)
  ) as string | null;
  if (ownId && !st.lastFocusedConversationId) {
    useInboxStore.setState({ lastFocusedConversationId: ownId });
  }
  if (!scopedKeys && !st.currentSessionId) {
    // A fresh open onto the feed home goes to the new-session page
    // (DashboardLayout opens it) rather than back to the last conversation.
    // Decided from the address the window opened on: by now the tab shell
    // may have put the restored tab's conversation in the address bar,
    // which is not a link the person followed.
    const freshHome =
      freshHomeLaunchPending() &&
      resolveInboxHome(st.clientState?.ui) !== "board";
    if (!freshHome) settleFreshHomeLaunch();
    const linked = freshHome ? undefined : bootLinkTarget(st.sessions);
    const remembered = ownId ?? st.clientState?.current_conversation_id;
    // A link opens what it names; otherwise the remembered position comes back.
    const restoreId =
      linked !== undefined
        ? linked
        : !freshHome && remembered
          ? remembered
          : null;
    if (restoreId && st.sessions[restoreId]) {
      // The divider anchor (_seenUpToAt) is persisted, so reopening the app to
      // this session naturally shows what arrived while it was closed — no
      // special seeding needed here.
      declareViewNav("boot-restore");
      useInboxStore.setState({ currentSessionId: restoreId });
    }
  }

  // Preload messages for the restored focus target only. The rows on screen
  // are hydrated by the inbox warm loop (hooks/inboxWarm.ts) in rendered
  // order, and anything else hydrates on open. Preloading the whole live
  // inbox set here made a phone with 594 live sessions parse 78 MB of cached
  // message JSON on the JS thread right after first paint, and load hundreds
  // of conversations into memory for the eviction cap to fight back out.
  const focusId = useInboxStore.getState().currentSessionId;
  if (!scopedKeys && focusId) await ensureHydrated(focusId);
  if (superseded()) return false;

  if (!scopedKeys && !useInboxStore.getState().clientStateInitialized) {
    useInboxStore.setState({ clientStateInitialized: true });
  }

  // Deferred: list views + secondary data hydrate just after first paint.
  // setTimeout, NOT requestAnimationFrame: rAF is paused in background tabs, so
  // with the gate release below tied to it, a backgrounded tab would never
  // finish hydrating and never re-enable IDB writes (stuck `_hydrating`). With
  // the user running many session tabs, most are backgrounded — they must still
  // hydrate and persist. setTimeout fires (throttled) even when hidden.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  if (superseded()) return false;
  const deferred = await loadCache(deferredKeys, {
    pending: cached?.pending,
  });
  if (superseded()) return false;
  apply(deferred, deferredKeys);
  if (scopedKeys && !useInboxStore.getState().clientStateInitialized)
    useInboxStore.setState({ clientStateInitialized: true });
  // Re-enable IDB write-through only AFTER the deferred collections land.
  // If a live delta arrives while write-through is open but the store still
  // holds just the windowed payload (tasks' 300, sessions' ~30d), then
  // diffCollection would diff that window against the full on-disk shadow and
  // bulkDelete every cached row outside it — pruning the shared IndexedDB
  // before unionHydrate merges it back (the cross-tab "disappear then stream
  // back" race jx799py found). Post-hydration the store holds the full union,
  // so delta overlays never drop rows; write-through then deletes only on a
  // real removal (dismiss/kill) or the crawl's authoritative snapshot.
  setHydrating(false);
  // A snapshot that landed BEFORE hydration left its omitted rows on disk:
  // the floor kept them out of memory, so no later prune will ever name them
  // and no commit is pending for that collection. Spend those drops now —
  // otherwise they wait for the collection's next change, and a follower
  // window booting in between hydrates them with no feeder to correct it.
  // Only a window that ran the feeder holds drops, so a follower never writes.
  const stale = keysWithSnapshotDrops();
  if (stale.length) {
    writePatchesToIDB(
      stale.map(
        (key) => ({ op: "replace", path: [key], value: undefined }) as any,
      ),
      useInboxStore.getState(),
    );
  }
  return true;
}

// Persistence boots with the module: wire write-through and hydrate
// immediately. Nothing gates on auth — cached state renders first and live
// sync reconciles after (local-first is the law).
export function bootInboxPersistence(
  useInboxStore: HydrationStore,
  currentHydrationEpoch: () => number,
  bootLinkTarget: (
    sessions: InboxStoreState["sessions"],
  ) => string | null | undefined,
  resolveInboxHome: (
    ui: InboxStoreState["clientState"]["ui"],
  ) => "board" | "feed",
  ensureHydrated: (convId: string) => Promise<boolean>,
): void {
  if (PERSISTENCE_AVAILABLE) {
    void hydrateInboxCacheFromIDB(
      useInboxStore,
      currentHydrationEpoch,
      bootLinkTarget,
      resolveInboxHome,
      ensureHydrated,
    ).catch((error) => {
      console.error(
        "[store] IDB hydration failed; continuing with live-only state",
        error,
      );
      setHydrating(false);
      useInboxStore.setState({ clientStateInitialized: true });
    });
  } else {
    useInboxStore.setState({ clientStateInitialized: true });
  }
}
