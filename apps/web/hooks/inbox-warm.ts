import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import {
  useInboxStore,
  isConvexId,
  ensureHydrated,
  visualOrderViewSig,
  inboxMemberRows,
  placeInboxRows,
  sessionRowFromConversation,
  sessionStructuralSig,
  type InboxSession,
} from "../store/inboxStore";
import {
  hasEvictableMessagesOverBudget,
  MESSAGE_CACHE_BUDGET_BYTES,
  messageWarmState,
} from "../store/store-eviction";
import { makeCollectionSig } from "../store/wakeSig";
import { whenInputQuiet } from "../lib/inputQuiet";
import { windowDrawsTranscripts } from "../lib/windowRole";
import { windowOrgTree } from "../store/orgSlice";
import { shareTokenArg } from "../lib/shareTokenScope";
import { isHostedAgentType } from "@codecast/agent-clients/agentClients";

// Background warming of inbox conversations so opening one is instant.
//
// The warm order starts with WHAT THE USER IS LOOKING AT: the store's rendered
// order (visualOrder → placeInboxRows → the view mode, scope, show-old fold and
// chip filters), not the server's live payload. The live window is ~200 rows in
// most-actionable-first order; the flat "All"/"recent" views, the show-old fold,
// a project chip and team scope all draw from the wider local cache, so a loop
// over the payload never touched the rows those views actually show. After the
// rendered rows come the inbox rows the render hides (warmOrder), so every
// inbox session is warm whatever the view.
//
// Depth is tiered by on-screen rank. The rows at the top of the list get the
// same 200-row page the open path fetches on a cold open (and are deepened to
// it when the cache holds a shorter tail); everything further down gets the
// newest WARM_TAIL_ROWS only. The tiers are what keep "aggressive" bounded:
// warming a thousand rows to 200 image-bearing messages each is the RAM
// balloon the in-memory eviction cap exists to fight.
//
// Three cases per row, in on-screen order:
//   Cold (nothing in memory): restore from IDB, else fetch the newest page.
//   Shallow (in the deep tier, holding fewer than WARM_DEEP_ROWS with older
//     rows on the server): prepend one page — the exact fetch scroll-up does.
//   Stale (message_count grew past what we last synced): append the delta,
//     walking forward from our newest cached message.

/** Newest-page size for rows at the top of the rendered list. Matches the open
 *  path's snapshot page (useConversationMessages), so a warmed row opens with the
 *  same window a cold open would have fetched. */
export const WARM_DEEP_ROWS = 200;
/** How many rows from the top of the rendered list get the deep window. */
export const WARM_DEEP_RANKS = 40;
/** Newest-page size for every row below the deep tier: the slice the
 *  conversation view paints on open, so the click is instant. */
export const WARM_TAIL_ROWS = 60;
/** Cold warms started per pass — a freshly loaded inbox must not fire a query
 *  per row at once; the rest drain over later passes (every list change, every
 *  view change, and the 15s recovery poll). */
export const MAX_COLD_WARM_PER_PASS = 60;
/** Deepen fetches started per pass. */
export const MAX_DEEPEN_PER_PASS = 10;

export type WarmAction =
  | { kind: "row"; id: string }
  | { kind: "cold"; id: string; rows: number; serverCount: number }
  | { kind: "deepen"; id: string; rows: number }
  | { kind: "delta"; id: string; after: number; serverCount: number };

export type WarmRow = {
  id: string;
  /** message_count from the store row; null when the row itself must be
   *  fetched first (a role's standing session the store lacks, or holds
   *  without is_anchor). */
  serverCount: number | null;
  storedCount: number;
  hasMoreAbove: boolean;
  /** Newest cached message timestamp (stored rows > 0). */
  newestTs: number | null;
  /** Where a delta read starts (see rereadAnchor); defaults to newestTs - 1. */
  rereadFrom?: number | null;
  /** Last message_count we synced up to, if any. */
  syncedCount: number | undefined;
  inFlight: boolean;
};

/** Target window for a row at rank `rank` in the rendered order. */
export function warmDepthForRank(rank: number): number {
  return rank < WARM_DEEP_RANKS ? WARM_DEEP_ROWS : WARM_TAIL_ROWS;
}

