import { api as _api } from "@codecast/convex/convex/_generated/api";
import {
  useInboxStore,
  syncLogScopeMetaKey,
  type CargoItem,
} from "../store/inboxStore";
import { admitUnheldSessions } from "../store/cacheRetention";
import { planCargoApply } from "../lib/syncLogCargo";
import { track } from "../lib/analytics";
import {
  checkReplaySignal,
  inboxReplaySignal,
  inboxSnapshotCoverage,
  resetInboxReplayLanes,
  retireInboxSnapshot,
  withInboxReplayLane,
  withReplayTimeout,
} from "./inbox-replay-lane";
import { beginSyncInflight } from "../store/syncActivity";
import {
  applyScopeLifecycleEvent,
  buildCatchUpRunner,
  handleUnauthorizedScope,
  isPurgedTeamHead,
  resetTeamResyncCaches,
  scopedCatchUpScopes,
  stampCatchUpScope,
  sweepAfterHeads,
  teamIdFromScopeKey,
  useScopedSyncChangeFeed,
} from "./use-scope-subscriptions";
import {
  batchGet,
  queryReplay,
  settleDisownClaims,
  type Collection,
} from "./sync-feed-rows";

const api = _api as any;
export { batchGet, chunkIds, BYIDS_CHUNK } from "./sync-feed-rows";

const ENTITY_COLLECTION: Record<string, Collection> = {
  conversations: "sessions",
  tasks: "tasks",
  docs: "docs",
  plans: "plans",
  projects: "projects",
};

const COLLECTIONS: Collection[] = [
  "sessions",
  "tasks",
  "docs",
  "plans",
  "projects",
];

// Single definition lives in the store (stampSyncAck's immediate-retire branch
// reads the same key); re-exported here for the applier's tests.
export const scopeMetaKey = syncLogScopeMetaKey;

const RANGE_LIMIT = 500;

// Latches off for the session if the server rejects the `cargo` arg (a web
// bundle that shipped before its convex deploy, or a convex revert): catch-up
// then runs on thin rows + byIds instead of dying — the same self-heal shape as
// the dispatch ack flag.
let cargoSupported = true;

function cargoEnabled(): boolean {
  if (!cargoSupported) return false;
  try {
    return (
      typeof localStorage === "undefined" ||
      localStorage.getItem("SYNCLOG_CARGO_OFF") !== "1"
    );
  } catch {
    return true;
  }
}

async function queryRange(
  convex: any,
  args: Record<string, any>,
  signal: AbortSignal,
): Promise<any> {
  const withCargo = cargoEnabled();
  try {
    return await queryReplay(
      convex,
      api.syncLog.getRange,
      {
        ...args,
        ...(withCargo ? { cargo: true } : {}),
      },
      signal,
    );
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (
      !signal.aborted &&
      withCargo &&
      /ArgumentValidationError/i.test(msg) &&
      /cargo/.test(msg)
    ) {
      cargoSupported = false;
      console.warn(
        "[syncLog] server lacks cargo — falling back to thin ranges",
      );
      return await queryReplay(convex, api.syncLog.getRange, args, signal);
    }
    throw e;
  }
}
const MAX_RANGE_PAGES = 50;
// Head-movement debounce: positions are cumulative, so batching bursts loses
// nothing; it just turns a fan-out's write burst into one catch-up cycle.
const HEADS_DEBOUNCE_MS = 1500;
// Safety-net interval; the subscription + wake events are the real triggers.
const TICK_MS = 60_000;

export type FeedChange = { entity_type: string; entity_id: string };

export function emptyIdsByCollection(): Record<Collection, string[]> {
  return { sessions: [], tasks: [], docs: [], plans: [], projects: [] };
}

