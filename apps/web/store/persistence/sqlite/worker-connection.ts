import type { AuthPrincipalTracker } from "@platform/auth/web";
import { recordCacheEvent } from "../../cache-events";
import {
  addressedChannelName,
  compareEpochOrder,
  epochChannelName,
  epochId,
  epochLockName,
  nextGenerationEpoch,
  resolveTargetEpoch,
  sameEpoch,
  type CacheEpoch,
  type ChannelEndpoint,
  type ChannelTransport,
  type EpochStore,
  type LockAdapter,
  type SqliteErrorCode,
  type SqliteWorkerAnnouncement,
  type SqliteWorkerOp,
  type SqliteWorkerPayloads,
  type SqliteWorkerRequest,
  type SqliteWorkerResponse,
  type SqliteWorkerResults,
  type WorkerHandle,
  type WorkerSpawner,
} from "./protocol";

export class WorkerRpcError extends Error {
  constructor(
    readonly code: SqliteErrorCode | "timeout" | "closed",
    message: string,
  ) {
    super(message);
  }
}

export type WorkerConnectionDeps = {
  clientId: string;
  auth: Pick<AuthPrincipalTracker, "current" | "tokenState">;
  schemaVersion: number;
  epochStore: EpochStore;
  locks: LockAdapter | null;
  channelTransport: ChannelTransport | null;
  spawnWorker: WorkerSpawner;
  workerTimeoutMs: number;
  now: () => number;
  createId: () => string;
  onOpfsMissing: (reason: string) => void;
};

export type WorkerConnection = {
  ensureActiveEpoch(
    principal: string | null,
    createIfMissing: boolean,
  ): CacheEpoch | null;
  send<K extends SqliteWorkerOp>(
    epoch: CacheEpoch,
    principal: string | null,
    op: K,
    payload: SqliteWorkerPayloads[K],
  ): Promise<SqliteWorkerResults[K]>;
  handleEpochFailure(failedEpoch: CacheEpoch, reason: string): void;
  rotateForPurge(keepPrincipal: string | null): void;
  close(): void;
  currentEpoch(): CacheEpoch | null;
  holdsLock(): boolean;
};

type PendingWaiter = {
  id: string;
  epochId: string;
  principal: string | null;
  op: SqliteWorkerOp;
  payload: SqliteWorkerPayloads[SqliteWorkerOp];
  deadline: number;
  targetWorkerId: string | null;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};

