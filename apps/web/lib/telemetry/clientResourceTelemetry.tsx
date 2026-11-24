import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useConvexAuth } from "convex/react";
import { REGISTERED_COLLECTION_KEYS } from "../../store/clientSyncRegistry";
import { useInboxStore } from "../../store/inboxStore";
import { getPlatform, isRegulatedData, track } from "../analytics";
import { watchLongFrameStats } from "../freezeAttribution";
import { msUntilInputQuiet, TYPING_QUIET_MS } from "../inputQuiet";
import { getWindowRole } from "../windowRole";
import {
  buildClientResourceReport,
  estimateCollectionBytes,
  isClientResourceReportWindow,
  shouldReportClientResources,
  type CollectionSample,
} from "./clientResourceReport";

const FIRST_REPORT_MS = 60_000;
const REPORT_INTERVAL_MS = 10 * 60_000;
const WINDOW_LOCK = "codecast-client-resource-window";
let lastReportAt = -Infinity;

function* sampleCollections(): Generator<CollectionSample> {
  for (const key of REGISTERED_COLLECTION_KEYS) {
    const rows = useInboxStore.getState()[key];
    const ids = Object.keys(rows);
    const count = ids.length;
    const samples =
      count <= 3 ? ids : [ids[0], ids[Math.floor(count / 2)], ids[count - 1]];
    yield {
      key,
      count,
      estimatedBytes: estimateCollectionBytes(
        samples.map((id) => rows[id]),
        count,
      ),
    };
  }

  const messages = useInboxStore.getState().messages;
  const groups = Object.keys(messages);
  let count = 0;
  const samples = [];
  for (const id of groups) {
    const rows = messages[id];
    count += rows.length;
    if (rows.length && samples.length < 3)
      samples.push(rows[Math.floor(rows.length / 2)]);
  }
  yield {
    key: "messages",
    count,
    estimatedBytes: estimateCollectionBytes(samples, count),
  };
}

function startClientResourceTelemetry(
  windowRole: ReturnType<typeof getWindowRole>,
): () => void {
  const frames = watchLongFrameStats();
  const locks = navigator.locks;
  let releaseWindow: (() => void) | undefined;
  if (locks) {
    // One shared hold per app window. The browser drops it when the window closes.
    const hold = new Promise<void>((resolve) => {
      releaseWindow = resolve;
    });
    void locks
      .request(WINDOW_LOCK, { mode: "shared" }, () => hold)
      .catch(() => {});
  }

  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  let idle: number | undefined;
  const eligible = () =>
    !isRegulatedData() &&
    shouldReportClientResources(
      windowRole,
      document.hidden,
      useInboxStore.getState().syncRole,
    );

  function schedule(delay: number) {
    timer = setTimeout(begin, delay);
  }

  async function emit(collections: CollectionSample[]) {
    const [storage, lockSnapshot] = await Promise.all([
      navigator.storage?.estimate?.().catch(() => undefined),
      locks?.query().catch(() => undefined),
    ]);
    if (stopped) return;
    if (eligible()) {
      const memory = (
        performance as Performance & {
          memory?: { usedJSHeapSize: number; totalJSHeapSize: number };
        }
      ).memory;
      const windowCount = lockSnapshot?.held?.filter(
        ({ name }) => name === WINDOW_LOCK,
      ).length;
      lastReportAt = performance.now();
      track(
        "client_resource_report",
        buildClientResourceReport({
          platform: getPlatform(),
          syncRole: useInboxStore.getState().syncRole,
          windowRole,
          windowCount: windowCount || undefined,
          memory,
          collections,
          storage,
          longFrames: frames.take(),
        }),
      );
    }
    schedule(REPORT_INTERVAL_MS);
  }

  function begin() {
    if (!eligible()) {
      schedule(FIRST_REPORT_MS);
      return;
    }
    const samples = sampleCollections();
    const collections: CollectionSample[] = [];

    function queueSlice() {
      const wait = msUntilInputQuiet(TYPING_QUIET_MS);
      if (wait > 0) {
        timer = setTimeout(queueSlice, Math.ceil(wait));
      } else if (typeof requestIdleCallback === "function") {
        idle = requestIdleCallback(collectSlice, { timeout: 1_000 });
      } else {
        timer = setTimeout(collectSlice, 0);
      }
    }

    function collectSlice(deadline?: IdleDeadline) {
      idle = undefined;
      if (!eligible()) {
        schedule(FIRST_REPORT_MS);
        return;
      }
      if (msUntilInputQuiet(TYPING_QUIET_MS) > 0) {
        queueSlice();
        return;
      }
      // Count one collection at minimum so a hidden sync host can make progress.
      const end = performance.now() + 3;
      do {
        const sample = samples.next();
        if (sample.done) {
          void emit(collections);
          return;
        }
        collections.push(sample.value);
      } while (
        performance.now() < end &&
        (!deadline || deadline.timeRemaining() > 1)
      );
      queueSlice();
    }

    queueSlice();
  }

  schedule(
    Math.max(
      FIRST_REPORT_MS,
      lastReportAt + REPORT_INTERVAL_MS - performance.now(),
    ),
  );
  return () => {
    stopped = true;
    clearTimeout(timer);
    if (idle !== undefined) cancelIdleCallback(idle);
    frames.stop?.();
    releaseWindow?.();
  };
}

export function ClientResourceTelemetry() {
  const { isAuthenticated } = useConvexAuth();
  useWatchEffect(() => {
    const role = getWindowRole();
    if (isAuthenticated && isClientResourceReportWindow(role)) {
      return startClientResourceTelemetry(role);
    }
  }, [isAuthenticated]);
  return null;
}
