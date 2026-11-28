import type { Patch } from "mutative";
import { noteSnapshotSync } from "../../idb-collection-diff";
import { createSqliteCache } from "./cache-storage";
import { isOpfsMissingError, isVersionMismatchError } from "./driver";
import {
  addressedChannelName,
  epochChannelName,
  epochId,
  type CacheEpoch,
  type ChannelEndpoint,
  type ChannelTransport,
  type SqliteErrorCode,
  type SqliteWorkerAnnouncement,
  type SqliteWorkerRequest,
  type SqliteWorkerResponse,
} from "./protocol";
import type { SqliteDriver } from "./schema";

export type OpenedWorkerDatabase = {
  driver: SqliteDriver;
  close(): Promise<void> | void;
  removeStorage?: () => Promise<void> | void;
};

export type SqliteWorkerHostDeps = {
  workerId: string;
  epoch: CacheEpoch;
  channelTransport: ChannelTransport;
  openDatabase: (
    epoch: CacheEpoch,
    onWriteError: (error: unknown) => void,
  ) => Promise<OpenedWorkerDatabase>;
  postToOwner: (
    message: SqliteWorkerResponse | SqliteWorkerAnnouncement,
  ) => void;
};

export type SqliteWorkerHost = {
  start(): Promise<void>;
  handleOwnerMessage(message: unknown): Promise<void>;
  close(): Promise<void>;
};

function readFileOwnerState(driver: SqliteDriver): {
  named: string[];
  blocked: boolean;
} {
  try {
    const readMeta = driver.prepare<{ value: string }>(
      "SELECT value FROM meta WHERE key = ?",
    );
    const ownerRaw = readMeta.get("cacheOwner");
    const userRaw = readMeta.get("currentUser");
    const owner = ownerRaw ? JSON.parse(ownerRaw.value) : null;
    const user = userRaw ? JSON.parse(userRaw.value) : null;
    const named = [owner?.principal, user?._id].filter(
      (id): id is string => typeof id === "string",
    );
    return {
      named,
      blocked: owner?.blocked === true,
    };
  } catch {
    return { named: [], blocked: false };
  }
}

