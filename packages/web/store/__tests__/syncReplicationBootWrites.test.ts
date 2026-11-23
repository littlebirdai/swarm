// Run with `bun test --isolate`: this file installs its own JSDOM window, and a store
// module loaded earlier in the same process keeps its pagehide flush on another window.
import { TEST_PRINCIPAL } from "./fixtures/signedInPrincipal";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { createReplicationHost } from "@platform/engine";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { JSDOM } from "jsdom";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import type { SyncReplicationStatus } from "../syncReplication";

const dom = new JSDOM("", { url: "https://example.test/" });
const globals = globalThis as Record<string, unknown>;
const savedGlobals = { window: globals.window, document: globals.document, navigator: globals.navigator };
globals.window = dom.window;
globals.document = dom.window.document;

const { _reopenForTests, COLLECTION_TABLES, db } = await import("../persistence/db");
const { writeOwnerStamp } = await import("../persistence/ownership");
const hydration = await import("../persistence/hydration");
const { resetCollectionWrites } = await import("../persistence/collectionWriter");
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
            const keys = request.type === "put" || request.type === "add"
              ? request.values.map((value) => table.schema.primaryKey.extractKey(value))
              : request.type === "delete" ? request.keys : [];
            // An outbox entry journals a dispatch separately from the state cache.
            if (name !== "dispatchOutbox") mutations?.push({ table: name, type: request.type, keys });
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
const { replicationChannelName, replicationLockName, replicationTransport, startSyncReplication, stopSyncReplication } = await import("../syncReplication");
await waitFor(() => !hydration._hydrating);

const state = () => useInboxStore.getState();
const sessionId = (n: number) => `k${String(n).padStart(31, "0")}`;
const cachedSessions = () => Array.from({ length: 10 }, (_, i) => ({
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
  const held = new Promise<void>((resolve) => { release = resolve; });
  globals.navigator = {
    locks: {
      async request(requestedName: string, { signal }: { signal: AbortSignal }, grant: () => Promise<void>) {
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

test("a joining follower applies the host snapshot without writing to IndexedDB", async () => {
  holdHostLock();
  const rows = cachedSessions();
  await sessions.bulkPut(rows);
  await bootCache();
  const hostRows = [{ ...rows[0], title: "From the host" }, ...rows.slice(1)];
  const transport = replicationTransport(replicationChannelName(TEST_PRINCIPAL), "previous-host");
  const host = createReplicationHost({
    hostId: "previous-host",
    channel: transport.channel,
    getState: () => ({ sessions: Object.fromEntries(hostRows.map((row) => [row._id, row])) }),
    replicatedKeys: ["sessions"],
    isCollectionKey: () => true,
    applyUpdates: () => {},
  });
  cleanups.push(() => { host.stop(); transport.close(); });

  mutations = [];
  startSyncReplication({ eligible: true, principalId: TEST_PRINCIPAL });
  // Feeders can still answer while the new window is waiting for its role.
  state().syncTable("sessions", [{ ...rows[0], title: "Early feeder result" }], { isDelta: true });
  const early = { _id: "early-message", role: "user" as const, timestamp: Date.now(), content: "During election" };
  state().setMessages("election-conversation", [early]);
  await waitFor(() => state().syncRole === "follower");
  expect(state().sessions[rows[0]._id]?.title).toBe("From the host");
  state().syncTable("sessions", [{ ...rows[1], title: "Late feeder result" }], { isDelta: true });
  expect(state().sessions[rows[1]._id]?.title).toBe("Late feeder result");
  const message = { _id: "follower-message", role: "user" as const, timestamp: Date.now(), content: "Only in this window" };
  state().setMessages("follower-conversation", [message]);
  state().setUserMessages("follower-conversation", [message]);
  expect(state().messages["follower-conversation"]).toEqual([message]);
  await drainWrites();

  expect(mutations).toEqual([]);
  expect(await sessions.toArray()).toEqual(rows);
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
  const getStatus = (dom.window as Window & { __syncReplication?: () => SyncReplicationStatus }).__syncReplication;
  await waitFor(() => getStatus?.().holdsLock === true);
  await drainWrites();

  expect(mutations).toEqual([{ table: "sessions", type: "put", keys: [changed._id] }]);
  expect(await conversations.toArray()).toEqual(rows);
  expect(await sessions.toArray()).toEqual([changed, ...rows.slice(1)]);

  // The elected host keeps writing through: a later change reaches disk as one row.
  mutations = [];
  const later = { ...rows[1], title: "Written by the new host" };
  state().syncTable("sessions", [later], { isDelta: true });
  await drainWrites();
  expect(mutations).toEqual([{ table: "sessions", type: "put", keys: [later._id] }]);
});

test("boot hydration writes only documented row trims and retention drops", async () => {
  const [fresh] = cachedSessions();
  const expired = { _id: sessionId(1), updated_at: Date.now() - 365 * 86_400_000 };
  const thinDoc = { _id: "doc-1", title: "Cached document" };
  await sessions.bulkPut([fresh, expired]);
  await docs.put({ ...thinDoc, content: "Legacy inline body" });
  await db.meta.put({ key: "clientState", value: { ui: { sidebar_collapsed: true } } });
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
