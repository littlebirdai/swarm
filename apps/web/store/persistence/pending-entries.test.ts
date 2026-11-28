import {
  installSignedInPrincipal,
  TEST_PRINCIPAL,
} from "../__tests__/fixtures/signedInPrincipal";
import { describe, expect, it, spyOn } from "bun:test";
import { IDBFactory, IDBKeyRange, IDBObjectStore } from "fake-indexeddb";
import { _reopenForTests, db } from "./db";
import { writeOwnerStamp } from "./ownership";
import { writePendingEntries } from "./pending-entries";

describe("pendingEntries journal persistence", () => {
  it("commits only the two changed pending keys from a whole-map action", async () => {
    installSignedInPrincipal();
    await _reopenForTests({ indexedDB: new IDBFactory(), IDBKeyRange });
    await db.meta.put({ key: "currentUser", value: { _id: TEST_PRINCIPAL } });
    await writeOwnerStamp(TEST_PRINCIPAL, "test-fixture");
    const pending = Object.fromEntries(
      Array.from({ length: 400 }, (_, i) => [
        `liveElements:${i}:v`,
        { type: "field" as const, value: i, ts: 1 },
      ]),
    );
    await writePendingEntries(
      [{ op: "replace", path: ["pending"], value: pending }],
      pending,
    );
    const changed = { ...pending };
    changed["liveElements:7:v"] = { type: "field", value: -7, ts: 2 };
    delete changed["liveElements:8:v"];
    const puts: string[] = [];
    const deletes: string[] = [];
    const put = IDBObjectStore.prototype.put;
    const remove = IDBObjectStore.prototype.delete;
    const putSpy = spyOn(IDBObjectStore.prototype, "put").mockImplementation(
      function (this: IDBObjectStore, value, key) {
        if (this.name === "pendingEntries") puts.push(value.key);
        return put.call(this, value, key);
      },
    );
    const deleteSpy = spyOn(
      IDBObjectStore.prototype,
      "delete",
    ).mockImplementation(function (this: IDBObjectStore, key) {
      if (this.name === "pendingEntries") deletes.push(String(key));
      return remove.call(this, key);
    });
    try {
      await writePendingEntries(
        [{ op: "replace", path: ["pending"], value: changed }],
        changed,
      );
      expect(puts).toEqual(["liveElements:7:v"]);
      expect(deletes).toEqual(["liveElements:8:v"]);
      expect(await db.pendingEntries.count()).toBe(399);
      expect((await db.pendingEntries.get("liveElements:7:v"))?.value).toEqual(
        changed["liveElements:7:v"],
      );
      const narrow = new Proxy(changed, {
        ownKeys() {
          throw new Error("walked all pending entries for a narrow patch");
        },
      });
      await writePendingEntries(
        [
          {
            op: "replace",
            path: ["pending", "liveElements:7:v", "ts"],
            value: 2,
          },
        ],
        narrow,
      );
      expect(puts).toEqual(["liveElements:7:v", "liveElements:7:v"]);
      expect(await db.meta.get("pending")).toBeUndefined();
    } finally {
      deleteSpy.mockRestore();
      putSpy.mockRestore();
      db.close();
    }
  });

  it("contains a rejected pending-entry write", async () => {
    installSignedInPrincipal();
    await _reopenForTests({ indexedDB: new IDBFactory(), IDBKeyRange });
    await db.meta.put({ key: "currentUser", value: { _id: TEST_PRINCIPAL } });
    await writeOwnerStamp(TEST_PRINCIPAL, "test-fixture");
    const put = IDBObjectStore.prototype.put;
    const key = "docs:abort:title";
    let aborted = false;
    const spy = spyOn(IDBObjectStore.prototype, "put").mockImplementation(
      function (this: IDBObjectStore, value, primaryKey) {
        const request = put.call(this, value, primaryKey);
        if (this.name === "pendingEntries" && value.key === key) {
          aborted = true;
          this.transaction.abort();
        }
        return request;
      },
    );
    try {
      let failed = false;
      try {
        await writePendingEntries(
          [{ op: "add", path: ["pending", key], value: {} }],
          { [key]: { type: "field", ts: 1, value: "edit" } },
        );
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
      expect(aborted).toBe(true);
      expect(await db.pendingEntries.get(key)).toBeUndefined();
    } finally {
      spy.mockRestore();
      db.close();
    }
  });
});