/** The pure planner: rows in on-screen order → the bounded fetch list. */
export function planWarm(
  rows: WarmRow[],
  coldWarmed?: ReadonlySet<string>,
): WarmAction[] {
  const actions: WarmAction[] = [];
  let cold = 0;
  let deepens = 0;
  rows.forEach((row, rank) => {
    if (row.inFlight || row.serverCount === 0) return;
    const depth = warmDepthForRank(rank);
    // No usable store row: fetch the row (a click would wait on it before
    // painting anything); the pass after it lands warms the messages.
    if (row.serverCount === null) {
      actions.push({ kind: "row", id: row.id });
      return;
    }
    if (row.storedCount === 0) {
      if (coldWarmed && (rank >= 10 || coldWarmed.has(row.id))) return;
      if (cold >= MAX_COLD_WARM_PER_PASS) return;
      cold++;
      actions.push({
        kind: "cold",
        id: row.id,
        rows: depth,
        serverCount: row.serverCount,
      });
      return;
    }
    if (!coldWarmed && row.storedCount < depth && row.hasMoreAbove) {
      if (deepens >= MAX_DEEPEN_PER_PASS) return;
      deepens++;
      actions.push({
        kind: "deepen",
        id: row.id,
        rows: depth - row.storedCount,
      });
      return;
    }
    if (row.serverCount <= (row.syncedCount ?? 0) || row.newestTs === null)
      return;
    actions.push({
      kind: "delta",
      id: row.id,
      after: row.rereadFrom ?? row.newestTs - 1,
      serverCount: row.serverCount,
    });
  });
  return actions;
}

type ConvexClient = { query: (fn: any, args: any) => Promise<any> };

/**
 * Where a forward read of a cached window starts. Usually one ms before the
 * newest row, so a row cached mid-stream comes back whole. A hosted turn
 * streams into one row and then adds more after it, so its stale copy can sit
 * anywhere in the window: a hosted conversation (short by nature) re-reads
 * its whole cached window, and mergeMessages replaces every changed copy.
 */
export function rereadAnchor(
  msgs: readonly { timestamp: number }[] | undefined,
  agentType: string | null | undefined,
): number | null {
  if (!msgs?.length) return null;
  const from = isHostedAgentType(agentType) ? msgs[0] : msgs[msgs.length - 1];
  return from.timestamp - 1;
}

/**
 * Every row after `after`, paged forward and merged into the store. The one
 * forward read the warm delta, the open path's recovery and the hosted heal
 * share.
 */
export async function readForward(
  convex: ConvexClient,
  conversationId: string,
  after: number,
  maxPages = 40,
): Promise<number | null> {
  const inFlight = messageWarmState.inFlight;
  let cursor = after;
  let fetched = 0;
  for (let i = 0; i < maxPages; i++) {
    const result = await convex.query(api.conversations.getNewMessages, {
      conversation_id: conversationId as Id<"conversations">,
      after_timestamp: cursor,
    });
    const state = useInboxStore.getState();
    if (
      inFlight !== messageWarmState.inFlight ||
      !state.messages[conversationId]?.length
    )
      return null;
    if (result === null) return fetched > 0 ? fetched : null;
    if (!result.messages?.length) break;
    state.mergeMessages(conversationId, result.messages, "append", {
      initialized: true,
    });
    fetched += result.messages.length;
    if (!result.has_more || result.last_timestamp == null) break;
    cursor = result.last_timestamp;
  }
  return fetched;
}

function finishWarm(inFlight: Set<string>, id: string): void {
  inFlight.delete(id);
  if (
    inFlight !== messageWarmState.inFlight ||
    useInboxStore.getState().messageCacheBytes <= MESSAGE_CACHE_BUDGET_BYTES
  )
    return;
  queueMicrotask(() => {
    const state = useInboxStore.getState();
    if (
      inFlight === messageWarmState.inFlight &&
      hasEvictableMessagesOverBudget(state)
    )
      state.trimMessageCache();
  });
}

/** One-shot older page. History walks must not subscribe: a live query on a
 *  long session re-runs on every conversation heartbeat and OCC-retries
 *  against a hot row. */
