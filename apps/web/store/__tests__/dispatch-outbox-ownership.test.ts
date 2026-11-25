import {
  installSignedInPrincipal,
  TEST_PRINCIPAL,
} from "./fixtures/signedInPrincipal";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import {
  makeDispatchBinding,
  type DispatchCallArgs,
} from "../../lib/dispatch-binding";
import { withHostedKick } from "../../lib/hosted-kick";
import {
  _reopenForTests,
  enqueueDispatch,
  loadOutbox,
  removeDispatch,
} from "../idb-cache";
import { action, mutativeMiddleware } from "../mutativeMiddleware";
import { db } from "../persistence/db";

const other = "userB";

beforeEach(async () => {
  installSignedInPrincipal(TEST_PRINCIPAL);
  await _reopenForTests({ indexedDB, IDBKeyRange });
  await db.dispatchOutbox.clear();
  await db.meta.bulkDelete(["cacheOwner", "currentUser"]);
});

afterEach(async () => {
  installSignedInPrincipal(TEST_PRINCIPAL);
  await db.dispatchOutbox.clear();
  await db.meta.bulkDelete(["cacheOwner", "currentUser"]);
});

function makeStore() {
  const persisted = Promise.withResolvers<void>();
  const retired = Promise.withResolvers<void>();
  let state: any;
  state = mutativeMiddleware(
    () => ({ stageExpandLeaf: action(function (_id: string) {}) }),
    { retryDelays: [0], lockManager: null },
  )(
    (next: any) => {
      state = next;
    },
    () => state,
    {},
  );
  state._setOutbox(
    async (entry: Parameters<typeof enqueueDispatch>[0]) => {
      await enqueueDispatch(entry);
      persisted.resolve();
    },
    async (id: string) => {
      await removeDispatch(id);
      retired.resolve();
    },
    loadOutbox,
  );
  return { state, persisted: persisted.promise, retired: retired.promise };
}

test("a journaled write keeps its owner and ID across transport retries and a fresh store", async () => {
  const writes: DispatchCallArgs[] = [];
  const retried = Promise.withResolvers<void>();
  const first = makeStore();
  first.state._setDispatch(
    withHostedKick(
      makeDispatchBinding(async (request) => {
        writes.push(request);
        if (writes.length === 2) retried.resolve();
        throw new Error("Connection lost");
      }),
      async () => {},
    ),
  );
  first.state.stageExpandLeaf("one");
  await first.persisted;
  await retried.promise;
  first.state._clearRuntimeBindings();
  const [parked] = await loadOutbox();
  expect(parked.accountId).toBe(TEST_PRINCIPAL);

  await _reopenForTests({ indexedDB, IDBKeyRange });
  const reloaded = makeStore();
  reloaded.state._setDispatch(
    makeDispatchBinding(async (request) => {
      writes.push(request);
      return null;
    }),
  );
  await reloaded.retired;
  expect(writes).toHaveLength(3);
  expect(writes.map((request) => request.outbox)).toEqual(
    Array.from({ length: 3 }, () => ({
      id: `${parked.ts}:${parked.id}`,
      owner: TEST_PRINCIPAL,
    })),
  );
  expect(await loadOutbox()).toEqual([]);
});

test("a drain sends only rows belonging to the active account", async () => {
  const base = {
    action: "stageExpandLeaf",
    patches: null,
    result: null,
    ts: Date.now(),
  };
  await db.dispatchOutbox.bulkPut([
    { ...base, id: "alice", args: ["alice"], accountId: TEST_PRINCIPAL },
    { ...base, id: "bob", args: ["bob"], accountId: other },
    { ...base, id: "unknown", args: ["unknown"] },
  ]);
  installSignedInPrincipal(other);
  expect((await loadOutbox()).map((entry) => entry.id)).toEqual(["bob"]);
  const drain = makeStore();
  const writes: DispatchCallArgs[] = [];
  drain.state._setDispatch(
    makeDispatchBinding(async (request) => {
      writes.push(request);
      return null;
    }),
  );
  await drain.retired;
  expect(writes.map((request) => request.args)).toEqual([["bob"]]);
  expect((await db.dispatchOutbox.toArray()).map((entry) => entry.id)).toEqual([
    "alice",
    "unknown",
  ]);
});

test("a legacy row keeps its ID and is attributed only to its recorded cache owner", async () => {
  const legacy = {
    id: "legacy",
    action: "patchConversation",
    args: [],
    patches: null,
    result: null,
    ts: Date.now(),
  };
  await db.dispatchOutbox.put(legacy);
  await db.meta.put({ key: "cacheOwner", value: { principal: other } });
  expect(await loadOutbox()).toEqual([]);
  installSignedInPrincipal(other);
  expect(await loadOutbox()).toEqual([{ ...legacy, accountId: other }]);
  expect(await db.dispatchOutbox.get(legacy.id)).toEqual({
    ...legacy,
    accountId: other,
  });
});

test("an older validator triggers one fallback and an account change stops that fallback", async () => {
  const meta = {
    locks: [],
    outbox: {
      id: "legacy-validator",
      queuedAt: Date.now(),
      accountId: TEST_PRINCIPAL,
    },
  };
  const writes: DispatchCallArgs[] = [];
  const oldServer = makeDispatchBinding(async (request) => {
    writes.push(request);
    if (request.outbox)
      throw new Error(
        "ArgumentValidationError: Object contains extra field `outbox`",
      );
    return "accepted";
  });
  expect(
    await oldServer(
      "stageExpandLeaf",
      [],
      undefined,
      undefined,
      undefined,
      meta,
    ),
  ).toBe("accepted");
  expect(writes.map((request) => !!request.outbox)).toEqual([true, false]);

  const crossingAccounts = makeDispatchBinding(async (request) => {
    writes.push(request);
    if (request.outbox) {
      installSignedInPrincipal(other);
      throw new Error(
        "ArgumentValidationError: Object contains extra field `outbox`",
      );
    }
    return "wrong account";
  });
  await expect(
    crossingAccounts(
      "stageExpandLeaf",
      [],
      undefined,
      undefined,
      undefined,
      meta,
    ),
  ).rejects.toThrow("Dispatch binding changed");
  expect(writes.map((request) => !!request.outbox)).toEqual([
    true,
    false,
    true,
  ]);
});
