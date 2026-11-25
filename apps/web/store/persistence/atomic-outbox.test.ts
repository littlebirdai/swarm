import {
  installSignedInPrincipal,
  TEST_PRINCIPAL,
} from "../__tests__/fixtures/signedInPrincipal";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { authPrincipal } from "../../lib/authPrincipal";
import { makeRng } from "@codecast/inbox/__fixtures__/inboxProjectionGen";
import type { OutboxEntry, PendingEntry } from "@platform/engine";
import { action, mutativeMiddleware, sync } from "../mutativeMiddleware";
import { replicationPersistence } from "../storage-transport";
import { setHydrating } from "./hydration";
import { persistenceOwned, ensureCacheOwnership } from "./ownership";
import { resetCollectionWrites, writePatchesToIDB } from "./collection-writer";
import { _reopenForTests, db } from "./db";
import { enqueueDispatch, loadOutbox, removeDispatch } from "./outbox";

const conversationId = "j".padEnd(32, "0");
const lockKey = `conversations:${conversationId}:title`;
let indexedDB: IDBFactory;

beforeEach(async () => {
  installSignedInPrincipal(TEST_PRINCIPAL);
  authPrincipal.check();
  indexedDB = new IDBFactory();
  await _reopenForTests({ indexedDB, IDBKeyRange });
});

afterEach(() => {
  installSignedInPrincipal(TEST_PRINCIPAL);
  authPrincipal.check();
  setHydrating(false);
  db.close();
});

function rename(
  title = "After",
  beforeEnqueue?: () => void,
  writer: "host" | "follower" | "boot" = "host",
) {
  let state: any;
  state = mutativeMiddleware(
    () => ({
      pending: {},
      conversations: { [conversationId]: { title: "Before" } },
      retireTitle: sync(function (this: any) {
        delete this.pending[lockKey];
      }),
      renameSession: action(function (this: any, title: string) {
        this.conversations[conversationId].title = title;
      }),
    }),
    { lockManager: null },
  )(
    (next: any) => {
      state = next;
    },
    () => state,
    {},
  );
  const persistence = replicationPersistence(() => state);
  const write =
    writer === "host"
      ? writePatchesToIDB
      : writer === "follower"
        ? persistence.followerWrite
        : persistence.bootWrite;
  state._setIDBWrite((...args: Parameters<typeof writePatchesToIDB>) => {
    write(...args);
    beforeEnqueue?.();
  });
  state._setOutbox(enqueueDispatch, removeDispatch, loadOutbox);
  state.renameSession(title);
  return () => state;
}

async function readCommitted() {
  await db.transaction("r", db.meta, db.dispatchOutbox, () => db.meta.count());
  await _reopenForTests({ indexedDB, IDBKeyRange });
  return Promise.all([db.meta.get("pending"), db.dispatchOutbox.toArray()]);
}

test("reopening after a rename restores the same lock as the outbox row", async () => {
  rename();
  const [pending, rows] = await readCommitted();
  expect(rows).toHaveLength(1);
  expect(rows[0].accountId).toBe(TEST_PRINCIPAL);
  const lock = rows[0].locks?.find((entry) => entry.key === lockKey);
  expect(lock).toMatchObject({ value: "After", lock: expect.any(String) });
  expect(pending?.value[lockKey]).toMatchObject({
    value: "After",
    lock: lock?.lock,
  });
});

test("reopening after an interruption between writes finds neither half", async () => {
  const interrupt = () => {
    throw new Error("Interrupted outbox write");
  };
  db.dispatchOutbox.hook("creating", interrupt);
  try {
    rename();
    const [pending, rows] = await readCommitted();
    expect(rows).toEqual([]);
    expect(pending).toBeUndefined();
  } finally {
    db.dispatchOutbox.hook("creating").unsubscribe(interrupt);
  }
});

test("a rename from the outgoing account saves neither half after a switch", async () => {
  rename("After", () => {
    installSignedInPrincipal("successor");
    authPrincipal.check();
  });
  const [pending, rows] = await readCommitted();
  expect(rows).toEqual([]);
  expect(pending).toBeUndefined();
});