export async function fetchOlderMessages(
  convex: ConvexClient,
  conversationId: string,
  before: number,
  limit: number,
): Promise<any> {
  return convex.query(api.conversations.getAllMessages, {
    conversation_id: conversationId as Id<"conversations">,
    limit,
    before_timestamp: before,
    ...shareTokenArg(conversationId),
  });
}

/** One-shot around-window. Jump-to-start / jump-to-timestamp use this instead
 *  of useQuery so a 50-row window is not a live subscription. Bookmark hover
 *  already prefetches the same args, so a cached click still resolves from
 *  memory. */
export async function fetchMessagesAround(
  convex: ConvexClient,
  conversationId: string,
  center: number,
  limitBefore: number,
  limitAfter: number,
): Promise<any> {
  return convex.query(api.conversations.getMessagesAroundTimestamp, {
    conversation_id: conversationId as Id<"conversations">,
    center_timestamp: center,
    limit_before: limitBefore,
    limit_after: limitAfter,
    ...shareTokenArg(conversationId),
  });
}

/** Prepend up to `limit` older rows before the oldest cached one. The one
 *  history fetch behind scroll-up (useConversationMessages.loadOlder), the
 *  deepen tier and the open-path backfill. Resolves false when there was
 *  nothing local to page back from. */
export async function fetchOlderPage(
  convex: ConvexClient,
  conversationId: string,
  limit: number,
): Promise<boolean> {
  const oldest =
    useInboxStore.getState().messages[conversationId]?.[0]?.timestamp;
  if (oldest === undefined) return false;
  const inFlight = messageWarmState.inFlight;
  const res: any = await fetchOlderMessages(
    convex,
    conversationId,
    oldest,
    limit,
  );
  const state = useInboxStore.getState();
  if (
    inFlight !== messageWarmState.inFlight ||
    !res?.messages ||
    !state.messages[conversationId]?.length
  )
    return false;
  state.mergeMessages(conversationId, res.messages, "prepend", {
    hasMoreAbove: res.has_more_above ?? false,
    initialized: true,
  });
  return true;
}

/** Bring one conversation's cached window up to `rows` if older rows exist —
 *  the open path calls this after anchoring on a short cached tail so the first
 *  scroll-up is already local. Shares the in-flight set with the warm loop. */
export function deepenConversation(
  convex: ConvexClient,
  conversationId: string,
  rows = WARM_DEEP_ROWS,
): Promise<void> {
  const st = useInboxStore.getState();
  const stored = st.messages[conversationId]?.length ?? 0;
  if (
    stored === 0 ||
    stored >= rows ||
    !st.pagination[conversationId]?.hasMoreAbove
  )
    return Promise.resolve();
  const inFlight = messageWarmState.inFlight;
  if (inFlight.has(conversationId)) return Promise.resolve();
  inFlight.add(conversationId);
  return fetchOlderPage(convex, conversationId, rows - stored)
    .then(() => undefined)
    .catch(() => undefined)
    .finally(() => finishWarm(inFlight, conversationId));
}

function runCold(
  convex: ConvexClient,
  action: Extract<WarmAction, { kind: "cold" }>,
) {
  const { id, rows, serverCount } = action;
  const inFlight = messageWarmState.inFlight;
  messageWarmState.coldIds.add(id);
  inFlight.add(id);
  ensureHydrated(id)
    .then((restored) => {
      if (
        inFlight !== messageWarmState.inFlight ||
        !useInboxStore.getState().sessions[id]
      )
        return null;
      if (restored) {
        messageWarmState.syncedCount.set(id, serverCount);
        return null;
      }
      return convex.query(api.conversations.listMessages, {
        conversation_id: id as Id<"conversations">,
        paginationOpts: { numItems: rows, cursor: null },
      });
    })
    .then((res: any) => {
      if (inFlight !== messageWarmState.inFlight || !res) return;
      const state = useInboxStore.getState();
      const page = res?.page;
      if (
        Array.isArray(page) &&
        page.length > 0 &&
        state.sessions[id] &&
        !state.messages[id]?.length
      ) {
        state.setMessages(id, [...page].reverse(), {
          hasMoreAbove: !res.isDone,
          initialized: true,
        });
        messageWarmState.syncedCount.set(id, serverCount);
      }
    })
    .catch((err: unknown) => {
      console.warn("[inboxWarm] cold warm failed", { id, err });
    })
    .finally(() => finishWarm(inFlight, id));
}

