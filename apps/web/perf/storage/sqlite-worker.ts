import type {
  OpfsSAHPoolDatabase,
  SAHPoolUtil,
  Sqlite3Static,
  SqlValue,
} from "@sqlite.org/sqlite-wasm";
import {
  check,
  EVENT_COUNT,
  eventRow,
  focusId,
  liveIds,
  messageRows,
  ROW_COUNT,
  READ_BATCH_SIZE,
  sessionRows,
  WRITE_ROWS,
  writeRows,
} from "./fixture";

const moduleUrl = "/sqlite/index.mjs";
let sqlite: Sqlite3Static;
let pool: SAHPoolUtil;
let db: OpfsSAHPoolDatabase;

function decodeRows(values: SqlValue[]) {
  return values.map((value) => {
    check(typeof value === "string", "Expected SQLite row JSON");
    return JSON.parse(value) as { _id: string };
  });
}

function put(collection: string, rows: { _id: string; created_at?: number }[]) {
  const insert = db.prepare("INSERT OR REPLACE INTO rows VALUES (?, ?, ?, ?)");
  try {
    for (const row of rows) {
      insert
        .bind([collection, row._id, row.created_at ?? 0, JSON.stringify(row)])
        .stepReset();
    }
  } finally {
    insert.finalize();
  }
}

function transaction(action: () => void) {
  db.exec("BEGIN IMMEDIATE");
  try {
    action();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export const operations = {
  async open() {
    const { default: init }: typeof import("@sqlite.org/sqlite-wasm") =
      await import(moduleUrl);
    sqlite = await init();
    pool = await sqlite.installOpfsSAHPoolVfs({
      directory: "/storage-bench",
      initialCapacity: 8,
      preserveOnInitFailure: true,
    });
    db = new pool.OpfsSAHPoolDb("/cache.sqlite3");
    const journal = db.selectValue("PRAGMA journal_mode=DELETE");
    check(journal === "delete", `Unexpected journal mode ${journal}`);
    db.exec("PRAGMA synchronous=FULL");
    db.exec(`CREATE TABLE IF NOT EXISTS rows (
      collection TEXT NOT NULL, id TEXT NOT NULL, timestamp INTEGER NOT NULL,
      value TEXT NOT NULL, PRIMARY KEY (collection, id)
    );
    CREATE INDEX IF NOT EXISTS rows_by_time ON rows (collection, timestamp, id);`);
    return { journal, sqliteVersion: sqlite.version.libVersion };
  },
  seed() {
    transaction(() => {
      put("sessions", sessionRows());
      put(
        focusId,
        messageRows().map((row) => row.message),
      );
    });
    for (let start = 0; start < EVENT_COUNT; start += 2000) {
      const length = Math.min(2000, EVENT_COUNT - start);
      transaction(() =>
        put(
          "externalEvents",
          Array.from({ length }, (_, index) => eventRow(start + index)),
        ),
      );
    }
  },
  paint() {
    const placeholders = liveIds.map(() => "?").join(",");
    return {
      sessions: decodeRows(
        db.selectValues(
          `SELECT value FROM rows WHERE collection = 'sessions' AND id IN (${placeholders})`,
          liveIds,
        ),
      ),
      messages: decodeRows(
        db.selectValues(
          "SELECT value FROM rows WHERE collection = ? ORDER BY id",
          [focusId],
        ),
      ),
    };
  },
  readBatch(collection: "sessions" | "externalEvents", after: string) {
    return decodeRows(
      db.selectValues(
        "SELECT value FROM rows WHERE collection = ? AND id > ? ORDER BY id LIMIT ?",
        [collection, after, READ_BATCH_SIZE],
      ),
    );
  },
  write(rows: ReturnType<typeof writeRows>) {
    transaction(() => put("externalEvents", rows));
  },
  verify(revision: number) {
    const rows = db.selectValues(
      "SELECT value FROM rows WHERE collection = 'externalEvents' ORDER BY id LIMIT ?",
      [WRITE_ROWS],
    );
    return (
      rows.length === WRITE_ROWS &&
      rows.every(
        (json) =>
          typeof json === "string" && JSON.parse(json).revision === revision,
      )
    );
  },
  integrity() {
    return (
      db.selectValue("PRAGMA quick_check") === "ok" &&
      db.selectValue("SELECT COUNT(*) FROM rows") === ROW_COUNT
    );
  },
  retain(start: number, length: number) {
    db.exec({
      sql: `DELETE FROM rows WHERE rowid IN (
        SELECT rowid FROM rows WHERE collection = 'externalEvents' AND timestamp >= ?
        ORDER BY timestamp, id LIMIT ?
      )`,
      bind: [eventRow(start).created_at, length],
    });
  },
  verifyRetention(start: number, length: number) {
    const first = eventRow(start).created_at;
    return (
      db.selectValue(
        "SELECT COUNT(*) FROM rows WHERE collection = 'externalEvents' AND timestamp BETWEEN ? AND ?",
        [first, first + length - 1],
      ) === 0
    );
  },
  stage(revision: number) {
    db.exec("PRAGMA cache_size=1; PRAGMA cache_spill=ON; BEGIN IMMEDIATE");
    put(
      "externalEvents",
      writeRows(revision)
        .slice(0, WRITE_ROWS / 2)
        .map((row) => ({
          ...row,
          body: row.body.repeat(16),
        })),
    );
    const { wasm, capi } = sqlite;
    check(db.pointer, "SQLite crash fixture has no connection");
    const current = wasm.alloc(4);
    const highwater = wasm.alloc(4);
    try {
      const status = capi.sqlite3_db_status(
        db.pointer,
        capi.SQLITE_DBSTATUS_CACHE_SPILL,
        current,
        highwater,
        0,
      );
      check(
        status === capi.SQLITE_OK,
        "Could not read SQLite pager spill count",
      );
      const spills = wasm.peek32(current);
      check(spills > 0, "Crash fixture did not spill dirty database pages");
      return spills;
    } finally {
      wasm.dealloc(highwater);
      wasm.dealloc(current);
    }
  },
  size() {
    return {
      databaseBytes:
        Number(db.selectValue("PRAGMA page_count")) *
        Number(db.selectValue("PRAGMA page_size")),
      wasmBytes: sqlite.wasm.heap8().byteLength,
    };
  },
  close() {
    db.close();
    pool.pauseVfs();
  },
};

type Request = {
  [K in keyof typeof operations]: {
    id: number;
    op: K;
    args: Parameters<(typeof operations)[K]>;
  };
}[keyof typeof operations];

self.addEventListener("message", async (event: MessageEvent<Request>) => {
  const { id, op, args } = event.data;
  try {
    const execute = operations[op] as (...params: Request["args"]) => unknown;
    const value = await Reflect.apply(execute, operations, args);
    self.postMessage({ id, value });
  } catch (error) {
    self.postMessage({ id, error: String(error) });
  }
});
