import {
  installSignedInPrincipal,
  TEST_PRINCIPAL,
} from "../../__tests__/fixtures/signedInPrincipal";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { authPrincipal } from "../../../lib/authPrincipal";
import { AUTH_JWT_STORAGE_KEY } from "../../__tests__/fixtures/fakeAuthToken";
import { _reopenForTests, db } from "../db";
import * as dexieStorage from "../dexie-storage";
import { createIdbJournalBridge } from "./journal-bridge";

let savedJwt: string | null = null;
let activeIdb: IDBFactory;
const hadWindow = "window" in globalThis;

beforeAll(() => {
  installSignedInPrincipal(TEST_PRINCIPAL);
  if (!hadWindow) {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    });
  }
});

afterAll(() => {
  if (!hadWindow) Reflect.deleteProperty(globalThis, "window");
});

beforeEach(async () => {
  installSignedInPrincipal("userA");
  savedJwt = localStorage.getItem(AUTH_JWT_STORAGE_KEY);
  activeIdb = new IDBFactory();
  await _reopenForTests({ indexedDB: activeIdb, IDBKeyRange });
  authPrincipal.check();
});

afterEach(() => {
  if (savedJwt === null) localStorage.removeItem(AUTH_JWT_STORAGE_KEY);
  else localStorage.setItem(AUTH_JWT_STORAGE_KEY, savedJwt);
  authPrincipal.check();
});

describe("createIdbJournalBridge", () => {
  test("stamps cacheOwner so rolling back to Dexie preserves outbox and pendingEntries", async () => {
    const bridge = createIdbJournalBridge();
    const sid = "a".repeat(32);

    await bridge.writePendingEntries(
      [
        {
          op: "replace",
          path: ["pending", `sessions:${sid}`],
          value: { type: "include" },
        },
      ],
      { [`sessions:${sid}`]: { type: "include" } },
    );
    await bridge.enqueueDispatch({
      id: "outbox-1",
      action: "sendMessage",
      args: ["c1", "hello"],
      ts: 100,
      accountId: "userA",
    });

    const ownerRow = await db.meta.get("cacheOwner");
    expect(ownerRow?.value?.principal).toBe("userA");

    const loaded = await dexieStorage.loadCache(["pending"]);
    expect(loaded?.pending).toEqual({
      [`sessions:${sid}`]: { type: "include" },
    });
    expect(await dexieStorage.loadOutbox()).toHaveLength(1);
  });

  test("refuses and purges account A pendingEntries when account B boots without context.currentUser", async () => {
    const bridge = createIdbJournalBridge();
    const sid = "b".repeat(32);

    await bridge.writePendingEntries(
      [
        {
          op: "replace",
          path: ["pending", `sessions:${sid}`],
          value: { type: "include" },
        },
      ],
      { [`sessions:${sid}`]: { type: "include" } },
    );
    expect(await db.pendingEntries.count()).toBe(1);

    await _reopenForTests({ indexedDB: activeIdb, IDBKeyRange });
    installSignedInPrincipal("userB");
    authPrincipal.check();

    const loaded = await bridge.loadJournalKeys(["pending"], {}, "userB");
    expect(loaded).toEqual({});
    expect(await db.pendingEntries.count()).toBe(0);
    expect((await db.meta.get("cacheOwner"))?.value?.principal).toBe("userB");
  });

  test("expires old exclude tombstones when loading journal keys", async () => {
    const bridge = createIdbJournalBridge();
    const staleSid = "c".repeat(32);
    const freshSid = "d".repeat(32);
    const pending = {
      [`sessions:${staleSid}`]: { type: "exclude", ts: 1 },
      [`sessions:${freshSid}`]: {
        type: "exclude",
        ts: Date.now() - 1000,
      },
    };

    await bridge.writePendingEntries(
      [{ op: "replace", path: ["pending"], value: pending }],
      pending,
    );

    const loaded = await bridge.loadJournalKeys(["pending"], {}, "userA");
    expect(loaded.pending).toEqual({
      [`sessions:${freshSid}`]: pending[`sessions:${freshSid}`],
    });
  });

  test("purgeJournal keeps owner pending input and stamps cacheOwner", async () => {
    const bridge = createIdbJournalBridge();
    bridge.persistPendingMessageChanges(
      {},
      {
        c1: [{ id: "draft-1", text: "keep me", sentAt: 100 } as any],
      },
      "userA",
    );
    await bridge.writePendingEntries(
      [
        {
          op: "replace",
          path: ["pending", "sessions:x"],
          value: { type: "include" },
        },
      ],
      { "sessions:x": { type: "include" } },
    );

    await bridge.purgeJournal("userA");

    expect((await db.meta.get("cacheOwner"))?.value?.principal).toBe("userA");
    expect(await db.pendingEntries.count()).toBe(0);
    const reloaded = await bridge.loadJournalKeys(
      ["pendingMessages"],
      {},
      "userA",
    );
    expect(reloaded.pendingMessages?.c1?.[0]?.text).toBe("keep me");
  });
});