function runRow(convex: ConvexClient, id: string) {
  const inFlight = messageWarmState.inFlight;
  inFlight.add(id);
  messageWarmState.rowTried.add(id);
  convex
    .query(api.conversations.getConversation, {
      conversation_id: id as Id<"conversations">,
      limit: 1,
    })
    .then((data: any) => {
      if (inFlight === messageWarmState.inFlight && data)
        useInboxStore
          .getState()
          .seedSession(sessionRowFromConversation(id, data));
    })
    .catch((err: unknown) => {
      console.warn("[inboxWarm] row warm failed", { id, err });
    })
    .finally(() => finishWarm(inFlight, id));
}

function runDelta(
  convex: ConvexClient,
  action: Extract<WarmAction, { kind: "delta" }>,
) {
  const { id, serverCount } = action;
  const inFlight = messageWarmState.inFlight;
  inFlight.add(id);
  readForward(convex, id, action.after)
    .then((fetched) => {
      if (fetched !== null && inFlight === messageWarmState.inFlight)
        messageWarmState.syncedCount.set(id, serverCount);
    })
    .catch((err: unknown) => {
      console.warn("[inboxWarm] delta warm failed", { id, err });
    })
    .finally(() => finishWarm(inFlight, id));
}

function runDeepen(
  convex: ConvexClient,
  action: Extract<WarmAction, { kind: "deepen" }>,
) {
  const inFlight = messageWarmState.inFlight;
  inFlight.add(action.id);
  fetchOlderPage(convex, action.id, action.rows)
    .catch((err: unknown) => {
      console.warn("[inboxWarm] deepen failed", { id: action.id, err });
    })
    .finally(() => finishWarm(inFlight, action.id));
}

/**
 * Every row a click, a jump or a reveal can land on, in warm priority: the
 * rendered list first, then the rest of the inbox in both scopes, then every
 * role's standing session. A collapsed section, a chip, the favorites shelf or
 * the other scope hides rows from the render without taking them out of the
 * inbox, and a role's standing session files behind its role card or on the
 * org page; opening any of them must find a warm row. Rows behind the show-old
 * fold stay out: they outnumber the in-memory cap.
 */
export function warmOrder(
  st: ReturnType<typeof useInboxStore.getState>,
): { id: string; session?: InboxSession; needsRow?: boolean }[] {
  const order: { id: string; session?: InboxSession; needsRow?: boolean }[] =
    [];
  const byId = new Map<string, (typeof order)[number]>();
  const add = (id: string, session?: InboxSession, needsRow?: boolean) => {
    const held = byId.get(id);
    if (held) {
      if (needsRow) held.needsRow = true;
      return;
    }
    const entry = { id, session, needsRow };
    byId.set(id, entry);
    order.push(entry);
  };
  for (const s of renderedOrder(st)) add(String(s._id), s);
  // Membership without the focus rule: the open conversation is warm anyway,
  // and asking per focused id gave placement a new memo slot on every switch,
  // two whole placements per switch spent only on warming.
  for (const s of inboxMemberRows(st, null)) add(String(s._id), s);
  // A role's standing session needs its row, and the row needs is_anchor:
  // placement files a standing session hidden by it, so a copy seeded without
  // it (before seeds carried it) shows as an active card until refetched.
  for (const role of windowOrgTree(st)?.roles ?? []) {
    const id =
      role.standing?.conversation_id && String(role.standing.conversation_id);
    if (id) add(id, st.sessions[id], !st.sessions[id]?.is_anchor);
  }
  for (const s of Object.values(st.sessions))
    if (s.standing_role_id) add(String(s._id), s, !s.is_anchor);
  return order;
}