export function createSqliteWorkerHost(
  deps: SqliteWorkerHostDeps,
): SqliteWorkerHost {
  const { workerId, epoch, channelTransport, openDatabase, postToOwner } = deps;
  const currentEpochId = epochId(epoch);
  const baseChannel = epochChannelName(epoch);
  const ownChannelName = addressedChannelName(baseChannel, workerId);

  let sharedChannel: ChannelEndpoint | null = null;
  let ownChannel: ChannelEndpoint | null = null;
  const peerOutboxes = new Map<string, ChannelEndpoint>();

  let openedDb: OpenedWorkerDatabase | null = null;
  let cache: ReturnType<typeof createSqliteCache> | null = null;
  let ready = false;
  let closed = false;
  let failed = false;
  let failedReason: string | null = null;
  let pendingWriteError: unknown = null;

  const outboxFor = (replyTo: string): ChannelEndpoint | null => {
    if (!channelTransport || closed) return null;
    let endpoint = peerOutboxes.get(replyTo);
    if (!endpoint) {
      endpoint = channelTransport.open(
        addressedChannelName(baseChannel, replyTo),
        () => {},
      );
      peerOutboxes.set(replyTo, endpoint);
    }
    return endpoint;
  };

  const announce = (message: SqliteWorkerAnnouncement) => {
    try {
      postToOwner(message);
    } catch {}
    try {
      sharedChannel?.post(message);
    } catch {}
  };

  const reply = (
    source: "owner" | "peer",
    replyTo: string,
    message: SqliteWorkerResponse,
  ) => {
    if (source === "owner") {
      postToOwner(message);
      return;
    }
    outboxFor(replyTo)?.post(message);
  };

  const failEpoch = (reason: string, code: SqliteErrorCode) => {
    if (failed) return;
    failed = true;
    failedReason = reason;
    announce({
      type: "worker-epoch-failed",
      workerId,
      epochId: currentEpochId,
      epoch,
      reason,
      code,
    });
  };

  const processRequest = async (
    req: SqliteWorkerRequest,
    source: "owner" | "peer",
  ) => {
    const respondOk = (result: unknown) =>
      reply(source, req.replyTo, {
        type: "response",
        id: req.id,
        workerId,
        epochId: currentEpochId,
        ok: true,
        result,
      });

    const respondErr = (code: SqliteErrorCode, error: string) =>
      reply(source, req.replyTo, {
        type: "response",
        id: req.id,
        workerId,
        epochId: currentEpochId,
        ok: false,
        error,
        code,
      });

    if (req.epochId !== currentEpochId) {
      respondErr("epoch-mismatch", "Epoch mismatch");
      return;
    }
    if (failed) {
      respondErr("write-failed", failedReason ?? "write-failed");
      return;
    }
    if (!ready || closed || !cache || !openedDb) {
      respondErr("epoch-mismatch", "Worker is not ready");
      return;
    }
    if (req.op === "ping") {
      respondOk({ ok: true, workerId, epochId: currentEpochId });
      return;
    }
    if (req.op === "purgeLocalCache") {
      const payload = req.payload as { keepPendingInputFor?: string | null };
      await cache.purgeLocalCache({
        keepPendingInputFor: payload.keepPendingInputFor ?? null,
      });
      respondOk(undefined);
      return;
    }
    if (req.principal === null || req.principal !== epoch.principal) {
      respondErr("owner-mismatch", "Principal mismatch");
      return;
    }

    const isRead =
      req.op === "loadCache" ||
      req.op === "loadPaintCache" ||
      req.op === "loadConversationMessages";
    if (isRead) {
      const ownerState = readFileOwnerState(openedDb.driver);
      if (ownerState.blocked) {
        failEpoch("write-failed", "write-failed");
        respondErr("write-failed", "Database marked write-failed");
        return;
      }
      if (ownerState.named.some((id) => id !== req.principal)) {
        respondErr("owner-mismatch", "Stored file owner mismatch");
        return;
      }
    }

    try {
      if (req.op === "loadCache") {
        const payload = req.payload as {
          keys?: readonly string[];
          context?: Record<string, unknown>;
        };
        const result = await cache.loadCache(payload.keys, payload.context);
        respondOk(result);
        return;
      }
      if (req.op === "loadPaintCache") {
        const result = await cache.loadPaintCache();
        respondOk(result);
        return;
      }
      if (req.op === "loadConversationMessages") {
        const payload = req.payload as { conversationId: string };
        const result = await cache.loadConversationMessages(
          payload.conversationId,
        );
        respondOk(result);
        return;
      }

      pendingWriteError = null;
      if (req.op === "writePatches") {
        const payload = req.payload as {
          patches: Patch[];
          state: Record<string, unknown>;
          snapshotDrops?: Record<string, string[]>;
        };
        if (payload.snapshotDrops) {
          for (const [key, ids] of Object.entries(payload.snapshotDrops)) {
            if (ids.length) noteSnapshotSync(key, [], ids);
          }
        }
        await cache.writePatches(payload.patches, payload.state);
      } else if (req.op === "writeConversationMessages") {
        const payload = req.payload as {
          conversationId: string;
          messages: unknown[];
          pagination: unknown;
        };
        cache.writeConversationMessages(
          payload.conversationId,
          payload.messages,
          payload.pagination,
        );
      } else if (req.op === "writeConversationUserMessages") {
        const payload = req.payload as {
          conversationId: string;
          messages: unknown[];
        };
        cache.writeConversationUserMessages(
          payload.conversationId,
          payload.messages,
        );
      }

      const ownerAfter = readFileOwnerState(openedDb.driver);
      if (pendingWriteError || ownerAfter.blocked) {
        const reason = pendingWriteError
          ? String(pendingWriteError)
          : "write-failed";
        failEpoch(reason, "write-failed");
        respondErr("write-failed", reason);
        return;
      }
      respondOk(undefined);
    } catch (error) {
      if (!isRead) {
        const reason = String(error);
        failEpoch(reason, "write-failed");
        respondErr("write-failed", reason);
        return;
      }
      respondErr("internal", String(error));
    }
  };

  const handleChannelMessage = (data: unknown) => {
    if (closed || !data || typeof data !== "object") return;
    const msg = data as { type?: string; replyTo?: string; epochId?: string };
    if (msg.type === "discover") {
      if (
        !ready ||
        failed ||
        msg.epochId !== currentEpochId ||
        typeof msg.replyTo !== "string"
      )
        return;
      outboxFor(msg.replyTo)?.post({
        type: "worker-ready",
        workerId,
        epochId: currentEpochId,
        epoch,
      } satisfies SqliteWorkerAnnouncement);
      return;
    }
    if (msg.type === "request") {
      void processRequest(data as SqliteWorkerRequest, "peer");
    }
  };

  return {
    async start() {
      if (closed) return;
      sharedChannel = channelTransport.open(baseChannel, handleChannelMessage);
      ownChannel = channelTransport.open(ownChannelName, handleChannelMessage);
      try {
        openedDb = await openDatabase(epoch, (error) => {
          pendingWriteError = error;
        });
      } catch (error) {
        if (closed) return;
        if (isOpfsMissingError(error)) {
          announce({
            type: "worker-opfs-missing",
            workerId,
            epochId: currentEpochId,
            error: String(error),
          });
        } else {
          const code: SqliteErrorCode = isVersionMismatchError(error)
            ? "version-mismatch"
            : "internal";
          failEpoch(String(error), code);
        }
        await this.close();
        return;
      }
      if (closed) {
        await openedDb.close();
        return;
      }
      try {
        cache = createSqliteCache(
          openedDb.driver,
          {
            current: () => epoch.principal,
            resolve: async () => epoch.principal,
            tokenState: () => (epoch.principal ? "named" : "absent"),
            epoch: () => epoch.accountEpoch,
          },
          "read-write",
        );
      } catch (error) {
        const code: SqliteErrorCode = isVersionMismatchError(error)
          ? "version-mismatch"
          : "internal";
        failEpoch(String(error), code);
        await this.close();
        return;
      }
      const ownerState = readFileOwnerState(openedDb.driver);
      if (ownerState.blocked) {
        failEpoch("write-failed", "write-failed");
        await this.close();
        return;
      }
      ready = true;
      announce({
        type: "worker-ready",
        workerId,
        epochId: currentEpochId,
        epoch,
      });
    },
    async handleOwnerMessage(message: unknown) {
      if (!message || typeof message !== "object") return;
      const msg = message as { type?: string };
      if (msg.type === "request") {
        await processRequest(message as SqliteWorkerRequest, "owner");
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      ready = false;
      announce({
        type: "worker-closing",
        workerId,
        epochId: currentEpochId,
      });
      sharedChannel?.close();
      sharedChannel = null;
      ownChannel?.close();
      ownChannel = null;
      for (const endpoint of peerOutboxes.values()) endpoint.close();
      peerOutboxes.clear();
      if (openedDb) {
        const dbToClose = openedDb;
        openedDb = null;
        await dbToClose.close();
      }
    },
  };
}
