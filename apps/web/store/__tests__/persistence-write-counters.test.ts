import "./fixtures/signedInPrincipal";
import { beforeEach, expect, spyOn, test } from "bun:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import {
  flushPendingMetaWrites,
  hasPendingCollectionWrites,
  resetCollectionWrites,
  writePatchesToIDB,
} from "../persistence/collection-writer";
import { _reopenForTests, db } from "../persistence/db";

beforeEach(async () => {
  resetCollectionWrites();
  await _reopenForTests({ indexedDB: new IDBFactory(), IDBKeyRange });
});

test("a meta write that throws before it starts leaves no pending write", async () => {
  const put = spyOn(db.meta, "put").mockImplementationOnce(() => {
    throw new Error("sync failure");
  });
  try {
    writePatchesToIDB([{ op: "replace", path: ["threadUnread"], value: 7 }], {
      threadUnread: 7,
      pending: {},
    });
    expect(hasPendingCollectionWrites()).toBe(true);
    try {
      flushPendingMetaWrites();
    } catch {}
    expect(put).toHaveBeenCalled();
    expect(hasPendingCollectionWrites()).toBe(false);
  } finally {
    put.mockRestore();
  }
});
