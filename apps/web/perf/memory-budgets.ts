import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import type { ReplicationChannel } from "@platform/engine";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import {
  installSignedInPrincipal,
  TEST_PRINCIPAL,
} from "../store/__tests__/fixtures/signedInPrincipal";
import {
  REGISTERED_COLLECTION_KEYS,
  REPLICATED_STORE_KEYS,
} from "../store/clientSyncRegistry";
import { desktopWindowKeys } from "../store/desktop-panel-keys";
import { panelReplicationTransport } from "../store/desktop-panel-transport";
import {
  MAX_DOC_DETAILS_ON_DISK,
  pruneCachedDocDetails,
} from "../store/doc-detail-disk";
import { clearProtectedInboxMemory, useInboxStore } from "../store/inboxStore";
import { authPrincipal } from "../lib/authPrincipal";
import { cacheStorage, loadCache, writePatchesToIDB } from "../store/idb-cache";
import { _reopenForTests, db } from "../store/persistence/db";
import {
  createSqliteCache,
  type SqliteCacheStorage,
} from "../store/persistence/sqlite/cache-storage";
import {
  enqueueDispatch,
  loadOutbox,
  removeDispatch,
} from "../store/persistence/outbox";
import { writeOwnerStamp } from "../store/persistence/ownership";
import {
  replicationFollowerFor,
  replicationHostFor,
} from "../store/sync-replication";
import { replaceGlobals } from "../test-helpers/globals";
import {
  budgetMessages,
  budgetTail,
  calibratedDocDetailRows,
  calibratedDocRows,
  calibratedSessionRows,
  fixtureSizes,
  id,
  now,
  retainedRows,
  session,
} from "./store-budget-fixture";
import { checkStoreBudget } from "./store-budget-limits";

const state = useInboxStore.getState;
const allKeys = [...REGISTERED_COLLECTION_KEYS, "conversations"];

async function awaitWithin<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function measureWindowPopulatedCollections(
  roleFlag: string | null,
  scopeFlag: string,
) {
  const name = `budget-scope-${crypto.randomUUID()}`;
  const hostState = Object.fromEntries(
    allKeys.map((key, index) => {
      const row = {
        ...session(index),
        short_id: "ct-1",
        _cachedAt: now,
        ...(key === "taskComments" ? { comments: [] } : {}),
      };
      return [key, { [row._id]: row }];
    }),
  );
  useInboxStore.setState({
    ...Object.fromEntries(allKeys.map((key) => [key, {}])),
    pending: {},
    syncRole: "follower",
  } as any);

  const prevFlag = process.env.VITE_DESKTOP_PANEL_SCOPE;
  process.env.VITE_DESKTOP_PANEL_SCOPE = scopeFlag;
  const restore = replaceGlobals({
    window: { __CODECAST_ELECTRON__: roleFlag ? { [roleFlag]: true } : {} },
  });
  const keys = desktopWindowKeys()?.filter((key) =>
    REPLICATED_STORE_KEYS.includes(key),
  );
  const allowedKeys = keys ? new Set(keys) : undefined;
  const excludedKey = allowedKeys
    ? REPLICATED_STORE_KEYS.find(
        (key) => !allowedKeys.has(key) && key in hostState,
      )
    : undefined;
  const hostTransport = panelReplicationTransport(name, "host", true);
  hostTransport.activateHost();
  const panelTransport = panelReplicationTransport(
    name,
    "follower",
    false,
    keys,
  );
  const wireViolations: string[] = [];
  const liveSession = { ...session(9999), title: "Live included" };
  const liveDelivered = Promise.withResolvers<void>();
  const followerChannel: ReplicationChannel = {
    post: (message) => panelTransport.channel.post(message),
    onMessage(listener) {
      return panelTransport.channel.onMessage((message) => {
        if (allowedKeys) {
          const messageKeys =
            message.type === "snapshot"
              ? Object.keys(message.entries)
              : message.type === "snapshotChunk" || message.type === "update"
                ? message.updates.map((update) => update.key)
                : [];
          for (const key of messageKeys) {
            if (!allowedKeys.has(key))
              wireViolations.push(`${message.type}:${key}`);
          }
        }
        listener(message);
        if (
          message.type === "update" &&
          message.updates.some(
            (update) =>
              update.key === "sessions" &&
              update.upserts?.some((row) => row._id === liveSession._id),
          )
        ) {
          liveDelivered.resolve();
        }
      });
    },
  };
  const host = replicationHostFor(
    "host",
    hostTransport.channel,
    () => hostState,
  );
  const synced = Promise.withResolvers<void>();
  const follower = replicationFollowerFor(
    "follower",
    followerChannel,
    (ready) => {
      if (ready) synced.resolve();
    },
    undefined,
    keys,
  );
  try {
    await awaitWithin(
      synced.promise,
      5000,
      `Replication handshake timed out for ${roleFlag ?? "main"} (check scopedFollowerChannel hello key attachment and scopedHostChannel delivery)`,
    );
    if (excludedKey) {
      host.publish([
        {
          key: excludedKey,
          upserts: [{ _id: "excluded-live", title: "Excluded live" }],
        },
        { key: "sessions", upserts: [liveSession] },
      ]);
      await awaitWithin(
        liveDelivered.promise,
        5000,
        `Scoped live update timed out for ${roleFlag}`,
      );
      assert.equal(
        wireViolations.length,
        0,
        `Scoped follower for ${roleFlag} received excluded replication keys on wire: ${wireViolations.join(", ")}`,
      );
      assert.equal(
        Object.keys((state() as any)[excludedKey] ?? {}).length,
        0,
        `Scoped follower for ${roleFlag} populated excluded key ${excludedKey}`,
      );
    }
    return Object.entries(state()).filter(
      ([key, value]) => key in hostState && Object.keys(value ?? {}).length > 0,
    ).length;
  } finally {
    follower.stop();
    host.stop();
    panelTransport.close();
    hostTransport.close();
    restore();
    if (prevFlag === undefined) delete process.env.VITE_DESKTOP_PANEL_SCOPE;
    else process.env.VITE_DESKTOP_PANEL_SCOPE = prevFlag;
  }
}

