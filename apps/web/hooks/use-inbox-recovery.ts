import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { useConvex, type ConvexReactClient } from "convex/react";
import {
  getFunctionName,
  makeFunctionReference,
  type FunctionArgs,
  type FunctionReference,
  type FunctionReturnType,
} from "convex/server";
import { whenInputQuiet } from "../lib/inputQuiet";
import { beginSyncInflight } from "../store/syncActivity";
import {
  LIVENESS_HIDDEN_SUSPEND_GAP_MS,
  LIVENESS_SUSPEND_GAP_MS,
} from "./liveness-hold";
import { onSyncWake } from "./syncWake";
import { subscribeCoarseTick } from "./useCoarseNow";
import { RECOVERY_FETCH_TIMEOUT_MS } from "./useRecoveryPoll";
import { useServerIdentityLost } from "./useServerAuthSettled";
import { queryInboxRecovery, type SplitKind } from "./useSplitQuery";
import { useWatchEffect } from "./useWatchEffect";
import { withInboxReplayLane } from "./inbox-replay-lane";

const RECOVERY_INTERVAL_MS = 15_000;
const MAX_RETRY_DELAY_MS = 60_000;

type Recovery = {
  promise: Promise<boolean>;
  immediate: boolean;
  resolve: (applied: boolean) => void;
};

function startInboxRecovery<Q extends FunctionReference<"query">>(
  convex: ConvexReactClient,
  query: Q,
  queryArgs: FunctionArgs<Q>,
  kind: SplitKind | null,
  apply: (
    data: FunctionReturnType<Q>,
    signal: AbortSignal,
  ) => boolean | Promise<boolean>,
  nextAt: { current: number },
  lastProbe: { current: number },
  snapshotScope?: string,
) {
  let { isWebSocketConnected: connected, connectionCount } =
    convex.connectionState();
  let pending: Recovery | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active: AbortController | null = null;
  let disposed = false;
  let healthy = false;
  let retryDelay = 0;
  let retryAt = 0;
  const canRead = () => !disposed && connected;

  function arm() {
    if (!canRead() || !pending || active || timer !== null) return;
    timer = setTimeout(
      () => {
        timer = null;
        if (canRead() && pending) void read(pending);
      },
      Math.max(
        Math.max(nextAt.current, retryAt) - Date.now(),
        pending.immediate ? 0 : Math.random() * RECOVERY_INTERVAL_MS,
      ),
    );
  }

  async function read(recovery: Recovery) {
    recovery.immediate = false;
    const now = Date.now();
    nextAt.current = now + RECOVERY_INTERVAL_MS;
    lastProbe.current = Math.max(now, lastProbe.current + 1);
    const controller = new AbortController();
    active = controller;
    const { signal } = controller;
    const timeout = setTimeout(
      () => controller.abort(),
      RECOVERY_FETCH_TIMEOUT_MS,
    );
    const endActivity = beginSyncInflight("poll");
    let applied = false;
    const fetchAndApply = async (signal: AbortSignal) => {
      if (signal.aborted || !canRead()) return false;
      const fresh = await queryInboxRecovery(
        convex,
        query,
        queryArgs,
        kind,
        signal,
        lastProbe.current,
      );
      if (signal.aborted || !canRead()) return false;
      return new Promise<boolean>((resolve, reject) => {
        let cancel: (() => void) | undefined;
        const abort = () => {
          cancel?.();
          resolve(false);
        };
        signal.addEventListener("abort", abort, { once: true });
        cancel = whenInputQuiet(() => {
          signal.removeEventListener("abort", abort);
          try {
            resolve(
              !signal.aborted && canRead() ? apply(fresh, signal) : false,
            );
          } catch (error) {
            reject(error);
          }
        }, 1500);
      });
    };
    try {
      applied = await (snapshotScope
        ? withInboxReplayLane(convex, snapshotScope, signal, fetchAndApply)
        : fetchAndApply(signal));
    } catch (error) {
      if (
        !signal.aborted &&
        !(error instanceof Error && error.name === "AbortError")
      )
        console.warn("[inbox recovery] query failed", error);
    } finally {
      clearTimeout(timeout);
      active = null;
      endActivity();
      if (pending === recovery) {
        if (applied || !canRead()) {
          healthy = applied;
          finish(applied);
        } else {
          retryDelay = Math.min(
            MAX_RETRY_DELAY_MS,
            Math.max(RECOVERY_INTERVAL_MS, retryDelay * 2),
          );
          retryAt = Date.now() + retryDelay;
        }
      }
      arm();
    }
  }

  function finish(applied: boolean) {
    const recovery = pending;
    pending = null;
    retryDelay = 0;
    retryAt = 0;
    recovery?.resolve(applied);
  }

  function request(immediate = false): Promise<boolean> {
    if (disposed) return Promise.resolve(false);
    healthy = false;
    if (!pending) {
      let resolve!: (applied: boolean) => void;
      const promise = new Promise<boolean>((finish) => {
        resolve = finish;
      });
      pending = { promise, resolve, immediate };
    }
    arm();
    return pending.promise;
  }

  const offConnection = convex.subscribeToConnectionState((state) => {
    const disconnected = connected && !state.isWebSocketConnected;
    const reconnected = state.connectionCount > Math.max(1, connectionCount);
    connected = state.isWebSocketConnected;
    connectionCount = state.connectionCount;
    if (disconnected) {
      healthy = false;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      finish(false);
      active?.abort();
    } else if (reconnected) void request();
    else arm();
  });

  let lastTick = Date.now();
  const isHidden = () =>
    typeof document !== "undefined" && document.visibilityState === "hidden";
  let wasHidden = isHidden();
  const wake = () => {
    lastTick = Date.now();
    wasHidden = isHidden();
    void request();
  };
  const offWake = onSyncWake(wake);
  const offTick = subscribeCoarseTick(RECOVERY_INTERVAL_MS, () => {
    const now = Date.now();
    const gap = wasHidden
      ? LIVENESS_HIDDEN_SUSPEND_GAP_MS
      : LIVENESS_SUSPEND_GAP_MS;
    if (now - lastTick > gap) wake();
    else {
      lastTick = now;
      wasHidden = isHidden();
    }
  });

  return {
    request,
    isHealthy: () => healthy && canRead() && !pending && !active,
    acceptLive: () => {
      if (canRead()) healthy = true;
    },
    dispose: () => {
      disposed = true;
      offConnection();
      offWake();
      offTick();
      if (timer !== null) clearTimeout(timer);
      active?.abort();
      finish(false);
    },
  };
}

