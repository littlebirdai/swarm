import { isConvexId } from "../lib/entityLinks";
import { isDetailPinned } from "../lib/detail-rows";
import { msUntilInputQuiet, TYPING_QUIET_MS } from "../lib/inputQuiet";
import { whileWindowVisible } from "../lib/windowVisibleWork";
import { withCacheEvictions } from "./cache-eviction";
import {
  partitionDocDetailRetention,
  pendingDocDetailIds,
} from "./cacheRetention";
import {
  compactPersistedDocDetails,
  pruneCachedDocDetails,
} from "./doc-detail-disk";
import { _hydrating } from "./persistence/hydration";
import type { InboxStoreState } from "./inboxStore";

const SWEEP_MS = 5 * 60_000;
const BATCH_SIZE = 64;
const YIELD_MS = 16;

function* docIds(rows: InboxStoreState["docDetails"]): Generator<string, void> {
  for (const id in rows) yield id;
}

function protectDocDetails(state: InboxStoreState) {
  const pending = pendingDocDetailIds(state.pending);
  return (id: string) =>
    !!state.docs[id]?.pinned ||
    pending.has(id) ||
    isDetailPinned("docDetails", id);
}

export function startTimedDocRetention(
  getState: () => InboxStoreState,
  canSweep: () => boolean,
  ownsDisk: () => boolean = () => false,
) {
  if (typeof document === "undefined") return { soon() {}, stop() {} };

  const visibility = document;
  let stopped = false;
  let pruning = false;
  const canPrune = () =>
    !stopped &&
    !visibility.hidden &&
    ownsDisk() &&
    !_hydrating &&
    msUntilInputQuiet(TYPING_QUIET_MS) <= 0;
  let timer: ReturnType<typeof setTimeout>;
  let sweep:
    | {
        rows: InboxStoreState["docDetails"];
        ids: ReturnType<typeof docIds>;
        keep: InboxStoreState["docDetails"][string][];
        now: number;
      }
    | undefined;

  const schedule = (delay: number) => {
    clearTimeout(timer);
    if (!stopped && !visibility.hidden) timer = setTimeout(step, delay);
  };

  function step() {
    if (stopped || visibility.hidden) return;
    if (!canSweep()) {
      sweep = undefined;
      schedule(SWEEP_MS);
      return;
    }
    if (_hydrating) {
      schedule(YIELD_MS);
      return;
    }
    const quiet = msUntilInputQuiet(TYPING_QUIET_MS);
    if (quiet > 0) {
      schedule(Math.ceil(quiet));
      return;
    }
    const state = getState();
    const protectedId = protectDocDetails(state);
    sweep ??= {
      rows: state.docDetails,
      ids: docIds(state.docDetails),
      keep: [],
      now: Date.now(),
    };
    const candidates = sweep.keep.filter(
      (row) => state.docDetails[row._id] === row && !protectedId(row._id),
    );
    let done = false;
    for (let i = 0; i < BATCH_SIZE; i++) {
      const next: IteratorResult<string, void> = sweep.ids.next();
      if (next.done) {
        done = true;
        break;
      }
      const id = next.value;
      const row = sweep.rows[id];
      if (row === state.docDetails[id] && !protectedId(id))
        candidates.push(row);
    }
    const { keep, drop } = partitionDocDetailRetention(candidates, sweep.now);
    sweep.keep = keep.filter((row) => !row.pinned && isConvexId(row._id));
    const evictions = drop.flatMap((id) => {
      const observed = sweep!.rows[id];
      return observed === state.docDetails[id] && !protectedId(id)
        ? [{ key: "docDetails", id, observed }]
        : [];
    });
    if (evictions.length) {
      const ids = evictions.map(({ id }) => id);
      withCacheEvictions(evictions, () => state.dropRows("docDetails", ids));
      compactPersistedDocDetails(
        ids.filter((id) => !getState().docDetails[id]),
      );
    }

    if (done) {
      sweep = undefined;
      if (!pruning && canPrune()) {
        pruning = true;
        void pruneCachedDocDetails(canPrune, () => {
          const live = getState();
          const protectedId = protectDocDetails(live);
          return (id) => !!live.docDetails[id] || protectedId(id);
        })
          .catch(() => {})
          .finally(() => {
            pruning = false;
          });
      }
    }
    schedule(done ? SWEEP_MS : YIELD_MS);
  }

  const pause = whileWindowVisible(() => {
    schedule(0);
    return () => {
      sweep = undefined;
      clearTimeout(timer);
    };
  });
  return {
    soon() {
      if (!sweep) schedule(0);
    },
    stop() {
      stopped = true;
      pause();
    },
  };
}
