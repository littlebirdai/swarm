// Run with `bun test --isolate`: this file installs its own JSDOM window, and a store
// module loaded earlier in the same process keeps its pagehide flush on another window.
import { TEST_PRINCIPAL } from "./fixtures/signedInPrincipal";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import {
  createReplicationFollower,
  createReplicationHost,
  type ReplicationUpdate,
} from "@platform/engine";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { JSDOM } from "jsdom";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import type { SyncReplicationStatus } from "../sync-replication";

const dom = new JSDOM("", { url: "https://example.test/" });
const globals = globalThis as Record<string, unknown>;
const savedGlobals = {
  window: globals.window,
  document: globals.document,
  navigator: globals.navigator,
};
globals.window = dom.window;
globals.document = dom.window.document;

const { _reopenForTests, COLLECTION_TABLES, db } =
  await import("../persistence/db");
const { writeOwnerStamp } = await import("../persistence/ownership");
const hydration = await import("../persistence/hydration");
const { resetCollectionWrites } =
  await import("../persistence/collection-writer");
const { conversations, sessions, docs } = COLLECTION_TABLES;

type Mutation = { table: string; type: string; keys: unknown[] };
let mutations: Mutation[] | undefined;

// Observe actual table mutations, including redundant puts whose values would
// make the final contents of the database look identical.
db.use({
  stack: "dbcore",
  create(core) {
    return {
      ...core,
      table(name) {
        const table = core.table(name);
        return {
          ...table,
          mutate(request) {
            const keys =
              request.type === "put" || request.type === "add"
                ? request.values.map((value) =>
                    table.schema.primaryKey.extractKey(value),
                  )
                : request.type === "delete"
                  ? request.keys
                  : [];
            // An outbox entry journals a dispatch separately from the state cache.
            if (name !== "dispatchOutbox")
              mutations?.push({ table: name, type: request.type, keys });
            return table.mutate(request);
          },
        };
      },
    };
  },
});

async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!condition() && Date.now() < deadline) await Bun.sleep(1);
  expect(condition()).toBe(true);
}

async function openCache() {
  resetCollectionWrites();
  await _reopenForTests({ indexedDB: new IDBFactory(), IDBKeyRange });
  await db.meta.put({ key: "currentUser", value: { _id: TEST_PRINCIPAL } });
  await writeOwnerStamp(TEST_PRINCIPAL, "confirmed");
}

await openCache();
const { rebootPersistence, useInboxStore } = await import("../inboxStore");
const { replicationChannelName, replicationLockName, replicationTransport } =
  await import("../storage-transport");
const { startSyncReplication, stopSyncReplication } =
  await import("../sync-replication");
await waitFor(() => !hydration._hydrating);

const state = () => useInboxStore.getState();
const sessionId = (n: number) => `k${String(n).padStart(31, "0")}`;
const cachedSessions = () =>
  Array.from({ length: 10 }, (_, i) => ({
    _id: sessionId(i),
    title: `Cached session ${i}`,
    updated_at: Date.now(),
  }));

async function bootCache() {
  rebootPersistence();
  await waitFor(() => !hydration._hydrating);
}

async function drainWrites() {
  // Page hide flushes deferred metadata and liveness writes. A read transaction
  // across the cache waits behind the write transactions already queued.
  dom.window.dispatchEvent(new dom.window.Event("pagehide"));
  await db.transaction("r", db.tables, () => db.meta.count());
}

function holdHostLock() {
  const name = replicationLockName(TEST_PRINCIPAL);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  globals.navigator = {
    locks: {
      async request(
        requestedName: string,
        { signal }: { signal: AbortSignal },
        grant: () => Promise<void>,
      ) {
        expect(requestedName).toBe(name);
        await held;
        if (!signal.aborted) await grant();
      },
    },
  };
  cleanups.push(release);
  return release;
}

const cleanups: Array<() => void> = [];

beforeEach(async () => {
  useInboxStore.setState(useInboxStore.getInitialState(), true);
  await openCache();
});

afterEach(async () => {
  stopSyncReplication();
  for (const cleanup of cleanups.splice(0)) cleanup();
  await drainWrites();
  mutations = undefined;
});

afterAll(() => {
  db.close();
  closeDomWindow(dom);
  for (const [key, value] of Object.entries(savedGlobals)) {
    if (value === undefined) delete globals[key];
    else globals[key] = value;
  }
});

function connectHost(hostRows: ReturnType<typeof cachedSessions>) {
  const transport = replicationTransport(
    replicationChannelName(TEST_PRINCIPAL),
    "previous-host",
  );
  const host = createReplicationHost({
    hostId: "previous-host",
    channel: transport.channel,
    getState: () => ({
      sessions: Object.fromEntries(hostRows.map((row) => [row._id, row])),
    }),
    replicatedKeys: ["sessions"],
    isCollectionKey: () => true,
    applyUpdates: () => {},
  });
  cleanups.push(() => {
    host.stop();
    transport.close();
  });
}

