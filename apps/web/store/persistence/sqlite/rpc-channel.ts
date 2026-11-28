import {
  addressedChannelName,
  epochChannelName,
  epochId,
  type CacheEpoch,
  type ChannelEndpoint,
  type ChannelTransport,
  type SqliteErrorCode,
  type SqliteWorkerOp,
  type SqliteWorkerPayloads,
  type SqliteWorkerRequest,
  type SqliteWorkerResponse,
  type WorkerHandle,
} from "./protocol";

export class WorkerRpcError extends Error {
  constructor(
    readonly code: SqliteErrorCode | "timeout" | "closed",
    message: string,
  ) {
    super(message);
  }
}

export const RETRIABLE_OPS = new Set<SqliteWorkerOp>([
  "ping",
  "loadCache",
  "loadPaintCache",
  "loadConversationMessages",
]);

export type PendingWaiter = {
  id: string;
  epochId: string;
  principal: string | null;
  op: SqliteWorkerOp;
  payload: SqliteWorkerPayloads[SqliteWorkerOp];
  retriable: boolean;
  deadline: number;
  targetWorkerId: string | null;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type RpcChannelState = {
  clientId: string;
  channelTransport: ChannelTransport | null;
  workerTimeoutMs: number;
  now: () => number;
  getState: () => {
    closed: boolean;
    disabled: boolean;
    activeEpoch: CacheEpoch | null;
    ownedWorker: WorkerHandle | null;
    ownedWorkerId: string | null;
    ownedWorkerReady: boolean;
    knownWorkerId: string | null;
    sharedChannel: ChannelEndpoint | null;
  };
  clearKnownWorker: () => void;
  onTimeout: (epoch: CacheEpoch, reason: string) => void;
};

export function createRpcChannelManager(deps: RpcChannelState) {
  const {
    clientId,
    channelTransport,
    workerTimeoutMs,
    now,
    getState,
    clearKnownWorker,
    onTimeout,
  } = deps;

  const readyWaiters = new Set<() => void>();
  const pendingRequests = new Map<string, PendingWaiter>();
  let peerWorkerOutbox: { workerId: string; endpoint: ChannelEndpoint } | null =
    null;

  const closeWorkerOutbox = (matchingWorkerId?: string | null) => {
    if (
      matchingWorkerId !== undefined &&
      peerWorkerOutbox?.workerId !== matchingWorkerId
    )
      return;
    try {
      peerWorkerOutbox?.endpoint.close();
    } catch {}
    peerWorkerOutbox = null;
  };

  const notifyReadyWaiters = () => {
    for (const notify of readyWaiters) notify();
  };

  const settleReject = (id: string, error: unknown) => {
    const waiter = pendingRequests.get(id);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    pendingRequests.delete(id);
    waiter.reject(error);
  };

  const rejectWritesForEpoch = (targetEpochId: string, reason: string) => {
    for (const [id, waiter] of pendingRequests) {
      if (waiter.epochId !== targetEpochId || waiter.retriable) continue;
      settleReject(id, new WorkerRpcError("closed", reason));
    }
  };

  const rejectAll = (reason: string) => {
    for (const [id, waiter] of pendingRequests) {
      clearTimeout(waiter.timer);
      pendingRequests.delete(id);
      waiter.reject(new WorkerRpcError("closed", reason));
    }
  };

  const handleResponse = (msg: SqliteWorkerResponse): boolean => {
    if (typeof msg.id !== "string" || typeof msg.ok !== "boolean") return true;
    const waiter = pendingRequests.get(msg.id);
    if (!waiter || msg.epochId !== waiter.epochId) return true;
    clearTimeout(waiter.timer);
    pendingRequests.delete(msg.id);
    if (msg.ok) waiter.resolve(msg.result);
    else waiter.reject(new WorkerRpcError(msg.code, msg.error));
    return true;
  };

  const currentTargetWorkerId = (): string | null => {
    const { ownedWorker, ownedWorkerReady, ownedWorkerId, knownWorkerId } =
      getState();
    if (ownedWorker && ownedWorkerReady && ownedWorkerId) return ownedWorkerId;
    if (knownWorkerId && channelTransport) return knownWorkerId;
    return null;
  };

  const sendDiscover = (targetEpochId: string) => {
    const { ownedWorker, sharedChannel } = getState();
    if (!ownedWorker && sharedChannel) {
      try {
        sharedChannel.post({
          type: "discover",
          replyTo: clientId,
          epochId: targetEpochId,
        });
      } catch {}
    }
  };

  const dispatchWaiter = (waiter: PendingWaiter): void => {
    const {
      closed,
      disabled,
      activeEpoch,
      ownedWorker,
      ownedWorkerReady,
      ownedWorkerId,
      knownWorkerId,
    } = getState();
    if (
      closed ||
      disabled ||
      !activeEpoch ||
      epochId(activeEpoch) !== waiter.epochId
    ) {
      settleReject(
        waiter.id,
        new WorkerRpcError("closed", "SQLite worker epoch closed"),
      );
      return;
    }
    const request: SqliteWorkerRequest = {
      type: "request",
      id: waiter.id,
      replyTo: clientId,
      epochId: waiter.epochId,
      principal: waiter.principal,
      op: waiter.op,
      payload: waiter.payload,
    };
    if (ownedWorker && ownedWorkerReady && ownedWorkerId) {
      waiter.targetWorkerId = ownedWorkerId;
      try {
        ownedWorker.postMessage(request);
      } catch (error) {
        settleReject(waiter.id, new WorkerRpcError("closed", String(error)));
      }
      return;
    }
    if (knownWorkerId && channelTransport) {
      waiter.targetWorkerId = knownWorkerId;
      try {
        if (!peerWorkerOutbox || peerWorkerOutbox.workerId !== knownWorkerId) {
          closeWorkerOutbox();
          peerWorkerOutbox = {
            workerId: knownWorkerId,
            endpoint: channelTransport.open(
              addressedChannelName(
                epochChannelName(activeEpoch),
                knownWorkerId,
              ),
              () => {},
            ),
          };
        }
        peerWorkerOutbox.endpoint.post(request);
      } catch (error) {
        closeWorkerOutbox();
        clearKnownWorker();
        settleReject(waiter.id, new WorkerRpcError("closed", String(error)));
      }
      return;
    }
    if (!waiter.retriable) {
      settleReject(
        waiter.id,
        new WorkerRpcError("closed", "Worker unavailable for write"),
      );
      return;
    }
    waiter.targetWorkerId = null;
    sendDiscover(waiter.epochId);
  };

  const redispatchForWorkerChange = (
    targetEpochId: string,
    newWorkerId: string | null,
  ) => {
    const t = now();
    for (const waiter of [...pendingRequests.values()]) {
      if (waiter.epochId !== targetEpochId) continue;
      if (!waiter.retriable) {
        if (
          waiter.targetWorkerId !== null &&
          waiter.targetWorkerId !== newWorkerId
        ) {
          settleReject(
            waiter.id,
            new WorkerRpcError("closed", "Worker replaced during write"),
          );
        }
        continue;
      }
      if (newWorkerId === null) {
        waiter.targetWorkerId = null;
        continue;
      }
      if (waiter.targetWorkerId !== newWorkerId && t < waiter.deadline) {
        dispatchWaiter(waiter);
      }
    }
  };

  const waitForReadyOrTimeout = (id: string, deadline: number) =>
    new Promise<"ready" | "timeout" | "closed">((resolve) => {
      const state = getState();
      if (
        state.closed ||
        state.disabled ||
        !state.activeEpoch ||
        epochId(state.activeEpoch) !== id
      ) {
        resolve("closed");
        return;
      }
      if (currentTargetWorkerId()) {
        resolve("ready");
        return;
      }
      const remaining = Math.max(0, deadline - now());
      const probeIntervalMs = Math.max(
        10,
        Math.min(50, Math.floor(workerTimeoutMs / 4)),
      );
      let done = false;
      const finish = (outcome: "ready" | "timeout" | "closed") => {
        if (done) return;
        done = true;
        clearTimeout(timeoutTimer);
        clearInterval(probeTimer);
        readyWaiters.delete(onWake);
        resolve(outcome);
      };
      const onWake = () => {
        const next = getState();
        if (
          next.closed ||
          next.disabled ||
          !next.activeEpoch ||
          epochId(next.activeEpoch) !== id
        ) {
          finish("closed");
          return;
        }
        if (currentTargetWorkerId()) finish("ready");
      };
      readyWaiters.add(onWake);
      const timeoutTimer = setTimeout(() => finish("timeout"), remaining);
      const probeTimer = setInterval(() => sendDiscover(id), probeIntervalMs);
      sendDiscover(id);
    });

  const enqueueAndDispatch = <K extends SqliteWorkerOp>(params: {
    epoch: CacheEpoch;
    principal: string | null;
    op: K;
    payload: SqliteWorkerPayloads[K];
    reqId: string;
    deadline: number;
  }): Promise<unknown> => {
    const { epoch, principal, op, payload, reqId, deadline } = params;
    const id = epochId(epoch);
    const { closed, disabled, activeEpoch } = getState();
    if (closed || disabled || !activeEpoch || epochId(activeEpoch) !== id) {
      return Promise.reject(
        new WorkerRpcError("closed", "SQLite worker epoch closed"),
      );
    }
    const remaining = Math.max(1, deadline - now());
    let waiter!: PendingWaiter;
    const resultPromise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(reqId);
        onTimeout(epoch, "holder-hung");
        reject(
          new WorkerRpcError("timeout", "SQLite worker request timed out"),
        );
      }, remaining);
      waiter = {
        id: reqId,
        epochId: id,
        principal,
        op,
        payload,
        retriable: RETRIABLE_OPS.has(op),
        deadline,
        targetWorkerId: null,
        resolve,
        reject,
        timer,
      };
      pendingRequests.set(reqId, waiter);
    });
    if (!currentTargetWorkerId()) {
      settleReject(
        reqId,
        new WorkerRpcError("closed", "No worker target available"),
      );
      return resultPromise;
    }
    dispatchWaiter(waiter);
    return resultPromise;
  };

  return {
    closeWorkerOutbox,
    notifyReadyWaiters,
    rejectWritesForEpoch,
    rejectAll,
    handleResponse,
    currentTargetWorkerId,
    sendDiscover,
    redispatchForWorkerChange,
    waitForReadyOrTimeout,
    enqueueAndDispatch,
  };
}