async function measureDesktopWindowCollections() {
  const main = await measureWindowPopulatedCollections(null, "0");
  checkStoreBudget("Main window populated collections", main);

  const panels = [
    ["Palette populated collections", "isPaletteWindow"],
    ["People populated collections", "isPeopleWindow"],
    ["Call panel populated collections", "isCallPanelWindow"],
    ["Agent dock populated collections", "isAgentDockWindow"],
  ] as const;

  for (const [budgetName, roleFlag] of panels) {
    const count = await measureWindowPopulatedCollections(roleFlag, "1");
    assert(
      count < main,
      `${budgetName} (${count}) must stay below main window (${main})`,
    );
    checkStoreBudget(budgetName, count);
  }
}

const REPLAY_TABLE_BASELINES: Record<string, number> = {
  conversationMessageMeta: 5,
  conversationMessageRows: 1000,
  conversationUserMessages: 5,
  conversations: 1200,
  deployDetails: 50,
  deployReach: 300,
  docDetails: 200,
  docs: 200,
  externalEvents: 2000,
  meta: 2,
  mySends: 10000,
  pendingEntries: 400,
  pullRequestDetails: 12,
  pullRequests: 20,
  runGraphs: 40,
  sessions: 1200,
  settingsData: 1,
  taskComments: 1500,
  tasks: 50,
};

async function snapshotPersistedCounts(
  sqliteDb: Database,
): Promise<Record<string, number>> {
  const idbCounts = await awaitWithin(
    db.transaction("r", db.tables, async () =>
      Object.fromEntries(
        await Promise.all(
          db.tables.map(async (table) => [table.name, await table.count()]),
        ),
      ),
    ),
    5000,
    "Timed out reading IndexedDB journal table counts",
  );
  const collectionRows = sqliteDb
    .prepare<{ collection: string; count: number }>(
      "SELECT collection, COUNT(*) AS count FROM collection_rows GROUP BY collection",
    )
    .all();
  const messageMetaCount = sqliteDb
    .prepare<{ count: number }>(
      "SELECT COUNT(*) AS count FROM conversation_meta",
    )
    .get()!.count;
  const messageRowCount = sqliteDb
    .prepare<{ count: number }>("SELECT COUNT(*) AS count FROM message_rows")
    .get()!.count;
  const userMessageCount = sqliteDb
    .prepare<{ count: number }>("SELECT COUNT(*) AS count FROM user_messages")
    .get()!.count;
  const counts: Record<string, number> = {
    conversationMessageMeta: messageMetaCount,
    conversationMessageRows: messageRowCount,
    conversationUserMessages: userMessageCount,
    meta: idbCounts.meta ?? 0,
    pendingEntries: idbCounts.pendingEntries ?? 0,
    ...(idbCounts.dispatchOutbox
      ? { dispatchOutbox: idbCounts.dispatchOutbox }
      : {}),
  };
  for (const row of collectionRows) {
    counts[row.collection] = row.count;
  }
  return counts;
}