test("the transaction refuses a changed token before the account event arrives", async () => {
  rename("After", () => installSignedInPrincipal("successor"));
  const [pending, rows] = await readCommitted();
  expect(rows).toEqual([]);
  expect(pending).toBeUndefined();
});

test("retrying an earlier outbox write leaves a later lock in place", async () => {
  const timedOut = Promise.withResolvers<void>();
  const retried = Promise.withResolvers<void>();
  let firstAttempt = true;
  const interrupt = (_id: string, entry: OutboxEntry) => {
    if (entry.args[0] !== "First") return;
    if (firstAttempt) {
      firstAttempt = false;
      timedOut.resolve();
      throw new DOMException("Interrupted outbox write", "TimeoutError");
    }
    retried.resolve();
  };
  db.dispatchOutbox.hook("creating", interrupt);
  try {
    rename("First");
    await timedOut.promise;
    rename("Later");
    await retried.promise;
    const [pending, rows] = await readCommitted();
    expect(rows.map((row) => row.args[0]).sort()).toEqual(["First", "Later"]);
    expect(pending?.value[lockKey].value).toBe("Later");
  } finally {
    db.dispatchOutbox.hook("creating").unsubscribe(interrupt);
  }
});

test.each(["follower", "boot", "hydrating"] as const)(
  "%s pairs its lock without overwriting another window's pending lock",
  async (mode) => {
    const other = { type: "include", ts: 1 };
    await db.meta.put({ key: "pending", value: { other } });
    setHydrating(mode === "hydrating");
    rename("After", undefined, mode === "hydrating" ? "host" : mode);
    const [pending, rows] = await readCommitted();
    expect(rows).toHaveLength(1);
    expect(pending?.value.other).toEqual(other);
    expect(pending?.value[lockKey].lock).toBe(rows[0].locks?.[0].lock);
  },
);

test("a retry still persists its lock after a later transaction aborts", async () => {
  const firstFailed = Promise.withResolvers<void>();
  const laterFailed = Promise.withResolvers<void>();
  const retried = Promise.withResolvers<void>();
  let firstAttempt = true;
  const interrupt = (_id: string, entry: OutboxEntry) => {
    if (entry.args[0] === "Later") {
      laterFailed.resolve();
      throw new Error("Later write failed");
    }
    if (firstAttempt) {
      firstAttempt = false;
      firstFailed.resolve();
      throw new DOMException("Interrupted outbox write", "TimeoutError");
    }
    retried.resolve();
  };
  db.dispatchOutbox.hook("creating", interrupt);
  try {
    rename("First");
    await firstFailed.promise;
    rename("Later");
    await laterFailed.promise;
    await retried.promise;
    const [pending, rows] = await readCommitted();
    expect(rows.map((row) => row.args[0])).toEqual(["First"]);
    expect(pending?.value[lockKey].lock).toBe(rows[0].locks?.[0].lock);
  } finally {
    db.dispatchOutbox.hook("creating").unsubscribe(interrupt);
  }
});

const bareEntry = (): OutboxEntry => ({
  id: "bare",
  action: "actionWithoutLocks",
  accountId: TEST_PRINCIPAL,
  args: [],
  patches: undefined,
  result: undefined,
  ts: 1,
});

test("an outbox-only write checks the token when its transaction runs", async () => {
  const writing = enqueueDispatch(bareEntry());
  installSignedInPrincipal("successor");
  await writing;
  expect(await db.dispatchOutbox.toArray()).toEqual([]);
});

test.each(["cache reset", "token switch"] as const)(
  "%s cancels a retry before either row commits",
  async (boundary) => {
    const interrupt = () => {
      if (boundary === "cache reset") resetCollectionWrites();
      else installSignedInPrincipal("successor");
      db.dispatchOutbox.hook("creating").unsubscribe(interrupt);
      throw new DOMException("Interrupted outbox write", "TimeoutError");
    };
    db.dispatchOutbox.hook("creating", interrupt);
    await enqueueDispatch.withPending(bareEntry(), [
      {
        key: lockKey,
        before: undefined,
        after: { type: "field", value: "After" },
      },
    ]);
    const [pending, rows] = await readCommitted();
    expect(rows).toEqual([]);
    expect(pending).toBeUndefined();
  },
);

