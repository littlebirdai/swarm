import type { AuthPrincipalTracker } from "@platform/auth/web";
import { recordCacheEvent } from "../../cache-events";
import {
  addressedChannelName,
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

  let ownedWorker: WorkerHandle | null = null;
  let ownedWorkerId: string | null = null;
  let ownedWorkerReady = false;
  let sharedChannel: ChannelEndpoint | null = null;
  let ownChannel: ChannelEndpoint | null = null;
  let knownWorkerId: string | null = null;
  let peerWorkerOutbox: { workerId: string; endpoint: ChannelEndpoint } | null =
    null;

  const workerReadyWaiters = new Set<() => void>();
  const pendingRequests = new Map<
    string,
    {
      epochId: string;
      resolve: (value: unknown) => void;
      reject: (error: unknown) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  const notifyReadyWaiters = () => {
    for (const notify of workerReadyWaiters) notify();
  };

  const closeWorkerOutbox = () => {
    peerWorkerOutbox?.endpoint.close();
    peerWorkerOutbox = null;
  };

  const rejectPendingForEpoch = (reason: string) => {
    for (const [id, waiter] of pendingRequests) {
      clearTimeout(waiter.timer);
      pendingRequests.delete(id);
      waiter.reject(new WorkerRpcError("closed", reason));
    }
  };

  const teardownEpoch = () => {
    lockAbort?.abort();
    lockAbort = null;
    const release = releaseLock;
    releaseLock = null;
    lockHeld = false;
    release?.();
    if (ownedWorker) {
      ownedWorker.terminate();
      ownedWorker = null;
    }
    ownedWorkerId = null;
    ownedWorkerReady = false;
    knownWorkerId = null;
    closeWorkerOutbox();
    sharedChannel?.close();
    sharedChannel = null;
    ownChannel?.close();
    ownChannel = null;
    rejectPendingForEpoch("Epoch changed");
    notifyReadyWaiters();
  };

  const advanceEpochIfMatches = (
    expected: CacheEpoch,
    next: CacheEpoch,
  ): CacheEpoch => {
    const stored = epochStore.read();
    if (
      stored &&
      stored.schemaVersion === expected.schemaVersion &&
      stored.accountEpoch === expected.accountEpoch &&
      stored.generation === expected.generation &&
      stored.principal === expected.principal &&
      !stored.failed
    ) {
      epochStore.write(next);
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

  const handleIncomingMessage = (data: unknown) => {
    if (closed || !data || typeof data !== "object") return;
    const msg = data as SqliteWorkerResponse | SqliteWorkerAnnouncement;
    if (msg.type === "response") {
      const waiter = pendingRequests.get(msg.id);
      if (!waiter || msg.epochId !== waiter.epochId) return;
      clearTimeout(waiter.timer);
      pendingRequests.delete(msg.id);
      if (msg.ok) waiter.resolve(msg.result);
      else waiter.reject(new WorkerRpcError(msg.code, msg.error));
      return;
    }
    if (!activeEpoch || msg.epochId !== epochId(activeEpoch)) return;
    if (msg.type === "worker-ready") {
      knownWorkerId = msg.workerId;
      if (ownedWorker && (!ownedWorkerId || ownedWorkerId === msg.workerId)) {
        ownedWorkerId = msg.workerId;
        ownedWorkerReady = true;
      }
      notifyReadyWaiters();
      return;
    }
    if (msg.type === "worker-closing") {
      if (knownWorkerId === msg.workerId) {
        knownWorkerId = null;
        closeWorkerOutbox();
      }
      if (ownedWorkerId === msg.workerId) {
        ownedWorkerId = null;
        ownedWorkerReady = false;
      }
      return;
    }
    if (msg.type === "worker-opfs-missing") {
      disabled = true;
      activeEpoch = null;
      teardownEpoch();
      onOpfsMissing(msg.error);
      return;
    }
    if (msg.type === "worker-epoch-failed") {
      handleEpochFailure(msg.epoch, msg.reason);
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
    sharedChannel = channelTransport.open(baseChannel, handleIncomingMessage);
    ownChannel = channelTransport.open(
      addressedChannelName(baseChannel, clientId),
      handleIncomingMessage,
    );

    const controller = new AbortController();
    lockAbort = controller;
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
        lockHeld = true;
        try {
          const worker = spawnWorker(
            epoch,
            handleIncomingMessage,
            (message) => {
              if (!activeEpoch || epochId(activeEpoch) !== id) return;
              handleEpochFailure(epoch, message);
            },
          );
          ownedWorker = worker;
          ownedWorkerReady = false;
          worker.postMessage({ type: "init", epoch });
        } catch (error) {
          releaseLock?.();
          lockHeld = false;
          handleEpochFailure(epoch, String(error));
          return;
        }
        return held;
      })
      .catch(() => {});
  };

  const unsubscribeEpochStore = epochStore.subscribe?.((next) => {
    if (closed || disabled || !activeEpoch) return;
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
      const sendDiscover = () => {
        if (!ownedWorker && sharedChannel) {
          sharedChannel.post({
            type: "discover",
            replyTo: clientId,
            epochId: id,
          });
        }
      };
      workerReadyWaiters.add(onWake);
      const timeoutTimer = setTimeout(() => finish("timeout"), remaining);
      const probeTimer = setInterval(sendDiscover, probeIntervalMs);
      sendDiscover();
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
        epochStore.write(target);
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
      const request: SqliteWorkerRequest<K> = {
        type: "request",
        id: reqId,
        replyTo: clientId,
        epochId: id,
        principal,
        op,
        payload,
      };

      const resultPromise = new Promise<SqliteWorkerResults[K]>(
        (resolve, reject) => {
          const timer = setTimeout(() => {
            pendingRequests.delete(reqId);
            rotateToNextGeneration(epoch, "holder-hung");
            reject(
              new WorkerRpcError("timeout", "SQLite worker request timed out"),
            );
          }, remaining);
          pendingRequests.set(reqId, {
            epochId: id,
            resolve: resolve as (value: unknown) => void,
            reject,
            timer,
          });
        },
      );

      if (ownedWorker && ownedWorkerReady) {
        ownedWorker.postMessage(request);
      } else if (knownWorkerId && channelTransport) {
        if (!peerWorkerOutbox || peerWorkerOutbox.workerId !== knownWorkerId) {
          closeWorkerOutbox();
          peerWorkerOutbox = {
            workerId: knownWorkerId,
            endpoint: channelTransport.open(
              addressedChannelName(epochChannelName(epoch), knownWorkerId),
              () => {},
            ),
          };
        }
        peerWorkerOutbox.endpoint.post(request);
      } else {
        const waiter = pendingRequests.get(reqId);
        if (waiter) {
          clearTimeout(waiter.timer);
          pendingRequests.delete(reqId);
        }
        throw new WorkerRpcError("closed", "No worker target available");
      }

      return resultPromise;
    },

    handleEpochFailure,

    rotateForPurge(keepPrincipal) {
      if (disabled) return;
      const current = activeEpoch ?? epochStore.read();
      teardownEpoch();
      activeEpoch = null;
      epochStore.write({
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
