import type { AuthTokenState } from "@platform/auth/web";
import type { Patch } from "mutative";
import type { CachedConversation } from "../storage";

export const SQLITE_WORKER_TIMEOUT_MS = 2500;
export const SQLITE_LOCK_PREFIX = "codecast-sqlite-lock";
export const SQLITE_CHANNEL_PREFIX = "codecast-sqlite-channel";
export const SQLITE_EPOCH_STORAGE_KEY = "codecast:sqlite-cache-epoch:v1";
export const SQLITE_OPFS_DIR_PREFIX = "codecast-sqlite-";
export const SQLITE_DB_FILENAME = "/cache.sqlite3";

export type CacheEpoch = {
  schemaVersion: number;
  accountEpoch: number;
  generation: number;
  principal: string | null;
  failed?: boolean;
  failedReason?: string;
  updatedAt: number;
};

export type EpochResolution = {
  action: "reuse" | "create" | "hold";
  epoch: CacheEpoch | null;
  reason: string;
};

export function epochId(epoch: CacheEpoch): string {
  return `v${epoch.schemaVersion}-a${epoch.accountEpoch}-g${epoch.generation}`;
}

export function epochDirectory(epoch: CacheEpoch): string {
  return `/${SQLITE_OPFS_DIR_PREFIX}${epochId(epoch)}`;
}

const EPOCH_DIR_PATTERN = /^codecast-sqlite-v(\d+)-a(\d+)-g(\d+)$/;

export function parseEpochDirectoryName(
  name: string,
): Pick<CacheEpoch, "schemaVersion" | "accountEpoch" | "generation"> | null {
  const clean = name.replace(/^\/+/, "");
  const match = EPOCH_DIR_PATTERN.exec(clean);
  if (!match) return null;
  const schemaVersion = Number(match[1]);
  const accountEpoch = Number(match[2]);
  const generation = Number(match[3]);
  if (
    !Number.isSafeInteger(schemaVersion) ||
    !Number.isSafeInteger(accountEpoch) ||
    !Number.isSafeInteger(generation)
  )
    return null;
  return { schemaVersion, accountEpoch, generation };
}

export function compareEpochOrder(
  a: Pick<CacheEpoch, "schemaVersion" | "accountEpoch" | "generation">,
  b: Pick<CacheEpoch, "schemaVersion" | "accountEpoch" | "generation">,
): number {
  if (a.accountEpoch !== b.accountEpoch) return a.accountEpoch - b.accountEpoch;
  if (a.generation !== b.generation) return a.generation - b.generation;
  return a.schemaVersion - b.schemaVersion;
}

export function epochVfsName(epoch: CacheEpoch): string {
  return `opfs-sahpool-${epochId(epoch)}`;
}

export function epochLockName(epoch: CacheEpoch): string {
  return `${SQLITE_LOCK_PREFIX}:v${epoch.schemaVersion}:a${epoch.accountEpoch}:g${epoch.generation}`;
}

export function epochChannelName(epoch: CacheEpoch): string {
  return `${SQLITE_CHANNEL_PREFIX}:v${epoch.schemaVersion}:a${epoch.accountEpoch}:g${epoch.generation}`;
}

export function addressedChannelName(
  baseChannel: string,
  targetId: string,
): string {
  return `${baseChannel}:to:${targetId}`;
}

export function sameEpoch(
  a: CacheEpoch | null | undefined,
  b: CacheEpoch | null | undefined,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    a.schemaVersion === b.schemaVersion &&
    a.accountEpoch === b.accountEpoch &&
    a.generation === b.generation &&
    a.principal === b.principal &&
    Boolean(a.failed) === Boolean(b.failed)
  );
}

export function parseCacheEpoch(raw: string | null): CacheEpoch | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CacheEpoch> | null;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.schemaVersion !== "number" ||
      typeof parsed.accountEpoch !== "number" ||
      typeof parsed.generation !== "number" ||
      !(typeof parsed.principal === "string" || parsed.principal === null)
    )
      return null;
    return {
      schemaVersion: parsed.schemaVersion,
      accountEpoch: parsed.accountEpoch,
      generation: parsed.generation,
      principal: parsed.principal,
      failed: parsed.failed === true ? true : undefined,
      failedReason:
        typeof parsed.failedReason === "string"
          ? parsed.failedReason
          : undefined,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
    };
  } catch {
    return null;
  }
}

export function resolveTargetEpoch(params: {
  stored: CacheEpoch | null;
  schemaVersion: number;
  principal: string | null;
  tokenState: AuthTokenState;
  now: number;
}): EpochResolution {
  const { stored, schemaVersion, principal, tokenState, now } = params;
  if (principal === null) {
    if (tokenState === "unparsable" || tokenState === "unreadable")
      return { action: "hold", epoch: null, reason: tokenState };
    if (!stored) return { action: "hold", epoch: null, reason: "signed-out" };
    if (stored.principal === null && stored.schemaVersion === schemaVersion)
      return { action: "hold", epoch: stored, reason: "signed-out" };
    return {
      action: "create",
      epoch: {
        schemaVersion,
        accountEpoch: stored.accountEpoch + 1,
        generation: 1,
        principal: null,
        updatedAt: now,
      },
      reason: "sign-out",
    };
  }
  if (!stored) {
    return {
      action: "create",
      epoch: {
        schemaVersion,
        accountEpoch: 1,
        generation: 1,
        principal,
        updatedAt: now,
      },
      reason: "initial",
    };
  }
  if (stored.schemaVersion !== schemaVersion) {
    return {
      action: "create",
      epoch: {
        schemaVersion,
        accountEpoch: stored.accountEpoch + 1,
        generation: 1,
        principal,
        updatedAt: now,
      },
      reason: schemaVersion > stored.schemaVersion ? "upgrade" : "rollback",
    };
  }
  if (stored.principal !== principal) {
    return {
      action: "create",
      epoch: {
        schemaVersion,
        accountEpoch: stored.accountEpoch + 1,
        generation: 1,
        principal,
        updatedAt: now,
      },
      reason: "account-switch",
    };
  }
  if (stored.failed) {
    return {
      action: "create",
      epoch: {
        schemaVersion,
        accountEpoch: stored.accountEpoch,
        generation: stored.generation + 1,
        principal,
        updatedAt: now,
      },
      reason: stored.failedReason ?? "write-failed",
    };
  }
  return { action: "reuse", epoch: stored, reason: "match" };
}

