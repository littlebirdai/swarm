import {
  installSignedInPrincipal,
  TEST_PRINCIPAL,
} from "../__tests__/fixtures/signedInPrincipal";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { authPrincipal } from "../../lib/authPrincipal";
import type { OutboxEntry } from "@platform/engine";
import { action, mutativeMiddleware } from "../mutativeMiddleware";
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
