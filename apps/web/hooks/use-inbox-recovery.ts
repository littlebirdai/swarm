import { useCallback, useMemo, useRef } from "react";
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
import { queryInboxRecovery, type SplitKind } from "./useSplitQuery";
import { useWatchEffect } from "./useWatchEffect";

const RECOVERY_INTERVAL_MS = 15_000;

type Recovery = {
  promise: Promise<boolean>;
  resolve: (applied: boolean) => void;
};

function startInboxRecovery<Q extends FunctionReference<"query">>(
  convex: ConvexReactClient,
  query: Q,
  queryArgs: FunctionArgs<Q>,
  kind: SplitKind | null,
  apply: (data: FunctionReturnType<Q>) => boolean,
  nextAt: { current: number },
) {
  let { isWebSocketConnected: connected, connectionCount } =
    convex.connectionState();
  let pending: Recovery | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active: AbortController | null = null;
  let disposed = false;
  let healthy = false;

  function arm() {
    if (disposed || !pending || !connected || active || timer !== null) return;
    timer = setTimeout(
      () => {
        timer = null;
        if (connected && pending) void read(pending);
      },
      Math.max(
        nextAt.current - Date.now(),
        Math.random() * RECOVERY_INTERVAL_MS,
      ),
    );
  }

  async function read(recovery: Recovery) {
    pending = null;
    nextAt.current = Date.now() + RECOVERY_INTERVAL_MS;
    const controller = new AbortController();
    active = controller;
    const { signal } = controller;
    const timeout = setTimeout(
      () => controller.abort(),
      RECOVERY_FETCH_TIMEOUT_MS,
    );
    const endActivity = beginSyncInflight("poll");
    let applied = false;
    try {
      const fresh = await queryInboxRecovery(
        convex,
        query,
        queryArgs,
        kind,
        signal,
      );
      if (signal.aborted) return;
      applied = await new Promise<boolean>((resolve, reject) => {
        let cancel: (() => void) | undefined;
        const abort = () => {
          cancel?.();
          resolve(false);
        };
        signal.addEventListener("abort", abort, { once: true });
        cancel = whenInputQuiet(() => {
          signal.removeEventListener("abort", abort);
          try {
            resolve(apply(fresh));
          } catch (error) {
            reject(error);
          }
        }, 1500);
      });
    } catch (error) {
      if (!signal.aborted) console.warn("[inbox recovery] query failed", error);
    } finally {
      clearTimeout(timeout);
      active = null;
      endActivity();
      if (applied) healthy = true;
      recovery.resolve(applied);
      arm();
    }
  }

  function request(): Promise<boolean> {
    healthy = false;
    if (!pending) {
      let resolve!: (applied: boolean) => void;
      const promise = new Promise<boolean>((finish) => {
        resolve = finish;
      });
      pending = { promise, resolve };
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
      if (timer !== null) clearTimeout(timer);
      timer = null;
      active?.abort();
    }
    if (disconnected || reconnected) void request();
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
    isHealthy: () => healthy && connected && !pending && !active,
    acceptLive: () => {
      healthy = true;
    },
    dispose: () => {
      disposed = true;
      offConnection();
      offWake();
      offTick();
      if (timer !== null) clearTimeout(timer);
      active?.abort();
      pending?.resolve(false);
    },
  };
}

export function useInboxRecovery<Q extends FunctionReference<"query">>(
  query: Q,
  args: FunctionArgs<Q> | "skip",
  kind: SplitKind | null,
  error: Error | undefined,
  apply: (data: FunctionReturnType<Q>) => boolean,
) {
  const convex = useConvex();
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

  useWatchEffect(() => {
    if (args === "skip") return;
    const controller = startInboxRecovery<typeof reference>(
      convex,
      reference,
      args,
      kind,
      apply,
      nextAt,
    );
    recovery.current = controller;
    return () => {
      recovery.current = null;
      controller.dispose();
    };
  }, [convex, reference, args, kind, apply]);

  useWatchEffect(() => {
    if (error) void recovery.current?.request();
  }, [error, convex, reference, args, kind, apply]);

  return {
    request: useCallback(
      () => recovery.current?.request() ?? Promise.resolve(false),
      [],
    ),
    isHealthy: useCallback(() => recovery.current?.isHealthy() ?? false, []),
    acceptLive: useCallback(() => recovery.current?.acceptLive(), []),
  };
}
