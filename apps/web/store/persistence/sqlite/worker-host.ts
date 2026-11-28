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
  type SqliteWorkerOp,
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
  start(): Promise<boolean>;
  handleOwnerMessage(message: unknown): Promise<void>;
  close(): Promise<void>;
};

const MAX_PEER_OUTBOXES = 16;

type ReadMetaStmt = ReturnType<SqliteDriver["prepare"]>;

function readFileOwnerState(readMeta: ReadMetaStmt | null): {
  named: string[];
  blocked: boolean;
} {
  if (!readMeta) return { named: [], blocked: false };
  try {
    const ownerRaw = readMeta.get("cacheOwner") as { value: string } | null;
    const userRaw = readMeta.get("currentUser") as { value: string } | null;
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const VALID_OPS = new Set<string>([
  "ping",
  "loadCache",
  "loadPaintCache",
  "writePatches",
  "loadConversationMessages",
  "writeConversationMessages",
  "writeConversationUserMessages",
  "deleteDocDetails",
]);

function hasValidPayload(op: SqliteWorkerOp, payload: unknown): boolean {
  if (!isPlainObject(payload)) return false;
  if (op === "ping" || op === "loadPaintCache") return true;
  if (op === "loadCache") {
    if (
      payload.keys !== undefined &&
      (!Array.isArray(payload.keys) ||
        payload.keys.some((k) => typeof k !== "string"))
    )
      return false;
    if (payload.context !== undefined && !isPlainObject(payload.context))
      return false;
    return true;
  }
  if (op === "writePatches") {
    return Array.isArray(payload.patches) && isPlainObject(payload.state);
  }
  if (op === "loadConversationMessages") {
    return typeof payload.conversationId === "string";
  }
  if (
    op === "writeConversationMessages" ||
    op === "writeConversationUserMessages"
  ) {
    return (
      typeof payload.conversationId === "string" &&
      Array.isArray(payload.messages)
    );
  }
  if (op === "deleteDocDetails") {
    return (
      Array.isArray(payload.ids) &&
      payload.ids.every((id) => typeof id === "string")
    );
  }
  return false;
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
  let readMetaStmt: ReadMetaStmt | null = null;
  let cache: ReturnType<typeof createSqliteCache> | null = null;
  let ready = false;
  let closing = false;
  let closed = false;
  let failed = false;
  let failedReason: string | null = null;
  let pendingWriteError: unknown = null;
  let opQueue: Promise<void> = Promise.resolve();

  const outboxFor = (replyTo: string): ChannelEndpoint | null => {
    if (!channelTransport || closed) return null;
    const existing = peerOutboxes.get(replyTo);
    if (existing) {
      peerOutboxes.delete(replyTo);
      peerOutboxes.set(replyTo, existing);
      return existing;
    }
    if (peerOutboxes.size >= MAX_PEER_OUTBOXES) {
      const oldest = peerOutboxes.keys().next().value;
      if (oldest !== undefined) {
        const oldEndpoint = peerOutboxes.get(oldest);
        peerOutboxes.delete(oldest);
        try {
          oldEndpoint?.close();
        } catch {}
      }
    }
    const endpoint = channelTransport.open(
      addressedChannelName(baseChannel, replyTo),
      () => {},
    );
    peerOutboxes.set(replyTo, endpoint);
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
    try {
      if (source === "owner") {
        postToOwner(message);
        return;
      }
      outboxFor(replyTo)?.post(message);
    } catch {
      if (source === "peer") {
        const endpoint = peerOutboxes.get(replyTo);
        peerOutboxes.delete(replyTo);
        try {
          endpoint?.close();
        } catch {}
      }
    }
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

  const enqueue = (task: () => Promise<void>): Promise<void> => {
    const next = opQueue.then(task, task);
    opQueue = next.catch(() => {});
    return next;
  };

  const processRequest = async (
    raw: unknown,
    source: "owner" | "peer",
  ): Promise<void> => {
    if (!isPlainObject(raw) || raw.type !== "request") return;
    if (typeof raw.id !== "string" || typeof raw.replyTo !== "string") return;

    const id = raw.id;
    const replyTo = raw.replyTo;
    const respondOk = (result: unknown) =>
      reply(source, replyTo, {
        type: "response",
        id,
        workerId,
        epochId: currentEpochId,
        ok: true,
        result,
      });

    const respondErr = (code: SqliteErrorCode, error: string) =>
      reply(source, replyTo, {
        type: "response",
        id,
        workerId,
        epochId: currentEpochId,
        ok: false,
        error,
        code,
      });

    if (typeof raw.epochId !== "string" || typeof raw.op !== "string") {
      respondErr("internal", "Malformed request");
      return;
    }
    if (raw.principal !== null && typeof raw.principal !== "string") {
      respondErr("internal", "Malformed principal");
      return;
    }
    const req = raw as unknown as SqliteWorkerRequest;

    if (req.epochId !== currentEpochId) {
      respondErr("epoch-mismatch", "Epoch mismatch");
      return;
    }
    if (failed) {
      respondErr("write-failed", failedReason ?? "write-failed");
      return;
    }
    if (!ready || closing || closed || !cache || !openedDb) {
      respondErr("epoch-mismatch", "Worker is not ready");
      return;
    }
    if (!VALID_OPS.has(req.op)) {
      respondErr("internal", `Unknown op: ${String(req.op)}`);
      return;
    }
    if (!hasValidPayload(req.op, req.payload)) {
      respondErr("internal", "Invalid request payload");
      return;
    }
    if (req.op === "ping") {
      respondOk({ ok: true, workerId, epochId: currentEpochId });
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
      const ownerState = readFileOwnerState(readMetaStmt);
      if (ownerState.blocked) {
        failEpoch("write-failed", "write-failed");
        respondErr("write-failed", "Database marked write-failed");
        return;
      }
      if (ownerState.named.some((namedId) => namedId !== req.principal)) {
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
      let writeResult: unknown = undefined;
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
      } else if (req.op === "deleteDocDetails") {
        const payload = req.payload as { ids: string[] };
        writeResult =
          (await cache.deleteInvalidatedDocDetails?.(
            payload.ids,
            () => true,
          )) ?? [];
      }

      const ownerAfter = readFileOwnerState(readMetaStmt);
      if (pendingWriteError || ownerAfter.blocked) {
        const reason = pendingWriteError
          ? String(pendingWriteError)
          : "write-failed";
        failEpoch(reason, "write-failed");
        respondErr("write-failed", reason);
        return;
      }
      respondOk(writeResult);
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
    if (closed || closing || !data || typeof data !== "object") return;
    const msg = data as { type?: string; replyTo?: string; epochId?: string };
    if (msg.type === "discover") {
      if (
        !ready ||
        failed ||
        msg.epochId !== currentEpochId ||
        typeof msg.replyTo !== "string"
      )
        return;
      try {
        outboxFor(msg.replyTo)?.post({
          type: "worker-ready",
          workerId,
          epochId: currentEpochId,
          epoch,
        } satisfies SqliteWorkerAnnouncement);
      } catch {}
      return;
    }
    if (msg.type === "request") {
      void enqueue(() => processRequest(data, "peer"));
    }
  };

  const closeResources = async () => {
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
    for (const endpoint of peerOutboxes.values()) {
      try {
        endpoint.close();
      } catch {}
    }
    peerOutboxes.clear();
    if (readMetaStmt) {
      readMetaStmt.finalize?.();
      readMetaStmt = null;
    }
    if (openedDb) {
      const dbToClose = openedDb;
      openedDb = null;
      await dbToClose.close();
    }
  };

  return {
    async start() {
      if (closed || closing) return false;
      sharedChannel = channelTransport.open(baseChannel, handleChannelMessage);
      ownChannel = channelTransport.open(ownChannelName, handleChannelMessage);
      try {
        openedDb = await openDatabase(epoch, (error) => {
          pendingWriteError = error;
        });
      } catch (error) {
        if (closed || closing) return false;
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
            : "write-failed";
          failEpoch(String(error), code);
        }
        await this.close();
        return false;
      }
      if (closed || closing) {
        await openedDb.close();
        openedDb = null;
        return false;
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
        readMetaStmt = openedDb.driver.prepare<{ value: string }>(
          "SELECT value FROM meta WHERE key = ?",
        );
      } catch (error) {
        const code: SqliteErrorCode = isVersionMismatchError(error)
          ? "version-mismatch"
          : "internal";
        failEpoch(String(error), code);
        await this.close();
        return false;
      }
      const ownerState = readFileOwnerState(readMetaStmt);
      if (ownerState.blocked) {
        failEpoch("write-failed", "write-failed");
        await this.close();
        return false;
      }
      ready = true;
      announce({
        type: "worker-ready",
        workerId,
        epochId: currentEpochId,
        epoch,
      });
      return true;
    },
    async handleOwnerMessage(message: unknown) {
      if (!message || typeof message !== "object") return;
      const msg = message as { type?: string };
      if (msg.type === "request") {
        await enqueue(() => processRequest(message, "owner"));
      }
    },
    async close() {
      closing = true;
      await enqueue(closeResources);
    },
  };
}