export function nextGenerationEpoch(
  epoch: CacheEpoch,
  reason: string,
  now: number,
): CacheEpoch {
  return {
    schemaVersion: epoch.schemaVersion,
    accountEpoch: epoch.accountEpoch,
    generation: epoch.generation + 1,
    principal: epoch.principal,
    updatedAt: now,
  };
}

export function markEpochFailed(
  epoch: CacheEpoch,
  reason: string,
  now: number,
): CacheEpoch {
  return {
    ...epoch,
    failed: true,
    failedReason: reason,
    updatedAt: now,
  };
}

export type EpochStore = {
  read(): CacheEpoch | null;
  write(epoch: CacheEpoch): boolean | void;
  subscribe?(listener: (epoch: CacheEpoch | null) => void): () => void;
};

export type ChannelEndpoint = {
  post(data: unknown): void;
  close(): void;
};

export type ChannelTransport = {
  open(
    channelName: string,
    onMessage: (data: unknown) => void,
  ): ChannelEndpoint;
};

export type LockAdapter = {
  request(
    name: string,
    signal: AbortSignal,
    onAcquired: () => Promise<void> | void,
  ): Promise<void>;
};

export type WorkerHandle = {
  postMessage(message: unknown): void;
  terminate(): void;
};

export type WorkerSpawner = (
  epoch: CacheEpoch,
  onMessage: (data: unknown) => void,
  onError: (message: string) => void,
) => WorkerHandle;

export type SqliteErrorCode =
  | "epoch-mismatch"
  | "owner-mismatch"
  | "write-failed"
  | "opfs-missing"
  | "version-mismatch"
  | "internal";

export type SqliteWritePatchPayload = {
  patches: Patch[];
  state: Record<string, unknown>;
  snapshotDrops?: Record<string, string[]>;
  evictions?: Record<string, string[]>;
};

export type SqliteFlushConversation = {
  conversationId: string;
  messages?: { rows: unknown[]; pagination: unknown };
  userMessages?: unknown[];
};

export type SqliteFlushBatchPayload = {
  patches?: Patch[];
  state?: Record<string, unknown>;
  snapshotDrops?: Record<string, string[]>;
  evictions?: Record<string, string[]>;
  conversations?: SqliteFlushConversation[];
};

export type SqliteWorkerPayloads = {
  ping: Record<string, never>;
  loadCache: {
    keys?: readonly string[];
    context?: Record<string, unknown>;
  };
  loadPaintCache: Record<string, never>;
  writePatches: SqliteWritePatchPayload;
  flushBatch: SqliteFlushBatchPayload;
  loadConversationMessages: { conversationId: string };
  writeConversationMessages: {
    conversationId: string;
    messages: unknown[];
    pagination: unknown;
  };
  writeConversationUserMessages: {
    conversationId: string;
    messages: unknown[];
  };
  deleteDocDetails: {
    ids: string[];
  };
};

export type SqliteWorkerResults = {
  ping: { ok: true; workerId: string; epochId: string };
  loadCache: Record<string, any> | null;
  loadPaintCache: Record<string, any> | null;
  writePatches: void;
  flushBatch: void;
  loadConversationMessages: CachedConversation | null;
  writeConversationMessages: void;
  writeConversationUserMessages: void;
  deleteDocDetails: string[];
};

export type SqliteWorkerOp = keyof SqliteWorkerPayloads;

export type SqliteWorkerRequest<K extends SqliteWorkerOp = SqliteWorkerOp> = {
  type: "request";
  id: string;
  replyTo: string;
  epochId: string;
  principal: string | null;
  op: K;
  payload: SqliteWorkerPayloads[K];
};

export type SqliteWorkerResponse =
  | {
      type: "response";
      id: string;
      workerId: string;
      epochId: string;
      ok: true;
      result: unknown;
    }
  | {
      type: "response";
      id: string;
      workerId: string;
      epochId: string;
      ok: false;
      error: string;
      code: SqliteErrorCode;
    };

export type SqliteWorkerAnnouncement =
  | {
      type: "worker-ready";
      workerId: string;
      epochId: string;
      epoch: CacheEpoch;
    }
  | {
      type: "worker-closing";
      workerId: string;
      epochId: string;
    }
  | {
      type: "worker-epoch-failed";
      workerId: string;
      epochId: string;
      epoch: CacheEpoch;
      reason: string;
      code: SqliteErrorCode;
    }
  | {
      type: "worker-opfs-missing";
      workerId: string;
      epochId: string;
      error: string;
    };

export type SqliteChannelMessage =
  | {
      type: "discover";
      replyTo: string;
      epochId: string;
    }
  | SqliteWorkerRequest
  | SqliteWorkerResponse
  | SqliteWorkerAnnouncement;

export type SqliteOwnerInitMessage = {
  type: "init";
  epoch: CacheEpoch;
};

export type SqliteOwnerCloseMessage = {
  type: "close";
};

export type SqliteOwnerCommand =
  | SqliteOwnerInitMessage
  | SqliteOwnerCloseMessage
  | SqliteWorkerRequest;
