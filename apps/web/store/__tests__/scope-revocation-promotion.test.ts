import {
  installSignedInPrincipal,
  TEST_PRINCIPAL,
} from "./fixtures/signedInPrincipal";
import { afterAll, afterEach, beforeEach, expect, jest, test } from "bun:test";
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

const { authPrincipal } = await import("../../lib/authPrincipal");
const { _reopenForTests, COLLECTION_TABLES, db } =
  await import("../persistence/db");
const { writeOwnerStamp } = await import("../persistence/ownership");
const hydration = await import("../persistence/hydration");
const { resetCollectionWrites } =
  await import("../persistence/collection-writer");

async function waitFor(condition: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 3000;
  while (!(await condition()) && Date.now() < deadline)
    await new Promise<void>((resolve) => setImmediate(resolve));
  expect(await condition()).toBe(true);
}

async function openCache() {
  installSignedInPrincipal();
  authPrincipal.check();
  resetCollectionWrites();
  await _reopenForTests({ indexedDB: new IDBFactory(), IDBKeyRange });
  await db.meta.put({ key: "currentUser", value: { _id: TEST_PRINCIPAL } });
  await writeOwnerStamp(TEST_PRINCIPAL, "confirmed");
}

await openCache();
const { rebootPersistence, useInboxStore } = await import("../inboxStore");
const { replicationLockName } = await import("../storage-transport");
const { startSyncReplication, stopSyncReplication } =
  await import("../sync-replication");
const { sweepRevokedRowsFromDisk } = await import("../scope-revocation-disk");
await waitFor(() => !hydration._hydrating);

const T = "teamalpha";
const revokedDetail = {
  _id: "r".repeat(32),
  workspace: `team:${T}`,
  content: "Revoked team body",
};
const keptDetail = {
  _id: "m".repeat(32),
  workspace: `user:${TEST_PRINCIPAL}`,
  content: "Mine",
};
const memoryTask = { _id: "t".repeat(32), workspace: `team:${T}` };
const cleanups: Array<() => void> = [];

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

async function bootWithRevocation() {
  rebootPersistence();
  await waitFor(() => !hydration._hydrating);
  await COLLECTION_TABLES.docDetails.bulkPut([revokedDetail, keptDetail]);
  useInboxStore.setState({
    scopeRevocations: { [`dir:${T}`]: 5 },
    tasks: { [memoryTask._id]: memoryTask },
  } as any);
}

async function expectRevokedOnDiskAndInMemory() {
  await waitFor(
    async () =>
      (await COLLECTION_TABLES.docDetails.get(revokedDetail._id)) === undefined,
  );
  expect(await COLLECTION_TABLES.docDetails.get(keptDetail._id)).toBeDefined();
  const s = useInboxStore.getState() as any;
  expect(s.syncRole).toBe("host");
  expect(s.scopeSubscriptions.denied[`dir:${T}`]).toBeDefined();
  expect(s.tasks[memoryTask._id]).toBeUndefined();
  expect(s.pending[`tasks:${memoryTask._id}`]).toMatchObject({
    type: "exclude",
  });
}

const status = () =>
  (
    dom.window as Window & { __syncReplication: () => SyncReplicationStatus }
  ).__syncReplication();

beforeEach(async () => {
  useInboxStore.setState(useInboxStore.getInitialState(), true);
  await openCache();
});

afterEach(async () => {
  jest.useRealTimers();
  stopSyncReplication();
  for (const cleanup of cleanups.splice(0)) cleanup();
  await db.transaction("r", db.tables, () => db.meta.count());
});

afterAll(() => {
  db.close();
  closeDomWindow(dom);
  for (const [key, value] of Object.entries(savedGlobals)) {
    if (value === undefined) delete globals[key];
    else globals[key] = value;
  }
});

test("an elected window adopts the revocations it holds and sweeps them from disk", async () => {
  const release = holdHostLock();
  await bootWithRevocation();
  startSyncReplication({ eligible: true, principalId: TEST_PRINCIPAL });
  release();
  await waitFor(() => status().elected);
  await expectRevokedOnDiskAndInMemory();
});

test("a window that falls back to solo adopts the revocations and sweeps them from disk", async () => {
  holdHostLock();
  await bootWithRevocation();
  jest.useFakeTimers();
  startSyncReplication({ eligible: false, principalId: TEST_PRINCIPAL });
  jest.advanceTimersByTime(8001);
  jest.useRealTimers();
  await waitFor(() => useInboxStore.getState().syncRole === "host");
  await expectRevokedOnDiskAndInMemory();
});

test("a revocation sweeps doc details that only exist on disk", async () => {
  const revoked = {
    _id: "d".repeat(32),
    workspace: `team:${T}`,
    content: "x",
  };
  const kept = {
    _id: "k".repeat(32),
    workspace: `user:${TEST_PRINCIPAL}`,
    content: "y",
  };
  await COLLECTION_TABLES.docDetails.bulkPut([revoked, kept]);
  useInboxStore.setState({ scopeRevocations: { [`dir:${T}`]: 5 } } as any);
  const removed = await sweepRevokedRowsFromDisk(new Set([`dir:${T}`]));
  expect(removed).toEqual({ docDetails: [revoked._id] });
  expect(await COLLECTION_TABLES.docDetails.get(revoked._id)).toBeUndefined();
  expect(await COLLECTION_TABLES.docDetails.get(kept._id)).toBeDefined();
});