function mirrorConversationWrites(sqlite: SqliteCacheStorage): () => void {
  const origWriteMessages = cacheStorage.writeConversationMessages;
  const origWriteUserMessages = cacheStorage.writeConversationUserMessages;
  (cacheStorage as any).writeConversationMessages = (
    convId: string,
    messages: any[],
    pagination: any,
  ) => {
    origWriteMessages(convId, messages, pagination);
    sqlite.writeConversationMessages(convId, messages, pagination);
  };
  (cacheStorage as any).writeConversationUserMessages = (
    convId: string,
    userMessages: any[],
  ) => {
    origWriteUserMessages(convId, userMessages);
    sqlite.writeConversationUserMessages(convId, userMessages);
  };
  return () => {
    (cacheStorage as any).writeConversationMessages = origWriteMessages;
    (cacheStorage as any).writeConversationUserMessages = origWriteUserMessages;
  };
}

async function measureReplayPersistedRows() {
  const prevEvictionMeta = process.env.VITE_CACHE_EVICTION_METADATA;
  const prevTimedCaps = process.env.VITE_TIMED_DOC_CAPS;
  process.env.VITE_CACHE_EVICTION_METADATA = "0";
  process.env.VITE_TIMED_DOC_CAPS = "0";
  clearProtectedInboxMemory();
  installSignedInPrincipal(TEST_PRINCIPAL);
  await awaitWithin(
    _reopenForTests({ indexedDB: new IDBFactory(), IDBKeyRange }),
    5000,
    "Timed out reopening replay test IndexedDB",
  );
  const sqliteDb = new Database(":memory:");
  const sqlite = createSqliteCache(sqliteDb, authPrincipal);
  const restoreConversationMirror = mirrorConversationWrites(sqlite);
  try {
    await awaitWithin(
      db.meta.put({ key: "currentUser", value: { _id: TEST_PRINCIPAL } }),
      5000,
      "Timed out writing replay currentUser metadata",
    );
    await awaitWithin(
      writeOwnerStamp(TEST_PRINCIPAL, "test-fixture"),
      5000,
      "Timed out writing replay owner stamp",
    );
    const seedState: Record<string, any> = {
      currentUser: { _id: TEST_PRINCIPAL },
    };
    for (const [key, size] of Object.entries(fixtureSizes)) {
      const rows =
        key === "docDetails"
          ? calibratedDocDetailRows(size)
          : retainedRows(key, size);
      seedState[key] = Object.fromEntries(rows.map((row) => [row._id, row]));
    }
    seedState.docs = Object.fromEntries(
      calibratedDocRows(200).map((row) => [row._id, row]),
    );
    await sqlite.loadCache([]);
    sqlite.setHydrating(false);
    cacheStorage.setHydrating(false);
    const seedPatches = Object.keys(seedState)
      .filter((key) => key !== "currentUser")
      .map((key) => ({
        op: "replace" as const,
        path: [key],
        value: seedState[key],
      }));
    sqlite.writePatches(seedPatches, seedState);
    cacheStorage.writePatches(seedPatches, seedState);
    await cacheStorage.flushPersistence();

    await awaitWithin(
      db.pendingEntries.bulkPut(
        Array.from({ length: 400 }, (_, index) => ({
          key: `sessions:${id(index + 1)}:title`,
          value: {
            type: "field" as const,
            value: `Queued ${index + 1}`,
            ts: now,
          },
        })),
      ),
      5000,
      "Timed out seeding replay pendingEntries table",
    );
    const bootKeys = [...Object.keys(fixtureSizes), "docs", "pending"];
    const loaded = await awaitWithin(
      loadCache(bootKeys),
      5000,
      "Timed out hydrating replay cache",
    );
    assert(loaded);
    await sqlite.loadCache(bootKeys, { pending: loaded.pending });
    await awaitWithin(
      db.transaction("r", db.tables, () => db.meta.count()),
      5000,
      "Timed out verifying replay boot read transaction",
    );

    useInboxStore.setState({
      ...Object.fromEntries(allKeys.map((key) => [key, {}])),
      pending: loaded.pending ?? {},
      syncRole: "host",
    } as any);
    state()._setIDBWrite((patches, s) => {
      writePatchesToIDB(patches, s);
      sqlite.writePatches(patches, s);
    });
    state()._setOutbox(enqueueDispatch, removeDispatch, loadOutbox);

    for (const key of Object.keys(fixtureSizes)) {
      if (loaded[key])
        state().syncTable(key, Object.values(loaded[key]), { isDelta: false });
    }
    if (loaded.docs)
      state().syncTable("docs", Object.values(loaded.docs), { isDelta: true });

    state().syncTable("sessions", calibratedSessionRows(20), { isDelta: true });
    state().syncTable("conversations", retainedRows("conversations", 5), {
      isDelta: true,
    });
    state().syncTable(
      "tasks",
      Array.from({ length: 50 }, (_, index) => ({
        _id: `k17${String(index).padStart(29, "0")}`,
        short_id: `ct-${index}`,
        title: `Task ${index}`,
        updated_at: now - index,
        comments: [{ _id: `c-${index}`, text: "heavy comment" }],
      })),
      { isDelta: true },
    );
    state().syncTable(
      "pullRequests",
      Array.from({ length: 20 }, (_, index) => ({
        _id: `pd7${String(index).padStart(29, "0")}`,
        number: 1000 + index,
        title: `PR ${index}`,
        updated_at: now - index,
        files: [{ filename: "a.ts", patch: "diff" }],
        commits: [{ sha: "a".repeat(40), message: "msg" }],
        checks: [{ name: "ci", conclusion: "success" }],
      })),
      { isDelta: true },
    );

    for (let tick = 1; tick <= 10; tick++) {
      const row = state().sessions[id(0)];
      state().syncRecord("sessions", id(0), {
        ...row,
        message_count: tick,
        updated_at: now + tick,
      });
    }

    state().renameSession(id(0), "Replayed rename");
    state().syncRecord("sessions", id(0), {
      ...state().sessions[id(0)],
      title: "Replayed rename",
    });
    state().syncRecord("conversations", id(0), {
      ...state().conversations[id(0)],
      title: "Replayed rename",
    });
    const outbox = await awaitWithin(
      loadOutbox(),
      5000,
      "Timed out loading replay outbox",
    );
    for (const entry of outbox) {
      await awaitWithin(
        removeDispatch(entry.id),
        5000,
        "Timed out draining replay outbox entry",
      );
    }

    for (let conversation = 0; conversation < 4; conversation++) {
      state().setMessages(id(conversation), budgetMessages(conversation), {
        initialized: true,
        hasMoreAbove: false,
      });
      state().setUserMessages(id(conversation), budgetTail().slice(0, 5));
    }
    state().setMessages(id(4), budgetTail().slice(0, 190), {
      initialized: true,
      hasMoreAbove: false,
    });
    state().setUserMessages(id(4), budgetTail().slice(0, 5));
    await cacheStorage.flushPersistence();
    state().setMessages(id(4), budgetMessages(4), {
      initialized: true,
      hasMoreAbove: false,
    });
    const tail = budgetTail();
    state().applyTailMessages(
      id(0),
      199,
      [
        { ...tail[199], content: "Updated" },
        { ...tail[199], _id: "new-message", timestamp: 201 },
      ],
      201,
    );

    state().syncTable("threadUnread", 7);

    await awaitWithin(
      cacheStorage.flushPersistence(),
      5000,
      "Persistence replay flush timed out",
    );
    const tableCounts = await snapshotPersistedCounts(sqliteDb);
    const sortedTables = Object.keys(tableCounts).sort();
    for (const table of sortedTables) {
      const actual = tableCounts[table];
      const expected = REPLAY_TABLE_BASELINES[table] ?? 0;
      const delta = actual - expected;
      const sign = delta > 0 ? `+${delta}` : String(delta);
      console.log(
        `cache ${table}: ${actual} (${sign} vs baseline ${expected})`,
      );
    }
    const totalRows = Object.values(tableCounts).reduce(
      (sum, count) => sum + count,
      0,
    );
    for (const table of sortedTables) {
      const actual = tableCounts[table];
      const expected = REPLAY_TABLE_BASELINES[table] ?? 0;
      const delta = actual - expected;
      const sign = delta > 0 ? `+${delta}` : String(delta);
      assert.equal(
        actual,
        expected,
        `Persisted cache table ${table} row count changed after replay: ${actual} (${sign} vs baseline ${expected})\nIf the growth is intended, update REPLAY_TABLE_BASELINES in apps/web/perf/memory-budgets.ts, apps/web/perf/store-budget-limits.ts, and apps/web/perf/README.md.`,
      );
    }
    checkStoreBudget("Persisted IndexedDB rows after replay", totalRows);
  } finally {
    restoreConversationMirror();
    await cacheStorage.flushPersistence();
    state()._setIDBWrite(null);
    sqliteDb.close();
    db.close();
    if (prevEvictionMeta === undefined)
      delete process.env.VITE_CACHE_EVICTION_METADATA;
    else process.env.VITE_CACHE_EVICTION_METADATA = prevEvictionMeta;
    if (prevTimedCaps === undefined) delete process.env.VITE_TIMED_DOC_CAPS;
    else process.env.VITE_TIMED_DOC_CAPS = prevTimedCaps;
  }
}