test("a joining follower applies the host snapshot without writing to IndexedDB", async () => {
  holdHostLock();
  const rows = cachedSessions();
  await sessions.bulkPut(rows);
  await bootCache();
  const hostRows = [{ ...rows[0], title: "From the host" }, ...rows.slice(1)];
  connectHost(hostRows);

  mutations = [];
  startSyncReplication({ eligible: true, principalId: TEST_PRINCIPAL });
  // Feeders can still answer while the new window is waiting for its role.
  state().syncTable(
    "sessions",
    [{ ...rows[0], title: "Early feeder result" }],
    { isDelta: true },
  );
  await waitFor(() => state().syncRole === "follower");
  expect(state().sessions[rows[0]._id]?.title).toBe("From the host");
  state().syncTable("sessions", [{ ...rows[1], title: "Late feeder result" }], {
    isDelta: true,
  });
  expect(state().sessions[rows[1]._id]?.title).toBe("Late feeder result");
  await drainWrites();

  expect(mutations).toEqual([]);
  expect(await sessions.toArray()).toEqual(rows);
});

test("a follower caches the transcript and navigator for a conversation only it opened", async () => {
  holdHostLock();
  await bootCache();
  connectHost([]);
  startSyncReplication({ eligible: true, principalId: TEST_PRINCIPAL });
  await waitFor(() => state().syncRole === "follower");

  const id = "follower-conversation";
  const message = {
    _id: "follower-message",
    role: "user" as const,
    timestamp: Date.now(),
    content: "Only in this window",
  };
  state().setMessages(id, [message]);
  state().setUserMessages(id, [message]);
  await drainWrites();

  expect(state().syncRole).toBe("follower");
  expect(
    (await db.conversationMessageRows.where("convId").equals(id).first())
      ?.message,
  ).toEqual(message);
  expect((await db.conversationUserMessages.get(id))?.userMessages).toEqual([
    message,
  ]);
});

test("a window elected when the previous host closes persists only changed rows", async () => {
  const closePreviousHost = holdHostLock();
  const rows = cachedSessions();
  await sessions.bulkPut(rows);
  await conversations.bulkPut(rows);
  await bootCache();

  mutations = [];
  startSyncReplication({ eligible: true, principalId: TEST_PRINCIPAL });
  const changed = { ...rows[0], title: "Updated during the election" };
  state().syncTable("sessions", [changed], { isDelta: true });
  expect(state().sessions[changed._id]?.title).toBe(changed.title);
  await drainWrites();
  expect(mutations).toEqual([]);

  // The lock holder leaves before it can answer the joining window's hello.
  closePreviousHost();
  const getStatus = (
    dom.window as Window & { __syncReplication?: () => SyncReplicationStatus }
  ).__syncReplication;
  await waitFor(() => getStatus?.().holdsLock === true);
  await drainWrites();

  expect(mutations).toEqual([
    { table: "sessions", type: "put", keys: [changed._id] },
  ]);
  expect(await conversations.toArray()).toEqual(rows);
  expect(await sessions.toArray()).toEqual([changed, ...rows.slice(1)]);

  // The elected host keeps writing through: a later change reaches disk as one row.
  mutations = [];
  const later = { ...rows[1], title: "Written by the new host" };
  state().syncTable("sessions", [later], { isDelta: true });
  await drainWrites();
  expect(mutations).toEqual([
    { table: "sessions", type: "put", keys: [later._id] },
  ]);
});

test("boot hydration writes only documented row trims and retention drops", async () => {
  const [fresh] = cachedSessions();
  const expired = {
    _id: sessionId(1),
    updated_at: Date.now() - 365 * 86_400_000,
  };
  const thinDoc = { _id: "doc-1", title: "Cached document" };
  await sessions.bulkPut([fresh, expired]);
  await docs.put({ ...thinDoc, content: "Legacy inline body" });
  await db.meta.put({
    key: "clientState",
    value: { ui: { sidebar_collapsed: true } },
  });
  // If the live user settings arrive first, hydration fills missing settings
  // through the normal update action, which would ordinarily persist.
  useInboxStore.setState({ clientStateInitialized: true });

  mutations = [];
  await bootCache();
  await drainWrites();

  expect(state().clientState.ui?.sidebar_collapsed).toBe(true);
  expect(state().sessions[fresh._id]).toEqual(fresh);
  expect(state().sessions[expired._id]).toBeUndefined();
  expect(state().docs[thinDoc._id]).toEqual(thinDoc);
  expect(mutations).toEqual([
    { table: "sessions", type: "delete", keys: [expired._id] },
    { table: "docs", type: "put", keys: [thinDoc._id] },
  ]);
  expect(await sessions.toArray()).toEqual([fresh]);
  expect(await docs.toArray()).toEqual([thinDoc]);
});

