import { describe, expect, test } from "bun:test";
import { makeChangeTrackedDb } from "./changeLog";
import {
  readRangePage,
  accessStampFromDoc,
  authorizedFor,
  projectAction,
  CARGO_MAX_BYTES,
  cargoBytes,
  RANGE_PAGE_MAX_BYTES,
  makeSyncAckCollector,
  teamScopeKey,
  userScopeKey,
} from "./syncLog";
import { canAccessTask, heldKeysFor } from "./lib/access";

import { withSyncStore } from "../test-helpers/syncLog.testkit";

describe("interceptor cargo end to end", () => {
  test("insert carries a full patch with the access stamp; a later patch merges and keeps the stamp", async () => {
    await withSyncStore(async ({ db, actions, users, teams, rowsFor }) => {
      const tdb = makeChangeTrackedDb(db, makeSyncAckCollector());
      const id = await rowsFor(tdb).task(users.one, {
        team_id: teams.shared,
        workspace: `team:${teams.shared}`,
        title: "a",
        status: "open",
      });
      let row = (await actions(teamScopeKey(teams.shared)))[0];
      expect(row.full).toBe(true);
      expect(row.patch).toMatchObject({ title: "a", status: "open" });
      expect(row.access_owner).toBe(users.one);
      expect(row.access_key).toBe(`team:${teams.shared}`);
      const tdb2 = makeChangeTrackedDb(db, makeSyncAckCollector());
      await tdb2.patch(id, { status: "done" });
      row = (await actions(teamScopeKey(teams.shared)))[0];
      expect(row.patch).toMatchObject({ title: "a", status: "done" });
      expect(row.full).toBe(true);
      expect(row.access_key).toBe(`team:${teams.shared}`);
    });
  });
  test("locking a row private inside a team revokes it from the team scope; the owner keeps it in their own scope", async () => {
    await withSyncStore(async ({ db, actions, users, teams, rowsFor }) => {
      const tdb = makeChangeTrackedDb(db, makeSyncAckCollector());
      const id = await rowsFor(tdb).task(users.one, {
        team_id: teams.shared,
        workspace: `team:${teams.shared}`,
        title: "a",
      });
      const tdb2 = makeChangeTrackedDb(db, makeSyncAckCollector());
      await tdb2.patch(id, { workspace: `user:${users.one}` });
      const page = await readRangePage(
        db,
        teamScopeKey(teams.shared),
        0,
        10,
        {
          userId: users.seven,
          heldKeys: new Set([`user:${users.seven}`, `team:${teams.shared}`]),
        },
        { cargo: true },
      );
      expect(page.actions[0].op).toBe("delete");
      expect((page.actions[0] as any).patch).toBeUndefined();
      const owner = await readRangePage(
        db,
        userScopeKey(users.one),
        0,
        10,
        { userId: users.one, heldKeys: new Set([`user:${users.one}`]) },
        { cargo: true },
      );
      expect(owner.actions[0].op).toBe("upsert");
      expect(owner.actions[0].patch).toMatchObject({
        title: "a",
        workspace: `user:${users.one}`,
      });
    });
  });
  test("projection guards a STALE stamp too: a team-scope row whose stamp says private reads as delete for members", async () => {
    const row = {
      position: 1,
      entity_type: "tasks",
      entity_id: "t",
      op: "upsert",
      patch: { title: "s" },
      access_owner: "users:1",
      access_key: "user:users:1",
    };
    expect(
      projectAction(row, {
        userId: "users:7",
        heldKeys: new Set(["team:teams:9"]),
      }).op,
    ).toBe("delete");
  });
  test("delete clears cargo so a later re-insert cannot resurrect stale fields", async () => {
    await withSyncStore(async ({ db, actions, users, rowsFor }) => {
      const tdb = makeChangeTrackedDb(db, makeSyncAckCollector());
      const id = await rowsFor(tdb).doc(users.one, {
        title: "d",
        content: "body",
      });
      const tdb2 = makeChangeTrackedDb(db, makeSyncAckCollector());
      await tdb2.delete(id);
      const row = (await actions(userScopeKey(users.one)))[0];
      expect(row.op).toBe("delete");
      expect(row.patch).toBeUndefined();
    });
  });
  test("docs content change ships `omitted: [content]` — no partial, no byIds for life", async () => {
    await withSyncStore(async ({ db, actions, users, rowsFor }) => {
      const tdb = makeChangeTrackedDb(db, makeSyncAckCollector());
      const id = await rowsFor(tdb).doc(users.one, {
        workspace: `user:${users.one}`,
        title: "d",
        content: "v1",
      });
      const tdb2 = makeChangeTrackedDb(db, makeSyncAckCollector());
      await tdb2.patch(id, { content: "v2" });
      const row = (await actions(userScopeKey(users.one)))[0];
      expect(row.partial).toBeUndefined();
      expect(row.omitted).toEqual(["content"]);
      expect(row.patch.content).toBeUndefined();
    });
  });
  test("two writes to one entity in one transaction merge cargo without a second position", async () => {
    await withSyncStore(async ({ db, actions, head, users, rowsFor }) => {
      const c = makeSyncAckCollector();
      const tdb = makeChangeTrackedDb(db, c);
      const id = await rowsFor(tdb).task(users.one, { title: "a" });
      await tdb.patch(id, { status: "done" });
      const rows = await actions(userScopeKey(users.one));
      expect(rows).toHaveLength(1);
      expect(rows[0].patch).toMatchObject({ title: "a", status: "done" });
      expect((await head(userScopeKey(users.one)))?.position).toBe(1);
    });
  });
});

