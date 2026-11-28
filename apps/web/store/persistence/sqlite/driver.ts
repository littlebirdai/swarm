import type {
  Database,
  SAHPoolUtil,
  Sqlite3Static,
  SqlValue as WasmSqlValue,
} from "@sqlite.org/sqlite-wasm";
import {
  epochDirectory,
  epochVfsName,
  SQLITE_DB_FILENAME,
  SQLITE_OPFS_DIR_PREFIX,
  type CacheEpoch,
} from "./protocol";
import type { SqliteDriver, SqlValue } from "./schema";

export function isOpfsMissingError(error: unknown): boolean {
  const message = String(error);
  return (
    /Missing required OPFS APIs/i.test(message) ||
    /SecurityError/i.test(message) ||
    /NotAllowedError/i.test(message) ||
    /OPFS/i.test(message) ||
    /createSyncAccessHandle/i.test(message)
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

export async function openOpfsSahPoolDatabase(
  sqlite3: Sqlite3Static,
  epoch: CacheEpoch,
  onWriteError?: (error: unknown) => void,
): Promise<OpenedWasmDatabase> {
  const pool: SAHPoolUtil = await sqlite3.installOpfsSAHPoolVfs({
    name: epochVfsName(epoch),
    directory: epochDirectory(epoch),
    preserveOnInitFailure: true,
  });
  let db: Database;
  try {
    db = new pool.OpfsSAHPoolDb(SQLITE_DB_FILENAME);
    db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;");
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

export async function cleanupStaleEpochDirectories(
  keepDirectory: string,
): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.storage?.getDirectory)
    return;
  const keepName = keepDirectory.replace(/^\/+/, "");
  try {
    const root = (await navigator.storage.getDirectory()) as unknown as {
      entries?: () => AsyncIterable<[string, unknown]>;
      removeEntry?: (
        name: string,
        opts?: { recursive?: boolean },
      ) => Promise<void>;
    };
    if (
      typeof root.entries !== "function" ||
      typeof root.removeEntry !== "function"
    )
      return;
    for await (const [name] of root.entries()) {
      if (!name.startsWith(SQLITE_OPFS_DIR_PREFIX) || name === keepName)
        continue;
      try {
        await root.removeEntry(name, { recursive: true });
      } catch {}
    }
  } catch {}
}