test("a window bound to a different cache owner commits neither half", async () => {
  await db.meta.put({ key: "currentUser", value: { _id: TEST_PRINCIPAL } });
  await ensureCacheOwnership(async () => {});
  installSignedInPrincipal("successor");
  authPrincipal.check();
  expect(authPrincipal.current()).toBe("successor");
  expect(persistenceOwned()).toBe(false);
  try {
    await enqueueDispatch.withPending(
      { ...bareEntry(), accountId: "successor" },
      [
        {
          key: lockKey,
          before: undefined,
          after: { type: "field", value: "After" },
        },
      ],
    );
    const [pending, rows] = await readCommitted();
    expect(rows).toEqual([]);
    expect(pending).toBeUndefined();
  } finally {
    installSignedInPrincipal(TEST_PRINCIPAL);
    authPrincipal.check();
    await ensureCacheOwnership(async () => {});
  }
});

test("an echo before a retry cannot leave a retired lock on disk", async () => {
  const timedOut = Promise.withResolvers<void>();
  const retried = Promise.withResolvers<void>();
  let first = true;
  const interrupt = () => {
    if (first) {
      first = false;
      timedOut.resolve();
      throw new DOMException("Interrupted outbox write", "TimeoutError");
    }
    retried.resolve();
  };
  db.dispatchOutbox.hook("creating", interrupt);
  try {
    const state = rename("After", undefined, "follower");
    await timedOut.promise;
    state().retireTitle();
    await retried.promise;
    const [, rows] = await readCommitted();
    expect(rows).toHaveLength(1);
    expect(rows[0].locks ?? []).toEqual([]);
    await removeDispatch(rows[0].id);
    expect((await db.meta.get("pending"))?.value[lockKey]).toBeUndefined();
  } finally {
    db.dispatchOutbox.hook("creating").unsubscribe(interrupt);
  }
});

test("a sync retirement deletes just its own lock and never writes pending action locks from memory", async () => {
  const retired = {
    type: "field",
    ts: 1,
    value: "one",
    lock: "retired",
  } as const;
  const sibling = { type: "field", ts: 2, value: "two", lock: "sibling" };
  const optimistic = {
    type: "field",
    ts: 3,
    value: "three",
    lock: "uncommitted",
  };
  await db.meta.put({ key: "pending", value: { [lockKey]: retired, sibling } });
  await writePatchesToIDB(
    [{ op: "replace", path: ["pending"], value: { optimistic } }],
    { pending: { optimistic } },
    [{ key: lockKey, before: retired, after: undefined }],
  );
  const [pending] = await readCommitted();
  expect(pending?.value).toEqual({ sibling });
});

test("an action can replace its known predecessor despite a lower timestamp", async () => {
  const before = { type: "field", ts: 3, value: "old", lock: "old" } as const;
  const after = { type: "field", ts: 2, value: "new", lock: "new" } as const;
  await db.meta.put({ key: "pending", value: { [lockKey]: before } });
  await enqueueDispatch.withPending(bareEntry(), [
    { key: lockKey, before, after },
  ]);
  const [pending] = await readCommitted();
  expect(pending?.value[lockKey]).toEqual(after);
});

type ModelWrite = {
  entry: OutboxEntry;
  key: string;
  lock: PendingEntry;
  status: "staged" | "failed" | "committed" | "retired";
};