// Pure: collapse change events into per-collection deduped id lists — the
// applyEntityIds input. The op is deliberately ignored: deletion truth is
// authorized absence (the byIds fetch omitting the id), never the event's op,
// so upserts and deletes take the same path. Used by the log applier;
// unit-tested.
export function planFeedApply(
  changes: FeedChange[],
): Record<Collection, string[]> {
  const plan = emptyIdsByCollection();
  const seen = new Set<string>();
  for (const c of changes) {
    const coll = ENTITY_COLLECTION[c.entity_type];
    if (!coll) continue;
    const key = `${coll}:${c.entity_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    plan[coll].push(c.entity_id);
  }
  return plan;
}

// Stage two: fetch current state for a set of per-collection ids, overlay what
// the authorized query returned, prune what it omitted. Shared by the log
// applier and the sessions floor's warm-cache probe; apply
// is idempotent. `fromLog` marks the ids as a change stream's rather than a
// surface's own request: a session this replica does not hold enters only if
// hydration would keep it (admitUnheldSessions). The log carries every write to
// every session the viewer owns, and a bulk restamp of old ones (a team mapping
// backfill re-resolving each session in a repository) otherwise streams the
// viewer's whole history back into a map that never prunes. Measured
// 2026-10-08: 1,200 rows at boot, 10,400 half an hour later, and every
// O(sessions) subscriber paying for all of them on each push.
export async function applyEntityIds(
  convex: any,
  idsByCollection: Record<Collection, string[]>,
  opts: { fromLog?: boolean; signal?: AbortSignal } = {},
): Promise<Set<string>> {
  const applied = new Set<string>();
  const store = useInboxStore.getState();
  for (const coll of COLLECTIONS) {
    const ids = idsByCollection[coll];
    if (!ids?.length) continue;
    // Lift any prior exclude so a re-shared / restored entity isn't skipped by
    // the delta merge, THEN overlay current state.
    checkReplaySignal(opts.signal);
    store.clearFeedExcludes(coll, ids);
    const rows = await batchGet(convex, coll, ids, opts.signal);
    checkReplaySignal(opts.signal);
    const state = useInboxStore.getState();
    let admitted = rows;
    if (coll === "sessions" && opts.fromLog) {
      const unheld = rows.filter(
        (r: any) => heldRow(state, coll, String(r._id)) === undefined,
      );
      if (unheld.length) {
        const ok = new Set(
          admitUnheldSessions(
            unheld,
            Object.values(state.sessions),
            state.liveInboxIdList,
            state.currentSessionId,
            Date.now(),
          ),
        );
        admitted = rows.filter((r: any) => !unheld.includes(r) || ok.has(r));
      }
    }
    if (admitted.length)
      store.syncTable(coll, admitted as any, { isDelta: true } as any);
    const present = new Set(rows.map((r: any) => String(r._id)));
    for (const id of ids) {
      if (present.has(id)) applied.add(`${coll}:${id}`);
    }
    // An id the authorized query did NOT return is gone or no longer visible —
    // prune it (durable exclude). This is the ONLY deletion path: a log
    // `delete` action never prunes by itself (it is scope-local).
    const missing = ids.filter((id) => !present.has(id));
    if (missing.length) store.pruneFeedEntities(coll, missing);
  }
  return applied;
}

// Does this replica hold the entity? Sessions have three twins (the inbox
// row, the conversation meta and the message list) and a per-view open
// conversation can be held without an inbox row, so a delete probe must count
// all three — pruneFeedEntities clears all three.
function heldRow(state: any, coll: Collection, id: string): any {
  const row = state[coll]?.[id];
  if (row !== undefined || coll !== "sessions") return row;
  return state.conversations?.[id] ?? state.messages?.[id];
}

type LogAction = {
  position: number;
  entity_type: string;
  entity_id: string;
  op: string;
  // Cargo (sync-log-cargo E1/E6): present when the server shipped the changed
  // fields; absent means "fetch through byIds" (old rows, kill switch).
  patch?: Record<string, any>;
  unset?: string[];
  full?: boolean;
  partial?: boolean;
};

// Apply one scope's range page: scope lifecycle first, then acked-pending
// retirement (BEFORE the overlay, so authoritative post-write rows land
// unblocked), then stage two, then the cursor advance. `purgedTeams` collects
// team ids revoked in this page so the caller's heads loop can skip their
// (stale) heads instead of restamping a cursor the purge just dropped.
async function applyLogPage(
  convex: any,
  scopeKey: string,
  actions: LogAction[],
  upTo: number,
  purgedTeams: Set<string>,
  signal: AbortSignal,
): Promise<void> {
  const store = useInboxStore.getState();
  const entityActions: LogAction[] = [];
  const disowned = new Set<string>();
  for (const a of actions) {
    if (a.entity_type === "scope") {
      applyScopeLifecycleEvent(store, a.op, a.entity_id, purgedTeams);
      continue;
    }
    if (a.entity_type === "member") {
      const memberTeamId = teamIdFromScopeKey(scopeKey);
      if (a.op === "scope_removed" && memberTeamId) {
        store.purgeMemberTeamRows(memberTeamId, a.entity_id);
      }
      continue;
    }
    if (a.entity_type === "session_owner") {
      const prefix = "session-owner:";
      if (a.op === "scope_removed" && a.entity_id.startsWith(prefix))
        disowned.add(a.entity_id.slice(prefix.length));
      continue;
    }
    entityActions.push(a);
  }
  store.retireAckedPending(scopeKey, upTo);
  // Cargo first (E6): actions that carry their fields apply directly through
  // the store's pending-aware merge; everything else — deletes (authorized
  // absence, E5), rows with no base, partial cargo, and enrichment triggers —
  // goes through the byIds path exactly as before. Dedupe keeps the LAST
  // action per entity (planFeedApply's rule), so a coalesced page applies once.
  const byIds: FeedChange[] = [];
  const covered = inboxSnapshotCoverage(convex, scopeKey);
  const refreshCovered: string[] = [];
  const latest = new Map<string, LogAction>();
  for (const a of entityActions)
    latest.set(`${a.entity_type}:${a.entity_id}`, a);
  let direct = 0;
  const state = useInboxStore.getState();
  // The page's direct writes are collected and applied in one store action
  // each (seeds per collection, cargo merges together): a store action costs
  // O(collection) however few rows it touches, so one per row froze the tab
  // for seconds a page while a restamp backlog drained.
  const seeds = new Map<Collection, any[]>();
  const merges: Array<{
    action: LogAction;
    refetch: boolean;
    item: CargoItem;
  }> = [];
  for (const a of latest.values()) {
    const coll = ENTITY_COLLECTION[a.entity_type];
    if (
      !coll ||
      (coll === "sessions" && a.op === "upsert" && disowned.has(a.entity_id))
    )
      continue;
    if (
      coll === "sessions" &&
      covered &&
      a.position <= covered.position &&
      covered.ids.has(a.entity_id)
    ) {
      if (a.op === "upsert") refreshCovered.push(a.entity_id);
      continue;
    }
    const existing = heldRow(state, coll, a.entity_id);
    if (a.op !== "upsert") {
      // A delete for an id this replica does not hold has nothing to prune and
      // needs no authorized-absence probe (review: private rows in a team used
      // to cost every member a byIds call per edit).
      if (existing !== undefined) byIds.push(a);
      continue;
    }
    if (!a.patch) {
      byIds.push(a);
      continue;
    }
    if (a.full && !existing) {
      // A sessions row is never seeded from cargo: an inbox row must carry
      // its triage stamps and liveness facts (the projection strips them),
      // and a stamp-less seed would render as a blank card. byIds only.
      if (coll === "sessions") {
        byIds.push(a);
        continue;
      }
      // A whole raw document with no base: lift any exclude and seed the row,
      // then refetch — a full cargo is the document minus churn/denylisted
      // fields and carries none of the enrichment joins, so the seed makes the
      // row visible now and byIds completes it a round trip later.
      const plan = planCargoApply(coll, a, undefined);
      const rows = seeds.get(coll) ?? [];
      rows.push({ _id: a.entity_id, ...plan.fields });
      seeds.set(coll, rows);
      direct++;
      byIds.push(a);
      continue;
    }
    if (!existing) {
      byIds.push(a);
      continue;
    }
    // A full cargo WITH a base merges like any patch (review): overlaying it
    // wholesale would drop the row's enrichment and churn fields.
    const plan = planCargoApply(coll, a, existing);
    merges.push({
      action: a,
      refetch: !!plan.refetch,
      item: { coll, id: a.entity_id, fields: plan.fields, unset: plan.unset },
    });
  }
  for (const [coll, rows] of seeds) {
    state.clearFeedExcludes(
      coll,
      rows.map((r) => r._id),
    );
    state.syncTable(coll, rows as any, { isDelta: true } as any);
  }
  if (merges.length) {
    const applied = state.applyCargoBatch(merges.map((m) => m.item));
    merges.forEach((m, i) => {
      if (!applied[i]) {
        byIds.push(m.action);
        return;
      }
      direct++;
      if (m.refetch) byIds.push(m.action);
    });
  }
  state.noteSyncLogApply(direct, byIds.length);
  tallyApply(direct, byIds.length);
  if (byIds.length)
    await applyEntityIds(convex, planFeedApply(byIds), {
      fromLog: true,
      signal,
    });
  if (refreshCovered.length) {
    const rows = await batchGet(convex, "sessions", refreshCovered, signal);
    checkReplaySignal(signal);
    if (rows.length) store.syncTable("sessions", rows, { isDelta: true });
  }
  if (disowned.size) await settleDisownClaims(convex, [...disowned], signal);
  checkReplaySignal(signal);
  store.recordSyncMeta(scopeMetaKey(scopeKey), { cursor: upTo });
  retireInboxSnapshot(convex, scopeKey, upTo);
}

// synclog_apply telemetry (E6/E10 acceptance signal): the direct-vs-refetch
// tally, flushed at most once a minute while there is something to report and
// when the tab hides. Only the sync host applies pages, so followers emit none.
let applyTally = { direct: 0, refetch: 0, resyncs: 0 };
let flushTimer: ReturnType<typeof setTimeout> | null = null;
function flushApplyTally(): void {
  flushTimer = null;
  const { direct, refetch, resyncs } = applyTally;
  if (!direct && !refetch && !resyncs) return;
  applyTally = { direct: 0, refetch: 0, resyncs: 0 };
  if (direct || refetch)
    track("synclog_apply", {
      direct,
      refetch,
      ratio: direct / (direct + refetch),
    });
  if (resyncs) track("synclog_resync", { count: resyncs });
}
function tallyApply(direct: number, refetch: number, resyncs = 0): void {
  applyTally.direct += direct;
  applyTally.refetch += refetch;
  applyTally.resyncs += resyncs;
  if (!flushTimer) flushTimer = setTimeout(flushApplyTally, 60_000);
}
if (
  typeof document !== "undefined" &&
  typeof document.addEventListener === "function"
) {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushApplyTally();
  });
}

type ScopeHead = { scope_key: string; position: number; floor: number };

function resetScopeForResync(
  head: ScopeHead,
  opts: { recutFloors?: boolean } = {},
): void {
  tallyApply(0, 0, 1);
  const metaKey = scopeMetaKey(head.scope_key);
  const s = useInboxStore.getState();
  s.clearSyncMeta(metaKey);
  s.clearCrawlMetaForScope(head.scope_key);
  resetTeamResyncCaches(s, head.scope_key);
  s.recordSyncMeta(metaKey, { cursor: head.position });
  s.retireAckedPending(head.scope_key, head.position);
  if (opts.recutFloors !== false) s.bumpSyncLogFloorEpoch();
}

export async function catchUpScope(
  convex: any,
  head: ScopeHead,
  purgedTeams: Set<string>,
  account = inboxReplaySignal(convex),
): Promise<void> {
  checkReplaySignal(account);
  const store = useInboxStore.getState();
  const metaKey = scopeMetaKey(head.scope_key);
  const meta = store.syncMeta[metaKey];
  const resetForResync = () => resetScopeForResync(head);

  if (meta?.cursor === undefined) {
    resetForResync();
    return;
  }
  if (head.floor > meta.cursor) {
    // Retention passed our cursor while we were away: the log can no longer
    // prove the gap, so fall back to the cold-backfill contract.
    resetForResync();
    return;
  }
  let from = meta.cursor;
  for (let page = 0; page < MAX_RANGE_PAGES && from < head.position; page++) {
    // Cargo opt-in rides the range call (this client applies patches);
    // localStorage SYNCLOG_CARGO_OFF is the client-side kill switch.
    const res = await withReplayTimeout(account, (signal) =>
      queryRange(
        convex,
        { scope_key: head.scope_key, from, limit: RANGE_LIMIT },
        signal,
      ),
    );
    checkReplaySignal(account);
    if (!res) return;
    if (res.authorized === false) {
      handleUnauthorizedScope(store, head.scope_key, purgedTeams);
      return;
    }
    if (res.resync) {
      resetForResync();
      return;
    }
    if (res.actions?.length) {
      await withInboxReplayLane(convex, head.scope_key, account, (lane) =>
        withReplayTimeout(lane, (signal) =>
          applyLogPage(
            convex,
            head.scope_key,
            res.actions,
            res.nextFrom,
            purgedTeams,
            signal,
          ),
        ),
      );
    } else if (typeof res.nextFrom === "number" && res.nextFrom > from) {
      useInboxStore
        .getState()
        .recordSyncMeta(scopeMetaKey(head.scope_key), { cursor: res.nextFrom });
      retireInboxSnapshot(convex, head.scope_key, res.nextFrom);
    } else if (!res.hasMore) {
      // Empty range below a moving head (coalescing moved rows past us):
      // nothing left to apply — the head subscription will wake us again.
      return;
    }
    from = Math.max(
      from,
      typeof res.nextFrom === "number" ? res.nextFrom : from,
    );
    if (!res.hasMore) return;
  }
}

export async function catchUp(
  convex: any,
  account = inboxReplaySignal(convex),
  opts?: { scopes?: readonly string[] },
): Promise<void> {
  const store = useInboxStore.getState();
  const scopeList = scopedCatchUpScopes(store, opts?.scopes);
  if (scopeList.length === 0) return;
  const res = await withReplayTimeout(account, (signal) =>
    queryReplay(convex, api.syncLog.getHeads, { scopes: scopeList }, signal),
  );
  checkReplaySignal(account);
  if (!res) return;
  const heads: ScopeHead[] = res.heads ?? [];
  const purgedTeams = new Set<string>();
  const cold: ScopeHead[] = [];
  for (const head of heads) {
    const cursor = store.syncMeta[scopeMetaKey(head.scope_key)]?.cursor;
    if (cursor === undefined) cold.push(head);
    store.setSyncLogLag(
      head.scope_key,
      cursor === undefined ? 0 : Math.max(0, head.position - cursor),
    );
  }
  if (cold.length > 0) {
    for (const head of cold) resetScopeForResync(head, { recutFloors: false });
    useInboxStore.getState().bumpSyncLogFloorEpoch();
  }
  for (const head of heads) {
    if (isPurgedTeamHead(head.scope_key, purgedTeams)) continue;
    try {
      await catchUpScope(convex, head, purgedTeams, account);
    } catch (e) {
      if (!account.aborted)
        console.warn("[syncLog] scope catch-up failed", head.scope_key, e);
    } finally {
      useInboxStore.getState().setSyncLogLag(head.scope_key, 0);
    }
    if (account.aborted) return;
    const s = useInboxStore.getState();
    if (s.syncMeta[scopeMetaKey(head.scope_key)]?.cursor !== undefined)
      stampCatchUpScope(s, head.scope_key);
  }
  if (res.authenticated === true)
    sweepAfterHeads(useInboxStore.getState(), heads, scopeList);
}

export function __changeFeedSimSlots() {
  type Slots = {
    cargoSupported: boolean;
    applyTally: typeof applyTally;
    flushTimer: ReturnType<typeof setTimeout> | null;
  };
  return {
    fresh: (): Slots => ({
      cargoSupported: true,
      applyTally: { direct: 0, refetch: 0, resyncs: 0 },
      flushTimer: null,
    }),
    get: (): Slots => ({
      cargoSupported,
      applyTally: { ...applyTally },
      flushTimer,
    }),
    set: (s: Slots): void => {
      cargoSupported = s.cargoSupported;
      applyTally = { ...s.applyTally };
      flushTimer = s.flushTimer;
    },
  };
}

export function createCatchUpRunner(
  convex: any,
  opts: { onError?: (e: unknown) => void; onSettled?: () => void } = {},
) {
  return buildCatchUpRunner(
    convex,
    {
      runCatchUp: catchUp,
      beginInflight: () => beginSyncInflight("range"),
      replaySignal: inboxReplaySignal,
      resetLanes: resetInboxReplayLanes,
    },
    opts,
  );
}

export function useSyncChangeFeed(): void {
  useScopedSyncChangeFeed(createCatchUpRunner, resetInboxReplayLanes, {
    debounceMs: HEADS_DEBOUNCE_MS,
    tickMs: TICK_MS,
  });
}