export function useInboxRecovery<Q extends FunctionReference<"query">>(
  query: Q,
  args: FunctionArgs<Q> | "skip",
  kind: SplitKind | null,
  error: Error | undefined,
  apply: (
    data: FunctionReturnType<Q>,
    signal: AbortSignal,
  ) => boolean | Promise<boolean>,
  bootstrapGeneration?: number,
  snapshotScope?: string,
) {
  const convex = useConvex();
  const lost = useServerIdentityLost();
  const queryName = getFunctionName(query);
  const reference = useMemo(
    () =>
      makeFunctionReference<"query", FunctionArgs<Q>, FunctionReturnType<Q>>(
        queryName,
      ),
    [queryName],
  );
  const recovery = useRef<ReturnType<typeof startInboxRecovery> | null>(null);
  const nextAt = useRef(0);
  const lastProbe = useRef(0);
  const previous = useRef({ snapshotScope, bootstrapGeneration });

  useLayoutEffect(() => {
    if (
      previous.current.bootstrapGeneration !== bootstrapGeneration ||
      previous.current.snapshotScope !== snapshotScope
    ) {
      previous.current = { snapshotScope, bootstrapGeneration };
      nextAt.current = 0;
    }
    if (args === "skip" || lost) return;
    const controller = startInboxRecovery<typeof reference>(
      convex,
      reference,
      args,
      kind,
      apply,
      nextAt,
      lastProbe,
      snapshotScope,
    );
    recovery.current = controller;
    if (bootstrapGeneration !== undefined) void controller.request(true);
    return () => {
      recovery.current = null;
      controller.dispose();
    };
  }, [
    convex,
    reference,
    args,
    kind,
    apply,
    lost,
    bootstrapGeneration,
    snapshotScope,
  ]);

  useWatchEffect(() => {
    if (error) void recovery.current?.request();
  }, [error, convex, reference, args, kind, apply, lost]);

  return {
    request: useCallback(
      () => recovery.current?.request() ?? Promise.resolve(false),
      [],
    ),
    isHealthy: useCallback(() => recovery.current?.isHealthy() ?? false, []),
    acceptLive: useCallback(() => recovery.current?.acceptLive(), []),
  };
}
