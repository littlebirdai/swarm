export type SqlValue = string | number | null;

export type SqliteDriver = {
  exec(sql: string): unknown;
  prepare<Row>(sql: string): {
    get(...params: SqlValue[]): Row | null;
    all(...params: SqlValue[]): Row[];
    run(...params: SqlValue[]): unknown;
  };
  transaction<Result>(body: () => Result): () => Result;
};

const VERSION = 1;

export function openSchema(db: SqliteDriver, readOnly: boolean) {
  const checkVersion = () => {
    const version = db
      .prepare<{ version: number }>(
        "SELECT max(version) AS version FROM migrations",
      )
      .get()?.version;
    if (version !== VERSION)
      throw new Error("Unsupported SQLite cache version");
  };
  if (readOnly) {
    checkVersion();
    return;
  }
  db.transaction(() => {
    const exists = db
      .prepare("SELECT 1 FROM sqlite_schema WHERE name = 'migrations'")
      .get();
    if (!exists) {
      db.exec(`
        CREATE TABLE migrations (version INTEGER PRIMARY KEY);
        CREATE TABLE meta (key TEXT NOT NULL PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE collection_rows (
          collection TEXT NOT NULL,
          id TEXT NOT NULL,
          timestamp REAL,
          value TEXT NOT NULL,
          PRIMARY KEY (collection, id)
        );
        CREATE TABLE conversation_meta (
          id TEXT NOT NULL PRIMARY KEY,
          pagination TEXT,
          latest_timestamp REAL,
          user_messages TEXT,
          touched_at INTEGER NOT NULL
        );
        CREATE INDEX conversation_retention ON conversation_meta (latest_timestamp, id);
        CREATE TABLE message_rows (
          conversation_id TEXT NOT NULL,
          message_key TEXT NOT NULL,
          position REAL NOT NULL,
          value TEXT NOT NULL,
          PRIMARY KEY (conversation_id, message_key)
        );
        CREATE INDEX message_order ON message_rows (conversation_id, position, message_key);
      `);
      db.prepare("INSERT INTO migrations VALUES (?)").run(VERSION);
    }
    checkVersion();
  })();
}

export const encode = (value: unknown): string => {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError("Cache value must be JSON");
  return json;
};