test("two windows agree on durable pending locks after interrupted writes, echoes, rollbacks and resets", async () => {
  const seedCount = Number(process.env.PENDING_LOCK_MODEL_SEEDS ?? 12);
  for (let seed = 1; seed <= seedCount; seed++) {
    const random = makeRng(seed);
    const replica = replicationPersistence(() => ({}));
    const windows: Array<ModelWrite | undefined> = [undefined, undefined];
    const reset = async () => {
      resetCollectionWrites();
      await db.transaction("rw", db.meta, db.dispatchOutbox, async () => {
        await db.meta.delete("pending");
        await db.dispatchOutbox.clear();
      });
      windows.fill(undefined);
    };
    const commit = async (write: ModelWrite) => {
      await enqueueDispatch.withPending(write.entry, [
        { key: write.key, before: undefined, after: write.lock },
      ]);
    };
    try {
      await reset();
      for (let step = 0; step < 18; step++) {
        const window = Math.floor(random() * 2);
        const choice = random();
        const write = windows[window];
        if (choice < 0.06) {
          await reset();
        } else if (!write) {
          const key = `conversations:${window}:title`;
          const id = `${seed}:${step}`;
          const lock = {
            type: "field",
            ts: step,
            value: id,
            lock: id,
          } as const;
          windows[window] = {
            key,
            lock,
            entry: {
              ...bareEntry(),
              id,
              locks: [
                {
                  key,
                  storeKey: "conversations",
                  recordId: String(window),
                  field: "title",
                  ts: step,
                  value: id,
                  prior: null,
                  hadPrior: false,
                  lock: id,
                },
              ],
            },
            status: "staged",
          };
        } else if (write.status === "retired") {
          await commit(write);
          await removeDispatch(write.entry.id);
          windows[window] = undefined;
        } else if (choice < 0.46) {
          const prior = write.status;
          const after = choice < 0.24 ? undefined : write.lock;
          const persist =
            choice < 0.12 ? replica.followerWrite : writePatchesToIDB;
          await persist(
            [{ op: "replace", path: ["pending"], value: {} }],
            { pending: {} },
            after
              ? [{ key: write.key, before: undefined, after }]
              : [{ key: write.key, before: write.lock, after: undefined }],
          );
          if (!after) {
            if (prior === "committed") {
              await removeDispatch(write.entry.id);
              windows[window] = undefined;
            } else write.status = "retired";
          }
        } else if (write.status === "staged" && choice < 0.76) {
          write.status = "failed";
        } else if (write.status !== "committed") {
          await commit(write);
          write.status = "committed";
        }

        const [pending, rows] = await Promise.all([
          db.meta.get("pending"),
          db.dispatchOutbox.toArray(),
        ]);
        const committed = windows.filter(
          (entry) => entry?.status === "committed",
        );
        expect(rows.map((row) => row.id).sort()).toEqual(
          committed.map((entry) => entry!.entry.id).sort(),
        );
        const expected = Object.fromEntries(
          committed.map((entry) => [entry!.key, entry!.lock]),
        );
        expect(pending?.value ?? {}).toEqual(expected);
        for (const entry of rows) {
          for (const lock of entry.locks ?? [])
            expect(pending?.value[lock.key]?.lock).toBe(lock.lock);
        }
      }
    } catch (error) {
      throw new Error(`Pending lock model failed at seed ${seed}`, {
        cause: error,
      });
    }
  }
}, 120_000);

test.each([true, false])(
  "a refusal restores an older lock only when its outbox row committed (%s)",
  async (committed) => {
    const older = {
      type: "field",
      ts: 1,
      value: "earlier",
      lock: "older",
    } as const;
    const refused = {
      type: "field",
      ts: 2,
      value: "refused",
      lock: "refused",
    } as const;
    if (committed) {
      await db.dispatchOutbox.put({
        ...bareEntry(),
        locks: [
          {
            key: lockKey,
            storeKey: "conversations",
            recordId: conversationId,
            field: "title",
            ts: 1,
            value: older.value,
            prior: undefined,
            hadPrior: false,
            lock: older.lock,
          },
        ],
      });
    }
    await db.meta.put({ key: "pending", value: { [lockKey]: refused } });
    await writePatchesToIDB(
      [{ op: "replace", path: ["pending"], value: {} }],
      { pending: {} },
      [{ key: lockKey, before: refused, after: older, restore: true }],
    );
    expect((await db.meta.get("pending"))?.value[lockKey]).toEqual(
      committed ? older : undefined,
    );
  },
);