describe("review: stamps, tombstones, moves", () => {
  test("a delete tombstone clears the stamp; the re-entering upsert is re-stamped from the doc", async () => {
    await withSyncStore(async ({ db, actions, users, teams, rowsFor }) => {
      const tdb = makeChangeTrackedDb(db, makeSyncAckCollector());
      const id = await rowsFor(tdb).task(users.one, {
        team_id: teams.a,
        workspace: `team:${teams.a}`,
        title: "x",
      });
      await makeChangeTrackedDb(db, makeSyncAckCollector()).patch(id, {
        team_id: teams.b,
        workspace: `team:${teams.b}`,
      });
      const tomb = (await actions(teamScopeKey(teams.a)))[0];
      expect(tomb.op).toBe("delete");
      expect(tomb.access_key).toBeUndefined();
      expect(tomb.patch).toBeUndefined();
      await makeChangeTrackedDb(db, makeSyncAckCollector()).patch(id, {
        workspace: `user:${users.one}`,
      });
      await makeChangeTrackedDb(db, makeSyncAckCollector()).patch(id, {
        team_id: teams.a,
      });
      expect((await actions(teamScopeKey(teams.a)))[0].op).toBe("delete");
      await makeChangeTrackedDb(db, makeSyncAckCollector()).patch(id, {
        workspace: `team:${teams.a}`,
      });
      const back = (await actions(teamScopeKey(teams.a)))[0];
      expect(back.op).toBe("upsert");
      expect(back.access_key).toBe(`team:${teams.a}`);
    });
  });

  test("assignee change is a scope move: the departed assignee gets a delete, the new one an upsert", async () => {
    await withSyncStore(async ({ db, actions, users, rowsFor }) => {
      const id = await rowsFor(
        makeChangeTrackedDb(db, makeSyncAckCollector()),
      ).task(users.one, {
        workspace: `user:${users.one}`,
        assignee: users.seven,
        title: "t",
      });
      expect(
        (await actions(userScopeKey(users.seven))).map((r) => r.op),
      ).toEqual(["upsert"]);
      await makeChangeTrackedDb(db, makeSyncAckCollector()).patch(id, {
        assignee: users.eight,
      });
      expect(
        (await actions(userScopeKey(users.seven))).map((r) => r.op),
      ).toEqual(["delete"]);
      expect(
        (await actions(userScopeKey(users.eight))).map((r) => r.op),
      ).toEqual(["upsert"]);
      expect(
        (await actions(userScopeKey(users.eight)))[0].access_grants,
      ).toEqual([users.eight]);
    });
  });

  test("kill switch window: rows written with cargo off are partial and self-heal to full on the next write", async () => {
    await withSyncStore(async ({ db, actions, users, rowsFor }) => {
      const id = await rowsFor(
        makeChangeTrackedDb(db, makeSyncAckCollector()),
      ).task(users.one, { workspace: `user:${users.one}`, title: "a" });
      process.env.SYNC_LOG_PAYLOADS_DISABLED = "1";
      try {
        await makeChangeTrackedDb(db, makeSyncAckCollector()).patch(id, {
          title: "b",
        });
        const row = (await actions(userScopeKey(users.one)))[0];
        expect(row.partial).toBe(true);
        expect(row.patch).toBeUndefined();
      } finally {
        delete process.env.SYNC_LOG_PAYLOADS_DISABLED;
      }
      await makeChangeTrackedDb(db, makeSyncAckCollector()).patch(id, {
        status: "done",
      });
      const healed = (await actions(userScopeKey(users.one)))[0];
      expect(healed.partial).toBeUndefined();
      expect(healed.full).toBe(true);
      expect(healed.patch).toMatchObject({ title: "b", status: "done" });
    });
  });

  test("oversized merged cargo poisons to partial when the whole doc does not fit either", async () => {
    await withSyncStore(async ({ db, actions, users, rowsFor }) => {
      const big = "x".repeat(CARGO_MAX_BYTES);
      const id = await rowsFor(
        makeChangeTrackedDb(db, makeSyncAckCollector()),
      ).task(users.one, {
        workspace: `user:${users.one}`,
        description: big,
      });
      const row = (await actions(userScopeKey(users.one)))[0];
      expect(row.partial).toBe(true);
      expect(row.patch).toBeUndefined();
    });
  });

  test("readRangePage closes a page at the byte budget and reports hasMore", async () => {
    await withSyncStore(async ({ db, actions, users, rowsFor }) => {
      const chunk = "y".repeat(CARGO_MAX_BYTES - 1024);
      const n = Math.ceil(RANGE_PAGE_MAX_BYTES / CARGO_MAX_BYTES) + 8;
      for (let i = 0; i < n; i++) {
        await rowsFor(makeChangeTrackedDb(db, makeSyncAckCollector())).task(
          users.one,
          {
            workspace: `user:${users.one}`,
            description: chunk + i,
          },
        );
      }
      const page = await readRangePage(
        db,
        userScopeKey(users.one),
        0,
        1000,
        { userId: users.one, heldKeys: new Set([`user:${users.one}`]) },
        { cargo: true },
      );
      expect(page.actions.length).toBeLessThan(n);
      expect(page.hasMore).toBe(true);
      expect(page.nextFrom).toBe(page.actions.at(-1)?.position);
      expect(
        page.actions.reduce((total, action) => total + cargoBytes(action), 0),
      ).toBeLessThan(RANGE_PAGE_MAX_BYTES);
      expect(
        (await actions(userScopeKey(users.one))).every((row) => row.patch),
      ).toBe(true);
    });
  });

  test("the log's predicate and canAccessTask agree on every generated document and viewer", async () => {
    await withSyncStore(async ({ db, users, teams, rowsFor }) => {
      await rowsFor(db).membership(users.nine, teams.member, {});
      const heldFor = async (u: string) => heldKeysFor({ db } as any, u as any);
      const viewers = [users.one, users.nine, users.five];
      const docs = [
        { user_id: users.one, workspace: `team:${teams.member}` },
        { user_id: users.one, workspace: `user:${users.one}` },
        {
          user_id: users.one,
          workspace: `user:${users.one}`,
          assignee: users.five,
        },
        { user_id: users.one, workspace: "restricted:zzz" },
        { user_id: users.one },
      ];
      for (const d of docs)
        for (const v of viewers) {
          const viaLog = authorizedFor(
            accessStampFromDoc("tasks", d),
            v,
            await heldFor(v),
          );
          const viaAccess = await canAccessTask({ db } as any, v as any, d);
          if (d.workspace !== undefined)
            expect([d, v, viaLog]).toEqual([d, v, viaAccess]);
        }
    });
  });
});
