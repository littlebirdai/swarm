import type {
  Database,
  SAHPoolUtil,
  Sqlite3Static,
  SqlValue as WasmSqlValue,
} from "@sqlite.org/sqlite-wasm";
import {
  compareEpochOrder,
  epochDirectory,
  epochLockName,
  epochVfsName,
  parseEpochDirectoryName,
  SQLITE_DB_FILENAME,
  SQLITE_OPFS_DIR_PREFIX,
  type CacheEpoch,
} from "./protocol";
import type { SqliteDriver, SqlValue } from "./schema";

const SAH_CONTENTION_RETRY_MS = [40, 120];

export function isOpfsContentionOrQuotaError(error: unknown): boolean {
  const message = String(error);
  return (
    /NoModificationAllowedError/i.test(message) ||
    /QuotaExceededError/i.test(message) ||
    /GetSyncAccessHandle/i.test(message) ||
    /already open/i.test(message) ||
    /busy/i.test(message)
  );
}

export function isOpfsMissingError(error: unknown): boolean {
  if (isOpfsContentionOrQuotaError(error)) return false;
  const message = String(error);
  return (
    /Missing required OPFS APIs/i.test(message) ||
    /SecurityError/i.test(message) ||
    /NotAllowedError/i.test(message) ||
    /createSyncAccessHandle is not a function/i.test(message)
  );
}

export function isVersionMismatchError(error: unknown): boolean {
  return /Unsupported SQLite cache version/i.test(String(error));
}

export function createWasmSqliteDriver(
  db: Database,
  onWriteError?: (error: unknown) => void,
): SqliteDriver {
  return {
    exec(sql: string) {
      try {
        return db.exec(sql);
      } catch (error) {
        onWriteError?.(error);
        throw error;
      }
    },
    prepare<Row>(sql: string) {
      const stmt = db.prepare(sql);
      return {
        get(...params: SqlValue[]): Row | null {
          try {
            if (params.length) stmt.bind(params as WasmSqlValue[]);
            if (!stmt.step()) return null;
            return stmt.get({}) as Row;
          } finally {
            stmt.resetNoThrow(true);
          }
        },
        all(...params: SqlValue[]): Row[] {
          try {
            if (params.length) stmt.bind(params as WasmSqlValue[]);
            const rows: Row[] = [];
            while (stmt.step()) rows.push(stmt.get({}) as Row);
            return rows;
          } finally {
            stmt.resetNoThrow(true);
          }
        },
        run(...params: SqlValue[]) {
          try {
            if (params.length) stmt.bind(params as WasmSqlValue[]);
            stmt.stepReset();
          } catch (error) {
            stmt.resetNoThrow(true);
            onWriteError?.(error);
            throw error;
          }
        },
        finalize() {
          try {
            stmt.finalize();
          } catch {}
        },
      };
    },
    transaction<Result>(body: () => Result): () => Result {
      return () => {
        try {
          return db.transaction("IMMEDIATE", () => body());
        } catch (error) {
          onWriteError?.(error);
          throw error;
        }
      };
    },
  };
}

export type OpenedWasmDatabase = {
  driver: SqliteDriver;
  close(): Promise<void>;
  removeStorage(): Promise<void>;
};

type SahPoolStatic = Omit<Sqlite3Static, "installOpfsSAHPoolVfs"> & {
  installOpfsSAHPoolVfs(
    options?: Parameters<Sqlite3Static["installOpfsSAHPoolVfs"]>[0] & {
      forceReinitIfPreviouslyFailed?: boolean;
    },
  ): Promise<SAHPoolUtil>;
};

