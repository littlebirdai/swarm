import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import {
  countDatabaseReads,
  serverTest,
} from "../../test-helpers/database.testkit";
import { fixtureRows } from "../../test-helpers/rows.testkit";
import {
  DAEMON_LAST_SEEN_THROTTLE_MS,
  touchDaemonLastSeen,
} from "./daemonLiveness";

const NOW = 1_800_000_000_000;

describe("touchDaemonLastSeen", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });
  afterEach(() => jest.useRealTimers());

  test("a burst of daemon calls writes the users row once per window", async () => {
    const t = serverTest({ documentsWritten: 1 });
    const id = await t.run(({ db }) => fixtureRows(db, "daemon burst").user());
    await t.run(async (ctx) => {
      for (let i = 0; i < 20; i++) {
        jest.setSystemTime(NOW + i);
        await touchDaemonLastSeen(ctx, id);
      }
    });
    expect((await t.run(({ db }) => db.get(id)))?.daemon_last_seen).toBe(NOW);
  });

  test("a stale stamp is refreshed; a passed-in fresh doc is not re-read or written", async () => {
    const t = serverTest();
    const stale = NOW - DAEMON_LAST_SEEN_THROTTLE_MS - 1;
    const id = await t.run(({ db }) =>
      fixtureRows(db, "daemon refresh").user({ daemon_last_seen: stale }),
    );
    await t.run((ctx) => touchDaemonLastSeen(ctx, id));
    const refreshed = (await t.run(({ db }) => db.get(id)))!;
    expect(refreshed.daemon_last_seen).toBe(NOW);

    jest.setSystemTime(NOW + 1);
    await t.run(async (ctx) => {
      const { db, reads } = countDatabaseReads(ctx.db);
      await touchDaemonLastSeen({ db }, id, refreshed);
      expect(reads).toEqual([]);
    });
    expect((await t.run(({ db }) => db.get(id)))?.daemon_last_seen).toBe(NOW);
  });
});