async function measureTimedDocReplayCompaction() {
  const prevEvictionMeta = process.env.VITE_CACHE_EVICTION_METADATA;
  const prevTimedCaps = process.env.VITE_TIMED_DOC_CAPS;
  process.env.VITE_CACHE_EVICTION_METADATA = "1";
  process.env.VITE_TIMED_DOC_CAPS = "1";
  const restore = replaceGlobals({
    document: Object.assign(new EventTarget(), { hidden: false }),
  });
  clearProtectedInboxMemory();
  installSignedInPrincipal(TEST_PRINCIPAL);
  await awaitWithin(
    _reopenForTests({ indexedDB: new IDBFactory(), IDBKeyRange }),
    5000,
    "Timed out reopening timed compaction test IndexedDB",
  );
  try {
    await awaitWithin(
      db.meta.put({ key: "currentUser", value: { _id: TEST_PRINCIPAL } }),
      5000,
      "Timed out writing timed compaction currentUser",
    );
    await awaitWithin(
      writeOwnerStamp(TEST_PRINCIPAL, "test-fixture"),
      5000,
      "Timed out writing timed compaction owner stamp",
    );
    const seedDocDetails = Object.fromEntries(
      calibratedDocDetailRows(1200).map((row) => [row._id, row]),
    );
    cacheStorage.setHydrating(false);
    cacheStorage.writePatches(
      [{ op: "replace", path: ["docDetails"], value: seedDocDetails }],
      { currentUser: { _id: TEST_PRINCIPAL }, docDetails: seedDocDetails },
    );
    await cacheStorage.flushPersistence();
    const loaded = await awaitWithin(
      loadCache(["docDetails"]),
      5000,
      "Timed out hydrating timed compaction docDetails",
    );
    assert(loaded?.docDetails);
    useInboxStore.setState({
      ...Object.fromEntries(allKeys.map((key) => [key, {}])),
      pending: {},
      syncRole: "host",
    } as any);
    state()._setIDBWrite(writePatchesToIDB);
    state().syncTable("docDetails", Object.values(loaded.docDetails), {
      isDelta: false,
    });
    await awaitWithin(
      pruneCachedDocDetails(
        () => true,
        () => (docId) => Boolean(state().docDetails[docId]),
      ),
      5000,
      "Timed out compacting docDetails disk cache",
    );
    await awaitWithin(
      cacheStorage.flushPersistence(),
      5000,
      "Timed out settling after timed docDetails compaction",
    );
    const persisted = await awaitWithin(
      cacheStorage.readCachedDocDetails().then((rows) => rows.length),
      5000,
      "Timed out counting compacted docDetails",
    );
    assert.equal(Object.keys(state().docDetails).length, 200);
    assert.equal(
      persisted,
      MAX_DOC_DETAILS_ON_DISK,
      `Timed docDetails disk compaction left ${persisted} rows instead of ${MAX_DOC_DETAILS_ON_DISK}`,
    );
    console.log(
      `pass  Timed docDetails disk compaction: ${persisted} (limit ${MAX_DOC_DETAILS_ON_DISK})`,
    );
  } finally {
    await cacheStorage.flushPersistence();
    state()._setIDBWrite(null);
    db.close();
    restore();
    if (prevEvictionMeta === undefined)
      delete process.env.VITE_CACHE_EVICTION_METADATA;
    else process.env.VITE_CACHE_EVICTION_METADATA = prevEvictionMeta;
    if (prevTimedCaps === undefined) delete process.env.VITE_TIMED_DOC_CAPS;
    else process.env.VITE_TIMED_DOC_CAPS = prevTimedCaps;
  }
}

await measureDesktopWindowCollections();
await measureReplayPersistedRows();
await measureTimedDocReplayCompaction();