export async function openPoolOnce(
  sqlite3: Sqlite3Static,
  epoch: CacheEpoch,
  onWriteError?: (error: unknown) => void,
): Promise<OpenedWasmDatabase> {
  const pool: SAHPoolUtil = await (
    sqlite3 as unknown as SahPoolStatic
  ).installOpfsSAHPoolVfs({
    name: epochVfsName(epoch),
    directory: epochDirectory(epoch),
    preserveOnInitFailure: true,
    forceReinitIfPreviouslyFailed: true,
  });
  let db: Database;
  try {
    if (pool.isPaused()) await pool.unpauseVfs();
    db = new pool.OpfsSAHPoolDb(SQLITE_DB_FILENAME);
    db.exec("PRAGMA journal_mode=TRUNCATE; PRAGMA synchronous=NORMAL;");
  } catch (error) {
    try {
      pool.pauseVfs();
    } catch {}
    throw error;
  }
  const driver = createWasmSqliteDriver(db, onWriteError);
  let closed = false;
  return {
    driver,
    async close() {
      if (closed) return;
      closed = true;
      try {
        db.close();
      } catch {}
      try {
        if (!pool.isPaused()) pool.pauseVfs();
      } catch {}
    },
    async removeStorage() {
      if (!closed) {
        closed = true;
        try {
          db.close();
        } catch {}
      }
      try {
        await pool.removeVfs();
      } catch {}
    },
  };
}

export async function openOpfsSahPoolDatabase(
  sqlite3: Sqlite3Static,
  epoch: CacheEpoch,
  onWriteError?: (error: unknown) => void,
): Promise<OpenedWasmDatabase> {
  let attempt = 0;
  for (;;) {
    try {
      return await openPoolOnce(sqlite3, epoch, onWriteError);
    } catch (error) {
      const retryDelay = SAH_CONTENTION_RETRY_MS[attempt];
      const retryable =
        retryDelay !== undefined &&
        isOpfsContentionOrQuotaError(error) &&
        !/QuotaExceededError/i.test(String(error));
      if (!retryable) throw error;
      attempt++;
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    }
  }
}

async function queryHeldLocks(): Promise<ReadonlySet<string> | null> {
  if (typeof navigator === "undefined") return null;
  const locks = (
    navigator as {
      locks?: {
        query?: () => Promise<{ held?: Array<{ name?: string }> }>;
      };
    }
  ).locks;
  if (typeof locks?.query !== "function") return null;
  try {
    const state = await locks.query();
    const names = new Set<string>();
    for (const entry of state.held ?? []) {
      if (typeof entry.name === "string") names.add(entry.name);
    }
    return names;
  } catch {
    return null;
  }
}

export async function cleanupStaleEpochDirectories(
  currentEpoch: Pick<
    CacheEpoch,
    "schemaVersion" | "accountEpoch" | "generation"
  >,
  options?: {
    getRoot?: () => Promise<{
      entries?: () => AsyncIterable<[string, unknown]>;
      removeEntry?: (
        name: string,
        opts?: { recursive?: boolean },
      ) => Promise<void>;
    }>;
    getHeldLocks?: () => Promise<ReadonlySet<string> | null>;
  },
): Promise<void> {
  const getRoot =
    options?.getRoot ??
    (typeof navigator !== "undefined" && navigator.storage?.getDirectory
      ? () =>
          navigator.storage.getDirectory() as Promise<{
            entries?: () => AsyncIterable<[string, unknown]>;
            removeEntry?: (
              name: string,
              opts?: { recursive?: boolean },
            ) => Promise<void>;
          }>
      : null);
  if (!getRoot) return;
  const heldLocks = await (options?.getHeldLocks ?? queryHeldLocks)();
  if (!heldLocks) return;
  const keepName = epochDirectory({
    ...currentEpoch,
    principal: null,
    updatedAt: 0,
  }).replace(/^\/+/, "");
  try {
    const root = await getRoot();
    if (
      typeof root.entries !== "function" ||
      typeof root.removeEntry !== "function"
    )
      return;
    for await (const [name] of root.entries()) {
      if (!name.startsWith(SQLITE_OPFS_DIR_PREFIX) || name === keepName)
        continue;
      const parsed = parseEpochDirectoryName(name);
      if (!parsed) continue;
      if (compareEpochOrder(parsed, currentEpoch) >= 0) continue;
      const lockName = epochLockName({
        ...parsed,
        principal: null,
        updatedAt: 0,
      });
      if (heldLocks.has(lockName)) continue;
      try {
        await root.removeEntry(name, { recursive: true });
      } catch {}
    }
  } catch {}
}