export function createWorkerConnection(
  deps: WorkerConnectionDeps,
): WorkerConnection {
  const {
    clientId,
    auth,
    schemaVersion,
    epochStore,
    locks,
    channelTransport,
    spawnWorker,
    workerTimeoutMs,
    now,
    createId,
    onOpfsMissing,
  } = deps;

  let closed = false;
  let disabled = false;
  let activeEpoch: CacheEpoch | null = null;
  let lockAbort: AbortController | null = null;
  let releaseLock: (() => void) | null = null;
  let lockHeld = false;
  let activeLockToken: object | null = null;

  let ownedWorker: WorkerHandle | null = null;
  let ownedWorkerId: string | null = null;
  let ownedWorkerReady = false;
  let sharedChannel: ChannelEndpoint | null = null;
  let ownChannel: ChannelEndpoint | null = null;
  let knownWorkerId: string | null = null;
  let peerWorkerOutbox: { workerId: string; endpoint: ChannelEndpoint } | null =
    null;

  const workerReadyWaiters = new Set<() => void>();
  const pendingRequests = new Map<string, PendingWaiter>();

  const disableSqlite = (reason: string) => {
    if (disabled) return;
    disabled = true;
    activeEpoch = null;
    teardownEpoch();
    onOpfsMissing(reason);
  };

  const writeEpochOrDisable = (epoch: CacheEpoch): boolean => {
    try {
      const wrote = epochStore.write(epoch);
      if (wrote === false) {
        disableSqlite("epoch-store-write-failed");
        return false;
      }
      return true;
    } catch {
      disableSqlite("epoch-store-write-failed");
      return false;
    }
  };

  const notifyReadyWaiters = () => {
    for (const notify of workerReadyWaiters) notify();
  };

  const closeWorkerOutbox = () => {
    try {
      peerWorkerOutbox?.endpoint.close();
    } catch {}
    peerWorkerOutbox = null;
  };

  const settleReject = (id: string, error: unknown) => {
    const waiter = pendingRequests.get(id);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    pendingRequests.delete(id);
    waiter.reject(error);
  };

  const rejectPendingForEpoch = (reason: string) => {
    for (const [id, waiter] of pendingRequests) {
      clearTimeout(waiter.timer);
      pendingRequests.delete(id);
      waiter.reject(new WorkerRpcError("closed", reason));
    }
  };

  const terminateOwnedWorker = () => {
    const worker = ownedWorker;
    ownedWorker = null;
    ownedWorkerId = null;
    ownedWorkerReady = false;
    if (worker) {
      try {
        worker.terminate();
      } catch {}
    }
  };

  const teardownEpoch = () => {
    terminateOwnedWorker();
    knownWorkerId = null;
    closeWorkerOutbox();
    try {
      sharedChannel?.close();
    } catch {}
    sharedChannel = null;
    try {
      ownChannel?.close();
    } catch {}
    ownChannel = null;
    lockAbort?.abort();
    lockAbort = null;
    const release = releaseLock;
    releaseLock = null;
    lockHeld = false;
    activeLockToken = null;
    release?.();
    rejectPendingForEpoch("Epoch changed");
    notifyReadyWaiters();
  };

  const sendDiscover = (targetEpochId: string) => {
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

  const currentTargetWorkerId = (): string | null => {
    if (ownedWorker && ownedWorkerReady && ownedWorkerId) return ownedWorkerId;
    if (knownWorkerId && channelTransport) return knownWorkerId;
    return null;
  };

  const dispatchWaiter = (waiter: PendingWaiter): void => {
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
        knownWorkerId = null;
        settleReject(waiter.id, new WorkerRpcError("closed", String(error)));
      }
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
      if (newWorkerId === null) {
        waiter.targetWorkerId = null;
        continue;
      }
      if (waiter.targetWorkerId !== newWorkerId && t < waiter.deadline) {
        dispatchWaiter(waiter);
      }
    }
  };

  const advanceEpochIfMatches = (
    expected: CacheEpoch,
    next: CacheEpoch,
  ): CacheEpoch | null => {
    const stored = epochStore.read();
    if (
      stored &&
      stored.schemaVersion === expected.schemaVersion &&
      stored.accountEpoch === expected.accountEpoch &&
      stored.generation === expected.generation &&
      stored.principal === expected.principal &&
      !stored.failed
    ) {
      if (!writeEpochOrDisable(next)) return null;
      return next;
    }
    return stored ?? next;
  };

  const rotateToNextGeneration = (expected: CacheEpoch, reason: string) => {
    const id = epochId(expected);
    if (activeEpoch && epochId(activeEpoch) === id) {
      teardownEpoch();
      activeEpoch = null;
    }
    const next = nextGenerationEpoch(expected, reason, now());
    const target = advanceEpochIfMatches(expected, next);
    if (
      target &&
      !closed &&
      !disabled &&
      target.principal !== null &&
      target.principal === auth.current() &&
      !target.failed
    ) {
      attachToEpoch(target);
    }
  };

  const handleEpochFailure = (failedEpoch: CacheEpoch, reason: string) => {
    if (disabled || closed) return;
    recordCacheEvent("write-failed", {
      engine: "sqlite-worker",
      reason,
      epoch: epochId(failedEpoch),
    });
    rotateToNextGeneration(failedEpoch, reason);
  };

  const handleIncomingMessage = (
    data: unknown,
    source: "owner" | "channel",
  ) => {
    if (closed || !data || typeof data !== "object") return;
    const msg = data as SqliteWorkerResponse | SqliteWorkerAnnouncement;
    if (msg.type === "response") {
      if (typeof msg.id !== "string" || typeof msg.ok !== "boolean") return;
      const waiter = pendingRequests.get(msg.id);
      if (!waiter || msg.epochId !== waiter.epochId) return;
      clearTimeout(waiter.timer);
      pendingRequests.delete(msg.id);
      if (msg.ok) waiter.resolve(msg.result);
      else waiter.reject(new WorkerRpcError(msg.code, msg.error));
      return;
    }
    if (!activeEpoch || msg.epochId !== epochId(activeEpoch)) return;
    if (typeof msg.workerId !== "string") return;

    if (msg.type === "worker-ready") {
      if (!msg.epoch || msg.epoch.principal !== activeEpoch.principal) return;
      if (source === "owner") {
        if (ownedWorker && (!ownedWorkerId || ownedWorkerId === msg.workerId)) {
          ownedWorkerId = msg.workerId;
          ownedWorkerReady = true;
          knownWorkerId = msg.workerId;
        }
      } else if (!ownedWorker) {
        if (knownWorkerId !== msg.workerId) closeWorkerOutbox();
        knownWorkerId = msg.workerId;
      }
      notifyReadyWaiters();
      redispatchForWorkerChange(msg.epochId, currentTargetWorkerId());
      return;
    }
    if (msg.type === "worker-closing") {
      if (knownWorkerId === msg.workerId) {
        knownWorkerId = null;
        closeWorkerOutbox();
      }
      if (source === "owner" && ownedWorkerId === msg.workerId) {
        ownedWorkerId = null;
        ownedWorkerReady = false;
      }
      redispatchForWorkerChange(msg.epochId, null);
      sendDiscover(msg.epochId);
      return;
    }
    if (msg.type === "worker-opfs-missing") {
      disableSqlite(String(msg.error ?? "opfs-missing"));
      return;
    }
    if (msg.type === "worker-epoch-failed") {
      if (!msg.epoch || msg.epoch.principal !== activeEpoch.principal) return;
      handleEpochFailure(msg.epoch, String(msg.reason ?? "write-failed"));
    }
  };

  const attachToEpoch = (epoch: CacheEpoch) => {
    if (closed || disabled || epoch.principal === null) return;
    if (activeEpoch && sameEpoch(activeEpoch, epoch)) return;
    teardownEpoch();
    activeEpoch = epoch;
    if (!channelTransport || !locks) return;

    const baseChannel = epochChannelName(epoch);
    const id = epochId(epoch);
    sharedChannel = channelTransport.open(baseChannel, (data) =>
      handleIncomingMessage(data, "channel"),
    );
    ownChannel = channelTransport.open(
      addressedChannelName(baseChannel, clientId),
      (data) => handleIncomingMessage(data, "channel"),
    );

    const controller = new AbortController();
    lockAbort = controller;
    let lockOwnedByCall = false;
    const lockToken = {};
    void locks
      .request(epochLockName(epoch), controller.signal, () => {
        if (
          closed ||
          disabled ||
          controller.signal.aborted ||
          !activeEpoch ||
          epochId(activeEpoch) !== id
        )
          return;
        let heldResolved = false;
        const held = new Promise<void>((resolve) => {
          releaseLock = () => {
            if (heldResolved) return;
            heldResolved = true;
            resolve();
          };
        });
        lockOwnedByCall = true;
        activeLockToken = lockToken;
        lockHeld = true;
        knownWorkerId = null;
        closeWorkerOutbox();
        redispatchForWorkerChange(id, null);
        try {
          const worker = spawnWorker(
            epoch,
            (data) => handleIncomingMessage(data, "owner"),
            (message) => {
              if (!activeEpoch || epochId(activeEpoch) !== id) return;
              handleEpochFailure(epoch, message);
            },
          );
          ownedWorker = worker;
          ownedWorkerReady = false;
          worker.postMessage({ type: "init", epoch });
        } catch (error) {
          terminateOwnedWorker();
          if (activeLockToken === lockToken) {
            releaseLock?.();
            releaseLock = null;
            lockHeld = false;
            activeLockToken = null;
          }
          handleEpochFailure(epoch, String(error));
          return;
        }
        return held;
      })
      .catch(() => {})
      .finally(() => {
        if (lockAbort === controller) lockAbort = null;
        if (lockOwnedByCall && activeLockToken === lockToken) {
          lockHeld = false;
          releaseLock = null;
          activeLockToken = null;
          if (activeEpoch && epochId(activeEpoch) === id && ownedWorker) {
            terminateOwnedWorker();
          }
        }
      });
  };

  const unsubscribeEpochStore = epochStore.subscribe?.((next) => {
    if (closed || disabled || !activeEpoch) return;
    if (next && compareEpochOrder(next, activeEpoch) < 0) return;
    if (!next || !sameEpoch(next, activeEpoch)) {
      teardownEpoch();
      activeEpoch = null;
      if (
        next &&
        next.schemaVersion === schemaVersion &&
        next.principal !== null &&
        next.principal === auth.current() &&
        !next.failed
      ) {
        attachToEpoch(next);
      }
    }
  });

  const waitForReadyOrTimeout = (id: string, deadline: number) =>
    new Promise<"ready" | "timeout" | "closed">((resolve) => {
      if (closed || disabled || !activeEpoch || epochId(activeEpoch) !== id) {
        resolve("closed");
        return;
      }
      if ((ownedWorker && ownedWorkerReady) || knownWorkerId) {
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
        workerReadyWaiters.delete(onWake);
        resolve(outcome);
      };
      const onWake = () => {
        if (closed || disabled || !activeEpoch || epochId(activeEpoch) !== id) {
          finish("closed");
          return;
        }
        if ((ownedWorker && ownedWorkerReady) || knownWorkerId) {
          finish("ready");
        }
      };
      workerReadyWaiters.add(onWake);
      const timeoutTimer = setTimeout(() => finish("timeout"), remaining);
      const probeTimer = setInterval(() => sendDiscover(id), probeIntervalMs);
      sendDiscover(id);
    });

  return {
    ensureActiveEpoch(principal, createIfMissing) {
      if (disabled || closed) return null;
      const stored = epochStore.read();
      const resolution = resolveTargetEpoch({
        stored,
        schemaVersion,
        principal,
        tokenState: auth.tokenState(),
        now: now(),
      });
      if (resolution.action === "hold") {
        if (
          principal === null &&
          auth.tokenState() !== "unparsable" &&
          auth.tokenState() !== "unreadable"
        ) {
          teardownEpoch();
          activeEpoch = null;
        }
        return null;
      }
      const target = resolution.epoch;
      if (!target) return null;
      if (resolution.action === "create") {
        if (!createIfMissing && target.principal !== null) return null;
        if (!writeEpochOrDisable(target)) return null;
      }
      if (target.principal === null) {
        teardownEpoch();
        activeEpoch = null;
        return null;
      }
      attachToEpoch(target);
      return activeEpoch;
    },

    async send<K extends SqliteWorkerOp>(
      epoch: CacheEpoch,
      principal: string | null,
      op: K,
      payload: SqliteWorkerPayloads[K],
    ): Promise<SqliteWorkerResults[K]> {
      const id = epochId(epoch);
      const deadline = now() + workerTimeoutMs;
      const reqId = createId();

      const readyOutcome = await waitForReadyOrTimeout(id, deadline);
      if (readyOutcome === "timeout") {
        rotateToNextGeneration(epoch, "holder-hung");
        throw new WorkerRpcError(
          "timeout",
          "SQLite worker discovery timed out",
        );
      }
      if (
        readyOutcome === "closed" ||
        disabled ||
        !activeEpoch ||
        epochId(activeEpoch) !== id
      ) {
        throw new WorkerRpcError("closed", "SQLite worker epoch closed");
      }

      const remaining = Math.max(1, deadline - now());
      let waiter!: PendingWaiter;
      const resultPromise = new Promise<SqliteWorkerResults[K]>(
        (resolve, reject) => {
          const timer = setTimeout(() => {
            pendingRequests.delete(reqId);
            rotateToNextGeneration(epoch, "holder-hung");
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
            deadline,
            targetWorkerId: null,
            resolve: resolve as (value: unknown) => void,
            reject,
            timer,
          };
          pendingRequests.set(reqId, waiter);
        },
      );

      if (!currentTargetWorkerId()) {
        settleReject(
          reqId,
          new WorkerRpcError("closed", "No worker target available"),
        );
        return resultPromise;
      }

      dispatchWaiter(waiter);
      return resultPromise;
    },

    handleEpochFailure,

    rotateForPurge(keepPrincipal) {
      if (disabled) return;
      const current = activeEpoch ?? epochStore.read();
      teardownEpoch();
      activeEpoch = null;
      writeEpochOrDisable({
        schemaVersion,
        accountEpoch: (current?.accountEpoch ?? 0) + 1,
        generation: 1,
        principal: keepPrincipal,
        updatedAt: now(),
      });
    },

    close() {
      if (closed) return;
      closed = true;
      unsubscribeEpochStore?.();
      teardownEpoch();
      activeEpoch = null;
    },

    currentEpoch() {
      return activeEpoch ?? epochStore.read();
    },

    holdsLock() {
      return lockHeld;
    },
  };
}
