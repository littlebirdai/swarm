import { isConvexId } from "../lib/entityLinks";
import { isDetailPinned } from "../lib/detail-rows";
import { msUntilInputQuiet, TYPING_QUIET_MS } from "../lib/inputQuiet";
import { timedDocCapsEnabled, withCacheEvictions } from "./cache-eviction";
import {
  partitionDocDetailRetention,
  pendingDocDetailIds,
} from "./cacheRetention";
import { _hydrating } from "./persistence/hydration";
import type { InboxStoreState } from "./inboxStore";

const SWEEP_MS = 5 * 60_000;
const BATCH_SIZE = 64;
const YIELD_MS = 16;

function* docIds(rows: InboxStoreState["docDetails"]): Generator<string, void> {
  for (const id in rows) yield id;
}

export function startTimedDocRetention(
  getState: () => InboxStoreState,
  canSweep: () => boolean,
) {
  if (!timedDocCapsEnabled() || typeof document === "undefined")
    return { soon() {}, stop() {} };

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
    timer = setTimeout(step, delay);
  };

  function step() {
    if (document.visibilityState === "hidden" || !canSweep()) {
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
    const pending = pendingDocDetailIds(state.pending);
    const protectedId = (id: string) =>
      pending.has(id) || isDetailPinned("docDetails", id);
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
    if (evictions.length)
      withCacheEvictions(evictions, () =>
        state.dropRows(
          "docDetails",
          evictions.map(({ id }) => id),
        ),
      );

    if (done) sweep = undefined;
    schedule(done ? SWEEP_MS : YIELD_MS);
  }

  schedule(0);
  return {
    soon() {
      if (!sweep) schedule(0);
    },
    stop() {
      clearTimeout(timer);
    },
  };
}
