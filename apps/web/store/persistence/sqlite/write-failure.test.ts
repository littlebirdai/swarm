import { expect, test, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Patch } from "mutative";
import { createSqliteCache } from "./cache-storage";
import type { SqliteDriver } from "./schema";

const auth = {
  current: () => "owner",
  resolve: async () => "owner",
  tokenState: () => "named" as const,
  epoch: () => 0,
};
const id = "a".repeat(32);
const secondId = "b".repeat(32);
const row = { _id: id, updated_at: Date.now() };
const secondRow = { ...row, _id: secondId };
const patch = (...path: string[]): Patch => ({
  op: "replace",
  path,
  value: null,
});

function ownerStamp(db: Database) {
  const meta = db
    .query<{ value: string }, []>(
      "SELECT value FROM meta WHERE key = 'cacheOwner'",
    )
    .get();
  return meta && JSON.parse(meta.value);
}

test.each(["row", "encode", "meta-only"] as const)(
  "SQLite shares the cursor fence across connections after a %s failure",
  async (failure) => {
    const dir = mkdtempSync(join(tmpdir(), "sqlite-cache-fence-"));
    try {
      const file = join(dir, "cache.sqlite");
      using first = new Database(file);
      using second = new Database(file);
      const a = createSqliteCache(first, auth);
      const b = createSqliteCache(second, auth);
      a.writePatches([patch("sessions"), patch("syncMeta")], {
        sessions: { [id]: row },
        syncMeta: { cursor: 1 },
      });
      expect(await b.loadCache(["syncMeta"])).toEqual({
        syncMeta: { cursor: 1 },
      });
      if (failure === "row") {
        first.exec(`CREATE TRIGGER fail_row BEFORE INSERT ON collection_rows
          BEGIN SELECT RAISE(ABORT, 'row failure'); END`);
      }
      a.writePatches(
        failure === "meta-only"
          ? [patch("liveInboxIdList"), patch("syncMeta")]
          : [patch("sessions", secondId), patch("syncMeta")],
        {
          sessions: {
            [secondId]:
              failure === "encode"
                ? { ...secondRow, invalid: BigInt(1) }
                : secondRow,
          },
          liveInboxIdList: [BigInt(1)],
          syncMeta: { cursor: 2 },
        },
      );
      if (failure === "row") first.exec("DROP TRIGGER fail_row");
      expect(ownerStamp(second)).toMatchObject({
        principal: "owner",
        blocked: true,
      });
      b.writePatches([patch("sessions", secondId), patch("syncMeta")], {
        sessions: { [secondId]: secondRow },
        syncMeta: { cursor: 3 },
      });
      expect(await b.loadCache(["sessions", "syncMeta"])).toEqual({
        sessions: { [id]: row, [secondId]: secondRow },
        syncMeta: { cursor: 1 },
      });
      await b.purgeLocalCache({ keepPendingInputFor: "owner" });
      a.writePatches([patch("syncMeta")], { syncMeta: { cursor: 4 } });
      expect(await b.loadCache(["syncMeta"])).toEqual({
        syncMeta: { cursor: 4 },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("SQLite advances sync metadata with a legacy owner row", async () => {
  using db = new Database(":memory:");
  const store = createSqliteCache(db, auth);
  const insert = db.query("INSERT INTO meta (key, value) VALUES (?, ?)");
  insert.run("cacheOwner", JSON.stringify({ principal: "owner" }));
  insert.run("syncMeta", JSON.stringify({ cursor: 1 }));
  store.writePatches([patch("syncMeta")], { syncMeta: { cursor: 2 } });
  expect(await store.loadCache(["syncMeta"])).toEqual({
    syncMeta: { cursor: 2 },
  });
});

test("SQLite persists the retried fence and resumes cursor writes after a sibling purge", async () => {
  using db = new Database(":memory:");
  const a = createSqliteCache(db, auth);
  a.writePatches([patch("syncMeta")], { syncMeta: { cursor: 1 } });
  db.exec("PRAGMA query_only = ON");
  a.writePatches([patch("sessions"), patch("syncMeta")], {
    sessions: { [id]: row },
    syncMeta: { cursor: 2 },
  });
  db.exec("PRAGMA query_only = OFF");
  expect(ownerStamp(db)).toMatchObject({ principal: "owner", blocked: false });
  a.writePatches([patch("syncMeta")], { syncMeta: { cursor: 3 } });
  const b = createSqliteCache(db, auth);
  b.writePatches([patch("syncMeta")], { syncMeta: { cursor: 4 } });
  expect(await b.loadCache(["syncMeta"])).toEqual({ syncMeta: { cursor: 1 } });
  await b.purgeLocalCache({ keepPendingInputFor: "owner" });
  a.writePatches([patch("syncMeta")], { syncMeta: { cursor: 5 } });
  expect(await b.loadCache(["syncMeta"])).toEqual({ syncMeta: { cursor: 5 } });
});

test("SQLite refuses writes to ownerless residue before the first load", () => {
  using db = new Database(":memory:");
  const store = createSqliteCache(db, auth);
  db.query("INSERT INTO collection_rows VALUES ('sessions', ?, NULL, ?)").run(
    id,
    JSON.stringify(row),
  );
  store.writePatches([patch("sessions", secondId)], {
    sessions: { [secondId]: secondRow },
  });
  expect(ownerStamp(db)).toBeNull();
  expect(db.query("SELECT id FROM collection_rows").all()).toEqual([{ id }]);
});

test("SQLite keeps pagination when a message cannot be stored", async () => {
  using db = new Database(":memory:");
  const store = createSqliteCache(db, auth);
  const message = { _id: "good" };
  store.writeConversationMessages(id, [message], { cursor: 1 });
  store.writeConversationMessages(
    id,
    [message, { _id: "lost", value: BigInt(1) }],
    { cursor: 2 },
  );
  expect(await store.loadConversationMessages(id)).toMatchObject({
    messages: [message],
    pagination: { cursor: 1 },
  });
});

test("SQLite retries pruning when the transaction rolls back after the deletes", async () => {
  using db = new Database(":memory:");
  let failCommit = false;
  const driver: SqliteDriver = {
    exec: db.exec.bind(db),
    prepare: db.prepare.bind(db),
    transaction: (body) =>
      db.transaction(() => {
        const result = body();
        if (failCommit) throw new Error("commit failed");
        return result;
      }),
  };
  const store = createSqliteCache(driver, auth);
  await store.loadCache(["sessions"]);
  db.query(
    "INSERT INTO conversation_meta (id, latest_timestamp, touched_at) VALUES (?, 1, 1)",
  ).run(id);
  const clock = spyOn(Date, "now").mockReturnValue(Date.now());
  try {
    failCommit = true;
    store.writeConversationMessages(secondId, [{ _id: "trigger" }], undefined);
    failCommit = false;
    expect(await store.loadConversationMessages(id)).not.toBeNull();
    store.writeConversationMessages(secondId, [{ _id: "retry" }], undefined);
    expect(await store.loadConversationMessages(id)).toBeNull();
  } finally {
    clock.mockRestore();
  }
});

test("SQLite rolls back valid rows if the same batch cannot save its fence", async () => {
  using db = new Database(":memory:");
  const store = createSqliteCache(db, auth);
  await store.loadCache(["sessions"]);
  db.exec(`CREATE TRIGGER fail_fence BEFORE INSERT ON meta
    WHEN new.key = 'cacheOwner' AND json_extract(new.value, '$.blocked')
    BEGIN SELECT RAISE(ABORT, 'fence failed'); END`);
  store.writePatches([patch("sessions"), patch("syncMeta")], {
    sessions: { [id]: row, [secondId]: { ...secondRow, invalid: BigInt(1) } },
    syncMeta: { cursor: 1 },
  });
  db.exec("DROP TRIGGER fail_fence");
  expect(await store.loadCache(["sessions", "syncMeta"])).toBeNull();
  store.writePatches([patch("sessions"), patch("syncMeta")], {
    sessions: { [id]: row },
    syncMeta: { cursor: 2 },
  });
  expect(await store.loadCache(["sessions", "syncMeta"])).toEqual({
    sessions: { [id]: row },
  });
});
