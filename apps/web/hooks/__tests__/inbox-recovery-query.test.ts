import { expect, test } from "bun:test";
import { makeFunctionReference } from "convex/server";
import { rowHash, splitRows } from "@codecast/inbox/inboxSplit";
import { testConvex } from "../../test-helpers/testConvex";
import {
  queryInboxRecovery,
  settleSplitPush,
  setSplitPersistence,
} from "../useSplitQuery";

type Row = { _id: string; updated_at: number; revision: number };
type List = { sessions: Row[]; hidden_count: number };
const now = 1_800_000_000_000;
const row = { _id: "session-a", updated_at: now - 3_600_000, revision: 2 };
const list = { sessions: [row], hidden_count: 0 };
const split = splitRows([[row._id, row]], now);
const splitPayload = { ...split, split: true, hidden_count: list.hidden_count };

function listQuery(name: string) {
  return makeFunctionReference<"query", { _probe?: number }, List>(name);
}

test("a recovery uses one whole read and seeds the next cold split push", async () => {
  const backend = testConvex();
  const query = listQuery("test:inboxRecovery");
  backend.set(query, list);
  try {
    expect(split.hot).toEqual([]);
    await expect(
      queryInboxRecovery(
        backend.client,
        query,
        {},
        "list",
        new AbortController().signal,
      ),
    ).resolves.toEqual(list);
    expect(backend.queryRequests).toEqual([
      { name: "test:inboxRecovery", args: { _probe: expect.any(Number) } },
    ]);

    const rebuilt = await settleSplitPush(
      backend.client,
      query,
      {},
      "list",
      splitPayload,
      () => false,
    );
    expect(rebuilt?.sessions).toEqual([row]);
    expect(backend.queryRequests).toHaveLength(1);
  } finally {
    await backend.client.close();
  }
});

for (const stale of [false, true]) {
  test(`a live split push with ${stale ? "stale" : "current"} saved rows reads ${stale ? "one whole result" : "no whole result"}`, async () => {
    const backend = testConvex();
    const query = listQuery(
      `test:inboxLiveSplit${stale ? "Stale" : "Current"}`,
    );
    backend.set(query, list);
    const saved = { ...row, revision: stale ? 1 : 2 };
    setSplitPersistence({
      load: async () => [{ id: saved._id, hash: rowHash(saved), row: saved }],
      save: () => {},
    });
    try {
      const rebuilt = await settleSplitPush(
        backend.client,
        query,
        {},
        "list",
        splitPayload,
        () => false,
      );
      expect(rebuilt?.sessions).toEqual([row]);
      expect(backend.queryRequests).toHaveLength(stale ? 1 : 0);
    } finally {
      setSplitPersistence(null);
      await backend.client.close();
    }
  });
}