test.each(["access", "archive", "crawl"] as const)(
  "the elected host deletes a disk-only detail after a follower reports %s",
  async (cause) => {
    const original = process.env.VITE_CACHE_EVICTION_METADATA;
    process.env.VITE_CACHE_EVICTION_METADATA = "1";
    const { createDetailInvalidationTransport } =
      await import("../detail-invalidation-transport");
    const { resetDetailInvalidations } = await import("../doc-detail-cache");
    resetDetailInvalidations();
    const release = holdHostLock();
    await bootCache();
    const row = {
      _id: "a".repeat(32),
      workspace: "team:alpha",
      content: "Body on disk only",
    };
    await COLLECTION_TABLES.docDetails.put(row);
    startSyncReplication({
      eligible: true,
      principalId: TEST_PRINCIPAL,
      detailAuthority: {
        async detail() {
          return cause === "archive" ? { ...row, archived_at: 1 } : null;
        },
        async page(workspace) {
          expect(workspace).toBe(row.workspace);
          return { page: [], isDone: true, continueCursor: "" };
        },
      },
    });
    release();
    await waitFor(() => (dom.window as any).__syncReplication?.().holdsLock);
    const transport = replicationTransport(
      replicationChannelName(TEST_PRINCIPAL),
      "requesting-follower",
    );
    const received = Promise.withResolvers<string[] | undefined>();
    const protocol = createDetailInvalidationTransport({
      selfId: "requesting-follower",
      channel: transport.channel,
      host: () => null,
      current: () => true,
      async verify() {
        return [];
      },
      async deleteDetails() {
        return [];
      },
      apply(ids) {
        received.resolve(ids);
      },
    });
    const follower = createReplicationFollower({
      selfId: "requesting-follower",
      channel: protocol.channel,
      replicatedKeys: ["docDetails"],
      isCollectionKey: () => true,
      onPosition: protocol.onPosition,
      onSnapshot: protocol.onSnapshot,
      applyUpdates(updates: ReplicationUpdate[], origin) {
        for (const update of updates)
          if (update.kind === "authoritativeRemoval" && update.ids)
            protocol.applyRemoval(update.ids, origin);
      },
    });
    try {
      await waitFor(() => follower.synced());
      expect(state().docDetails[row._id]).toBeUndefined();
      expect(await COLLECTION_TABLES.docDetails.get(row._id)).toEqual(row);
      protocol.report({
        ids: [row._id],
        cause,
        ...(cause === "crawl" ? { workspace: row.workspace } : {}),
      });
      expect(await received.promise).toEqual([row._id]);
      expect(await COLLECTION_TABLES.docDetails.get(row._id)).toBeUndefined();
    } finally {
      follower.stop();
      transport.close();
      stopSyncReplication();
      if (original === undefined)
        delete process.env.VITE_CACHE_EVICTION_METADATA;
      else process.env.VITE_CACHE_EVICTION_METADATA = original;
      resetDetailInvalidations();
    }
  },
);

test("the complete crawl compares disk-only details by workspace", async () => {
  const flag = "VITE_CACHE_EVICTION_METADATA";
  const original = process.env[flag];
  process.env[flag] = "1";
  const {
    detailReadPosition,
    setDetailInvalidationReporter,
    resetDetailInvalidations,
  } = await import("../doc-detail-cache");
  const { collectCompleteDocCrawlAbsences } =
    await import("../doc-detail-authority");
  const here = {
    _id: "a".repeat(32),
    workspace: "team:alpha",
    content: "Missing",
  };
  const elsewhere = { ...here, _id: "b".repeat(32), workspace: "team:beta" };
  const live = { ...here, _id: "c".repeat(32), content: "Current" };
  await bootCache();
  await COLLECTION_TABLES.docDetails.bulkPut([here, elsewhere, live]);
  const reported: unknown[] = [];
  setDetailInvalidationReporter((evidence) => {
    reported.push(evidence);
    return true;
  });
  try {
    expect(state().docDetails[here._id]).toBeUndefined();
    expect(state().docs[here._id]).toBeUndefined();
    await collectCompleteDocCrawlAbsences(
      here.workspace,
      new Set([live._id]),
      detailReadPosition(),
    );
    expect(reported).toEqual([
      { ids: [here._id], cause: "crawl", workspace: here.workspace },
    ]);
  } finally {
    resetDetailInvalidations();
    if (original === undefined) delete process.env[flag];
    else process.env[flag] = original;
  }
});

test("a thin row disappearing during the disk transaction does not cancel a verified deletion", async () => {
  const { persistDetailInvalidation } = await import("../doc-detail-authority");
  const doc = {
    _id: "s".repeat(32),
    title: "Removed during write",
    content: "cached",
  };
  await bootCache();
  await COLLECTION_TABLES.docDetails.put(doc);
  state().syncRecord("docs", doc._id, doc);
  const removal = persistDetailInvalidation([doc._id], () => true);
  state().dropRows("docs", [doc._id]);
  expect(await removal).toEqual([doc._id]);
  expect(await COLLECTION_TABLES.docDetails.get(doc._id)).toBeUndefined();
});
