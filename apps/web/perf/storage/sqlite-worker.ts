import {
  check,
  EVENT_COUNT,
  eventRow,
  focusId,
  liveIds,
  messageRows,
  sessionRows,
  WRITE_ROWS,
  writeRows,
} from "./fixture";

type Cell = string | number;
type Database = {
  exec: (arg: string | { sql: string; bind: Cell[] }) => void;
  selectValue: (sql: string, bind?: Cell[]) => Cell;
  selectValues: (sql: string, bind?: Cell[]) => string[];
  prepare: (sql: string) => {
    bind: (args: Cell[]) => { stepReset: () => void };
    finalize: () => void;
  };
  close: () => void;
};
type Pool = {
  OpfsSAHPoolDb: new (path: string) => Database;
  pauseVfs: () => void;
};
type SQLite = {
  installOpfsSAHPoolVfs: (options: {
    directory: string;
    initialCapacity: number;
    preserveOnInitFailure: boolean;
  }) => Promise<Pool>;
  wasm: { heap8: () => Uint8Array };
  version: { libVersion: string };
};

const moduleUrl = "/sqlite/index.mjs";
let sqlite: SQLite;
let pool: Pool;
let db: Database;

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

function read(collection: string) {
  return db
    .selectValues("SELECT value FROM rows WHERE collection = ? ORDER BY id", [
      collection,
    ])
    .map((json) => JSON.parse(json));
}

export const operations = {
  async open() {
    const { default: init } = await import(moduleUrl);
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
      sessions: db
        .selectValues(
          `SELECT value FROM rows WHERE collection = 'sessions' AND id IN (${placeholders})`,
          liveIds,
        )
        .map((json) => JSON.parse(json)),
      messages: read(focusId),
    };
  },
  full() {
    return {
      sessions: Object.fromEntries(
        read("sessions").map((row) => [row._id, row]),
      ),
      messages: read(focusId),
      externalEvents: Object.fromEntries(
        read("externalEvents").map((row) => [row._id, row]),
      ),
    };
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
      rows.every((json) => JSON.parse(json).revision === revision)
    );
  },
  integrity() {
    return (
      db.selectValue("PRAGMA quick_check") === "ok" &&
      db.selectValue("SELECT COUNT(*) FROM rows") ===
        EVENT_COUNT + sessionRows().length + messageRows().length
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
    db.exec("BEGIN IMMEDIATE");
    put("externalEvents", writeRows(revision).slice(0, WRITE_ROWS / 2));
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
