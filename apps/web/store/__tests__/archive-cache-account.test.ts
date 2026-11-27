import { TEST_PRINCIPAL } from "./fixtures/signedInPrincipal";
import { expect, spyOn, test } from "bun:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { authPrincipal } from "../../lib/authPrincipal";
import { deleteInvalidatedDocDetails } from "../persistence/collection-writer";
import { _reopenForTests, COLLECTION_TABLES, db } from "../persistence/db";
import {
  _cacheOwnerForTests,
  persistenceOwned,
} from "../persistence/ownership";
import { AUTH_JWT_STORAGE_KEY, issueFakeToken } from "./fixtures/fakeAuthToken";

test("a JWT switch inside the archive deletion transaction preserves the cached detail", async () => {
  await _reopenForTests({ indexedDB: new IDBFactory(), IDBKeyRange });
  const token = localStorage.getItem(AUTH_JWT_STORAGE_KEY)!;
  const id = "a".repeat(32);
  const detail = { _id: id, content: "Body still cached" };
  const read = db.dispatchOutbox.toArray.bind(db.dispatchOutbox);
  const outbox = spyOn(db.dispatchOutbox, "toArray").mockImplementation(
    async () => {
      const rows = await read();
      localStorage.setItem(
        AUTH_JWT_STORAGE_KEY,
        issueFakeToken("other-account"),
      );
      expect(authPrincipal.snapshot()).toBe(TEST_PRINCIPAL);
      expect(authPrincipal.current()).toBe("other-account");
      expect(persistenceOwned()).toBe(true);
      return rows;
    },
  );
  try {
    expect(_cacheOwnerForTests()).toBeNull();
    await COLLECTION_TABLES.docDetails.put(detail);
    expect(
      await deleteInvalidatedDocDetails([id], () => true, {
        accountId: TEST_PRINCIPAL,
        dispatchedAt: 1,
      }),
    ).toEqual([]);
    expect(outbox).toHaveBeenCalledTimes(1);
    expect(await COLLECTION_TABLES.docDetails.get(id)).toEqual(detail);
  } finally {
    outbox.mockRestore();
    localStorage.setItem(AUTH_JWT_STORAGE_KEY, token);
    db.close();
  }
});