// The rendered order, recomputed only when what it is drawn from moved: the
// placement (its per-row map keeps its identity while no row changed bucket)
// and the view's own inputs. It only sets warm priority, so an order that
// shifted inside a bucket waits for the next structural change; the rows
// themselves are read from the store on every pass.
let renderedMemo: {
  placements: unknown;
  view: string;
  deps: unknown[];
  order: InboxSession[];
} | null = null;
function renderedOrder(
  st: ReturnType<typeof useInboxStore.getState>,
): InboxSession[] {
  const { placements } = placeInboxRows(st, {
    focusedId: st.currentSessionId ?? null,
  });
  const view = visualOrderViewSig(st);
  const deps: unknown[] = [
    st.bucketAssignments,
    st.buckets,
    st.collapsedSections,
    st.favorites,
    st.plans,
    st.scheduleNavSets,
    st.recentFreezeOrder,
    st.orgTree,
    st.clientState.ui,
  ];
  const m = renderedMemo;
  if (
    m &&
    m.placements === placements &&
    m.view === view &&
    deps.every((d, i) => d === m.deps[i])
  )
    return m.order;
  const order = st.visualOrder();
  renderedMemo = { placements, view, deps, order };
  return order;
}

/** Snapshot the inbox into planner rows, in warm priority. */
export function warmRowsFromState(
  st: ReturnType<typeof useInboxStore.getState>,
): WarmRow[] {
  const rows: WarmRow[] = [];
  for (const { id, session, needsRow } of warmOrder(st)) {
    if (!isConvexId(id)) continue;
    const msgs = st.messages[id];
    const storedCount = msgs?.length ?? 0;
    rows.push({
      id,
      // The base list omits message_count (fast_fields_in_overlay); the store
      // row is where the overlay has merged the exact value.
      // A row fetch is tried once (rowTried), then the row's own count rules,
      // whatever came back.
      serverCount:
        needsRow && !messageWarmState.rowTried.has(id)
          ? null
          : (st.sessions[id]?.message_count ?? session?.message_count ?? 0),
      storedCount,
      hasMoreAbove: st.pagination[id]?.hasMoreAbove ?? false,
      newestTs: storedCount > 0 ? msgs[storedCount - 1].timestamp : null,
      rereadFrom: rereadAnchor(
        msgs,
        st.sessions[id]?.agent_type ?? (session as any)?.agent_type,
      ),
      syncedCount: messageWarmState.syncedCount.get(id),
      inFlight: messageWarmState.inFlight.has(id),
    });
  }
  return rows;
}

/** One warm pass over what is on screen. Idempotent and cheap when caught up:
 *  visualOrder is memoized on the placement inputs, and every row already at
 *  its tier depth plans to nothing. */
export function warmVisibleSessions(convex: ConvexClient): void {
  const st = useInboxStore.getState();
  const rows = warmRowsFromState(st);
  const plan = planWarm(
    rows,
    messageWarmState.full ? messageWarmState.coldIds : undefined,
  );
  lastPass = {
    at: Date.now(),
    planned: plan.length,
    kinds: plan.map((a) => a.kind),
  };
  for (const action of plan) {
    if (action.kind === "row") runRow(convex, action.id);
    else if (action.kind === "cold") runCold(convex, action);
    else if (action.kind === "deepen") runDeepen(convex, action);
    else runDelta(convex, action);
  }
}

/** Store changes coalesce into one warm pass at most this often. */
export const WARM_COALESCE_MS = 750;
/** A pass waits for a pause in typing, but never longer than this. */
const WARM_MAX_DEFER_MS = 3_000;

// What a pass reads, as signatures: a row's place and membership (its
// structural signature) and the fields warmRowsFromState plans from; each
// conversation's cached tail; whether older pages remain. A heartbeat or a
// streamed token in some other field changes none of them and schedules
// nothing.
const warmSessionsSig = makeCollectionSig<InboxSession>(
  (s) =>
    `${sessionStructuralSig(s)}|${s.message_count ?? ""}|${s.is_anchor ? 1 : 0}|${s.agent_type ?? ""}`,
);
const warmMessagesSig = makeCollectionSig<{ timestamp?: number }[] | undefined>(
  (m) => (m ? `${m.length}|${m[m.length - 1]?.timestamp ?? ""}` : null),
);
const warmPaginationSig = makeCollectionSig<
  { hasMoreAbove?: boolean } | undefined
>((p) => (p?.hasMoreAbove ? "1" : "0"));

