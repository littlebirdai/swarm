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
  type SqliteWorkerAnnouncement,
  type SqliteWorkerOp,
  type SqliteWorkerPayloads,
  type SqliteWorkerResponse,
  type SqliteWorkerResults,
  type WorkerHandle,
  type WorkerSpawner,
} from "./protocol";
import { createRpcChannelManager, WorkerRpcError } from "./rpc-channel";
import { accountKeyOf } from "./hydrated-epoch";
import { createTransitionGate } from "./transition-gate";
import { createWorkerDrains } from "./worker-drain";

export { WorkerRpcError };

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
  onEpochChange?: (epoch: CacheEpoch | null) => void;
  onBeforeClose?: (epoch: CacheEpoch) => void;
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
  activeEpoch(): CacheEpoch | null;
  holdsLock(): boolean;
};

const GRACEFUL_CLOSE_TIMEOUT_MS = 150;
const MAX_UNHEALTHY_ROTATIONS = 3;

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
    onEpochChange,
    onBeforeClose,
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
  let unhealthyRotations = 0;
  let countedAccountKey: string | null = null;
  const transitions = createTransitionGate();

  const rpc = createRpcChannelManager({
    clientId,
    channelTransport,
    workerTimeoutMs,
    now,
    getState: () => ({
      closed,
      disabled,
      activeEpoch,
      ownedWorker,
      ownedWorkerId,
      ownedWorkerReady,
      knownWorkerId,
      sharedChannel,
    }),
    clearKnownWorker: () => {
      knownWorkerId = null;
    },
    onTimeout: (epoch, reason) => rotateToNextGeneration(epoch, reason),
  });

  const drains = createWorkerDrains({
    timeoutMs: GRACEFUL_CLOSE_TIMEOUT_MS,
    onDrained: (drain) => {
      rpc.rejectEpoch(drain.epochId, "Epoch changed");
      rpc.notifyReadyWaiters();
    },
  });

  const disableSqlite = (reason: string) => {
    if (disabled || closed) return;
    disabled = true;
    transitions.run(
      () => {
        teardownEpoch(false);
        onEpochChange?.(null);
        onOpfsMissing(reason);
      },
      { essential: true },
    );
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

  const clearKnownWorkerIfMatches = (deadId: string | null) => {
    if (!deadId) return;
    if (knownWorkerId === deadId) knownWorkerId = null;
    rpc.closeWorkerOutbox(deadId);
  };

  const terminateOwnedWorker = () => {
    const worker = ownedWorker;
    const prevWorkerId = ownedWorkerId;
    ownedWorker = null;
    ownedWorkerId = null;
    ownedWorkerReady = false;
    clearKnownWorkerIfMatches(prevWorkerId);
    if (worker) {
      try {
        worker.terminate();
      } catch {}
    }
  };

  const closeClientChannels = () => {
    knownWorkerId = null;
    rpc.closeWorkerOutbox();
    try {
      sharedChannel?.close();
    } catch {}
    sharedChannel = null;
    try {
      ownChannel?.close();
    } catch {}
    ownChannel = null;
  };

  const drainOwnedWorker = (epoch: CacheEpoch): boolean => {
    if (!ownedWorker || !ownedWorkerReady || !ownedWorkerId) return false;
    const started = drains.start({
      epochId: epochId(epoch),
      workerId: ownedWorkerId,
      worker: ownedWorker,
      releaseLock,
    });
    if (!started) return false;
    ownedWorker = null;
    ownedWorkerId = null;
    ownedWorkerReady = false;
    releaseLock = null;
    lockAbort = null;
    lockHeld = false;
    activeLockToken = null;
    closeClientChannels();
    rpc.notifyReadyWaiters();
    return true;
  };

  const finishTeardownLocksAndChannels = () => {
    terminateOwnedWorker();
    closeClientChannels();
    lockAbort?.abort();
    lockAbort = null;
    const release = releaseLock;
    releaseLock = null;
    lockHeld = false;
    activeLockToken = null;
    release?.();
    rpc.rejectAll("Epoch changed");
    rpc.notifyReadyWaiters();
  };

  const teardownEpoch = (graceful: boolean, closing = false) => {
    const epoch = activeEpoch;
    if (closing && epoch) onBeforeClose?.(epoch);
    if (closing) closed = true;
    activeEpoch = null;
    if (graceful && epoch && drainOwnedWorker(epoch)) return;
    finishTeardownLocksAndChannels();
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
    if (stored) return stored;
    if (!writeEpochOrDisable(next)) return null;
    return next;
  };

  function rotateToNextGeneration(expected: CacheEpoch, reason: string) {
    transitions.run(() => rotateNow(expected, reason));
  }

  function rotateNow(expected: CacheEpoch, reason: string) {
    if (closed || disabled) return;
    if (!activeEpoch || !sameEpoch(activeEpoch, expected)) return;
    const accountKey = accountKeyOf(expected);
    if (accountKey !== countedAccountKey) {
      countedAccountKey = accountKey;
      unhealthyRotations = 0;
    }
    unhealthyRotations++;
    if (unhealthyRotations > MAX_UNHEALTHY_ROTATIONS) {
      disableSqlite("rotation-limit");
      return;
    }
    teardownEpoch(false);
    onEpochChange?.(null);
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
  }

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
    if (!data || typeof data !== "object") return;
    const msg = data as SqliteWorkerResponse | SqliteWorkerAnnouncement;
    if (msg.type === "response") {
      if (msg.ok && activeEpoch && msg.epochId === epochId(activeEpoch))
        unhealthyRotations = 0;
      rpc.handleResponse(msg);
      return;
    }
    if (
      source === "owner" &&
      msg.type === "worker-closing" &&
      typeof msg.workerId === "string" &&
      drains.finish(msg.workerId)
    )
      return;
    if (closed) return;
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
        if (knownWorkerId !== msg.workerId) rpc.closeWorkerOutbox();
        knownWorkerId = msg.workerId;
      }
      rpc.notifyReadyWaiters();
      rpc.redispatchForWorkerChange(msg.epochId, rpc.currentTargetWorkerId());
      return;
    }
    if (msg.type === "worker-closing") {
      clearKnownWorkerIfMatches(msg.workerId);
      if (source === "owner" && ownedWorkerId === msg.workerId) {
        ownedWorkerId = null;
        ownedWorkerReady = false;
      }
      rpc.redispatchForWorkerChange(msg.epochId, null);
      rpc.sendDiscover(msg.epochId);
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

  const requestLock = (epoch: CacheEpoch) => {
    if (
      closed ||
      disabled ||
      !locks ||
      !activeEpoch ||
      !sameEpoch(activeEpoch, epoch)
    )
      return;
    const id = epochId(epoch);
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
        rpc.closeWorkerOutbox();
        rpc.redispatchForWorkerChange(id, null);
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
          terminateOwnedWorker();
          knownWorkerId = null;
          rpc.closeWorkerOutbox();
          rpc.rejectWritesForEpoch(id, "Lock lost");
          if (
            !closed &&
            !disabled &&
            activeEpoch &&
            epochId(activeEpoch) === id
          ) {
            rpc.redispatchForWorkerChange(id, null);
            rpc.sendDiscover(id);
            queueMicrotask(() => {
              if (
                !closed &&
                !disabled &&
                activeEpoch &&
                epochId(activeEpoch) === id &&
                !lockHeld &&
                !lockAbort
              ) {
                requestLock(activeEpoch);
              }
            });
          }
        }
      });
  };

  function attachToEpoch(epoch: CacheEpoch) {
    if (closed || disabled || epoch.principal === null) return;
    if (activeEpoch && sameEpoch(activeEpoch, epoch)) return;
    const prevEpoch = activeEpoch;
    teardownEpoch(
      Boolean(prevEpoch && prevEpoch.principal === epoch.principal),
    );
    activeEpoch = epoch;
    onEpochChange?.(epoch);
    if (!channelTransport || !locks) return;

    const baseChannel = epochChannelName(epoch);
    sharedChannel = channelTransport.open(baseChannel, (data) =>
      handleIncomingMessage(data, "channel"),
    );
    ownChannel = channelTransport.open(
      addressedChannelName(baseChannel, clientId),
      (data) => handleIncomingMessage(data, "channel"),
    );

    requestLock(epoch);
  }

  const followStoredEpoch = (next: CacheEpoch | null) => {
    if (closed || disabled || !activeEpoch) return;
    if (next && compareEpochOrder(next, activeEpoch) < 0) return;
    if (next && sameEpoch(next, activeEpoch)) return;
    if (
      next &&
      next.schemaVersion === schemaVersion &&
      next.principal !== null &&
      next.principal === auth.current() &&
      !next.failed
    ) {
      attachToEpoch(next);
      return;
    }
    teardownEpoch(false);
    onEpochChange?.(null);
  };

  const unsubscribeEpochStore = epochStore.subscribe?.((next) => {
    transitions.run(() => followStoredEpoch(next));
  });

  const ensureNow = (
    principal: string | null,
    createIfMissing: boolean,
  ): CacheEpoch | null => {
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
        teardownEpoch(false);
        onEpochChange?.(null);
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
      teardownEpoch(false);
      onEpochChange?.(null);
      return null;
    }
    attachToEpoch(target);
    return activeEpoch;
  };

  return {
    ensureActiveEpoch(principal, createIfMissing) {
      if (transitions.isRunning()) return null;
      let result: CacheEpoch | null = null;
      transitions.run(() => {
        result = ensureNow(principal, createIfMissing);
      });
      return result;
    },

    send<K extends SqliteWorkerOp>(
      epoch: CacheEpoch,
      principal: string | null,
      op: K,
      payload: SqliteWorkerPayloads[K],
    ): Promise<SqliteWorkerResults[K]> {
      const id = epochId(epoch);
      const deadline = now() + workerTimeoutMs;
      const reqId = createId();

      if (
        !closed &&
        !disabled &&
        activeEpoch &&
        epochId(activeEpoch) === id &&
        rpc.currentTargetWorkerId()
      ) {
        return rpc.enqueueAndDispatch({
          epoch,
          principal,
          op,
          payload,
          reqId,
          deadline,
        }) as Promise<SqliteWorkerResults[K]>;
      }

      return rpc.waitForReadyOrTimeout(id, deadline).then((readyOutcome) => {
        if (readyOutcome === "timeout") {
          rotateToNextGeneration(epoch, "holder-hung");
          throw new WorkerRpcError(
            "timeout",
            "SQLite worker discovery timed out",
          );
        }
        if (readyOutcome === "closed") {
          throw new WorkerRpcError("closed", "SQLite worker epoch closed");
        }
        return rpc.enqueueAndDispatch({
          epoch,
          principal,
          op,
          payload,
          reqId,
          deadline,
        }) as Promise<SqliteWorkerResults[K]>;
      });
    },

    handleEpochFailure,

    rotateForPurge(keepPrincipal) {
      transitions.run(() => {
        if (disabled || closed) return;
        const current = activeEpoch ?? epochStore.read();
        teardownEpoch(false);
        onEpochChange?.(null);
        unhealthyRotations = 0;
        writeEpochOrDisable({
          schemaVersion,
          accountEpoch: (current?.accountEpoch ?? 0) + 1,
          generation: 1,
          principal: keepPrincipal,
          updatedAt: now(),
        });
      });
    },

    close() {
      transitions.run(
        () => {
          if (closed) return;
          unsubscribeEpochStore?.();
          teardownEpoch(true, true);
          onEpochChange?.(null);
        },
        { essential: true },
      );
    },

    currentEpoch() {
      return activeEpoch ?? epochStore.read();
    },

    activeEpoch() {
      return activeEpoch;
    },

    holdsLock() {
      return lockHeld;
    },
  };
}