type WarmInputs = Pick<
  ReturnType<typeof useInboxStore.getState>,
  | "sessions"
  | "messages"
  | "pagination"
  | "liveInboxIds"
  | "teamInboxIds"
  | "orgTree"
>;
const warmInputsChanged = (a: WarmInputs, b: WarmInputs) =>
  (a.sessions !== b.sessions &&
    warmSessionsSig(a.sessions) !== warmSessionsSig(b.sessions)) ||
  (a.messages !== b.messages &&
    warmMessagesSig(a.messages) !== warmMessagesSig(b.messages)) ||
  (a.pagination !== b.pagination &&
    warmPaginationSig(a.pagination) !== warmPaginationSig(b.pagination)) ||
  a.liveInboxIds !== b.liveInboxIds ||
  a.teamInboxIds !== b.teamInboxIds ||
  a.orgTree !== b.orgTree;

/**
 * Keep the rendered rows warm in THIS window for as long as it lives. The pass
 * is driven by the store, not by whichever feeder happened to write: every
 * window holds its own message cache (messages never replicate), and a
 * follower window mounts no feeders at all, so a pass tied to them never ran
 * there and every session it opened (or dismissed onto) loaded cold. Any change
 * to the rows, their messages, or the view that orders them schedules one
 * coalesced pass, which waits for a pause in typing.
 *
 * One loop per window however many places mount it (the per-window layout
 * mount and the sync hooks both do); the last stop ends it.
 */
let loopRefs = 0;
let stopLoop: (() => void) | null = null;

export function startWarmLoop(convex: ConvexClient): () => void {
  // Messages never replicate between windows, so a window that never draws a
  // transcript has no use for a warm cache of its own.
  if (!windowDrawsTranscripts()) return () => {};
  loopRefs++;
  if (!stopLoop) stopLoop = runWarmLoop(convex);
  else warmVisibleSessions(convex);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    if (--loopRefs === 0) {
      stopLoop?.();
      stopLoop = null;
    }
  };
}

function runWarmLoop(convex: ConvexClient): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelQuiet: (() => void) | null = null;
  let pending = false;
  // A window nobody can see (minimized, behind another desktop, the desktop's
  // warm spare) warms nothing; showing it runs the pass it missed.
  const hidden = () =>
    typeof document !== "undefined" && document.visibilityState === "hidden";
  let missed = false;
  const schedule = () => {
    if (hidden()) {
      missed = true;
      return;
    }
    if (pending) return;
    pending = true;
    timer = setTimeout(() => {
      timer = null;
      // whenInputQuiet runs the pass synchronously when nobody is typing, so
      // `pending` (not the returned cancel) is what says a pass is queued.
      cancelQuiet = whenInputQuiet(() => {
        pending = false;
        if (hidden()) {
          missed = true;
          return;
        }
        warmVisibleSessions(convex);
      }, WARM_MAX_DEFER_MS);
    }, WARM_COALESCE_MS);
  };
  const onVisibility = () => {
    if (hidden() || !missed) return;
    missed = false;
    schedule();
  };
  if (typeof document !== "undefined")
    document.addEventListener("visibilitychange", onVisibility);
  const unsubscribe = useInboxStore.subscribe((st, prev) => {
    if (
      warmInputsChanged(st, prev) ||
      visualOrderViewSig(st) !== visualOrderViewSig(prev)
    )
      schedule();
  });
  if (hidden()) missed = true;
  else warmVisibleSessions(convex);
  return () => {
    unsubscribe();
    if (typeof document !== "undefined")
      document.removeEventListener("visibilitychange", onVisibility);
    if (timer !== null) clearTimeout(timer);
    cancelQuiet?.();
    timer = null;
    cancelQuiet = null;
    pending = false;
  };
}

// NODE_ENV (not import.meta.env.DEV): this module reaches the Expo bundle
// through useSyncCore, and Hermes cannot parse `import.meta`; both Vite and
// Metro statically replace NODE_ENV.
declare const process: { env: { NODE_ENV?: string } };
let lastPass: { at: number; planned: number; kinds: string[] } | null = null;
if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
  (window as any).__inboxWarm = {
    get lastPass() {
      return lastPass;
    },
    get inFlight() {
      return messageWarmState.inFlight;
    },
    syncedCount: messageWarmState.syncedCount,
  };
}
