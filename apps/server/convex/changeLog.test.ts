import { describe, expect, test } from "bun:test";
import {
  scopeFromDoc,
  patchNeedsDocRead,
  trackedTableOf,
  makeChangeTrackedDb,
} from "./changeLog";
import { makeSyncAckCollector } from "./syncLog";
import { serverTest } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";

describe("scopeFromDoc", () => {
  test("extracts owner + team, stringified", () => {
    expect(scopeFromDoc({ user_id: "users:1", team_id: "teams:9" })).toEqual({
      owner_user_id: "users:1",
      team_id: "teams:9",
    });
  });
  test("team is undefined when absent", () => {
    expect(scopeFromDoc({ user_id: "users:1" })).toEqual({
      owner_user_id: "users:1",
      team_id: undefined,
    });
  });
  test("null doc yields no owner (delete of an already-gone row)", () => {
    expect(scopeFromDoc(null)).toEqual({
      owner_user_id: undefined,
      team_id: undefined,
    });
  });
});

describe("patchNeedsDocRead", () => {
  test("needs a read when no prior row exists (first sight)", () => {
    expect(patchNeedsDocRead({ title: "x" }, false)).toBe(true);
  });
  test("needs a read when the patch could move scope", () => {
    expect(patchNeedsDocRead({ team_id: "teams:2" }, true)).toBe(true);
    expect(patchNeedsDocRead({ user_id: "users:2" }, true)).toBe(true);
  });
  test("reuses the existing row's scope for an ordinary field change (hot path)", () => {
    expect(patchNeedsDocRead({ inbox_dismissed_at: 123 }, true)).toBe(false);
    expect(patchNeedsDocRead({ message_count: 5 }, true)).toBe(false);
  });
});

async function setup() {
  const t = serverTest();
  const people = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "change log accounts");
    const user = await rows.user();
    const peer = await rows.user();
    const team = await rows.team();
    const otherTeam = await rows.team();
    return { user, peer, team, otherTeam };
  });
  const readChanges = () => t.run(({ db }) => db.query("change_log").collect());
  const readSync = (scope?: string) =>
    t.run(async ({ db }) =>
      (await db.query("sync_actions").collect())
        .filter((row) => !scope || row.scope_key === scope)
        .sort((a, b) => a.position - b.position),
    );
  return { t, ...people, readChanges, readSync };
}

describe("trackedTableOf", () => {
  test("identifies each tracked table from an id", async () => {
    const c = await setup();
    await c.t.run(async ({ db }) => {
      const rows = fixtureRows(db, "tracked row IDs");
      const project = await db.insert("projects", {
        user_id: c.user,
        title: "Release",
        status: "active",
        created_at: 1,
        updated_at: 1,
      });
      expect(trackedTableOf(db, await rows.conversation(c.user))).toBe(
        "conversations",
      );
      expect(trackedTableOf(db, await rows.task(c.user))).toBe("tasks");
      expect(trackedTableOf(db, await rows.doc(c.user))).toBe("docs");
      expect(trackedTableOf(db, await rows.plan(c.user))).toBe("plans");
      expect(trackedTableOf(db, project)).toBe("projects");
    });
  });

  test("returns null for untracked ids", async () => {
    const c = await setup();
    await c.t.run(async ({ db }) => {
      const rows = fixtureRows(db, "untracked row IDs");
      const conversation = await rows.conversation(c.user);
      expect(trackedTableOf(db, await rows.message(conversation))).toBeNull();
      expect(trackedTableOf(db, c.user)).toBeNull();
    });
  });
});

describe("makeChangeTrackedDb — emission", () => {
  test("insert into a tracked table emits one upsert row with scope", async () => {
    const c = await setup();
    const id = await c.t.run(({ db }) =>
      fixtureRows(makeChangeTrackedDb(db), "tracked conversation").conversation(
        c.user,
        { team_id: c.team },
      ),
    );
    const rows = await c.readChanges();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entity_type: "conversations",
      entity_id: id,
      op: "upsert",
      owner_user_id: c.user,
      team_id: c.team,
    });
    expect(typeof rows[0].seq).toBe("number");
  });

  test("insert into an UNtracked table emits nothing", async () => {
    const c = await setup();
    await c.t.run(async ({ db }) => {
      const conversation = await fixtureRows(
        db,
        "message conversation",
      ).conversation(c.user);
      await fixtureRows(
        makeChangeTrackedDb(db),
        "tracked writer message",
      ).message(conversation, { content: "hi" });
    });
    expect(await c.readChanges()).toHaveLength(0);
  });

  test("repeated writes to one entity upsert a SINGLE row (bounded by entity count)", async () => {
    const c = await setup();
    const id = await c.t.run(async ({ db }) => {
      const writer = makeChangeTrackedDb(db);
      const task = await fixtureRows(writer, "task writes").task(c.user);
      await writer.patch(task, { status: "in_progress" });
      await writer.patch(task, { status: "done" });
      return task;
    });
    const rows = await c.readChanges();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entity_id: id, op: "upsert" });
  });

  test("a dismiss-style patch (no scope fields) still emits — the gap the feed closes", async () => {
    const c = await setup();
    const id = await c.t.run(({ db }) =>
      fixtureRows(db, "raw dismissed conversation").conversation(c.user, {
        updated_at: 1,
      }),
    );
    await c.t.run(({ db }) =>
      makeChangeTrackedDb(db).patch(id, { inbox_dismissed_at: 123456 }),
    );
    const rows = await c.readChanges();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      op: "upsert",
      entity_id: id,
      owner_user_id: c.user,
    });
    expect((await c.t.run(({ db }) => db.get(id)))?.updated_at).toBe(1);
  });

  test("delete emits an op:delete tombstone with the pre-delete scope", async () => {
    const c = await setup();
    const id = await c.t.run(async ({ db }) => {
      const writer = makeChangeTrackedDb(db);
      const doc = await fixtureRows(writer, "deleted document").doc(c.user, {
        team_id: c.team,
      });
      await writer.delete(doc);
      return doc;
    });
    const rows = await c.readChanges();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entity_type: "docs",
      entity_id: id,
      op: "delete",
      owner_user_id: c.user,
      team_id: c.team,
    });
    expect(await c.t.run(({ db }) => db.get(id))).toBeNull();
  });

  test("a team reassignment patch refreshes the recorded team scope", async () => {
    const c = await setup();
    await c.t.run(async ({ db }) => {
      const writer = makeChangeTrackedDb(db);
      const task = await fixtureRows(writer, "reassigned task").task(c.user, {
        team_id: c.team,
      });
      await writer.patch(task, { team_id: c.otherTeam });
    });
    const rows = await c.readChanges();
    expect(rows).toHaveLength(1);
    expect(rows[0].team_id).toBe(c.otherTeam);
  });

  test("untracked patch/delete never touch the change log", async () => {
    const c = await setup();
    await c.t.run(async ({ db }) => {
      const rows = fixtureRows(db, "untracked writes");
      const message = await rows.message(await rows.conversation(c.user));
      const writer = makeChangeTrackedDb(db);
      await writer.patch(message, { content: "x" });
      await writer.delete(message);
    });
    expect(await c.readChanges()).toHaveLength(0);
  });
});

describe("makeChangeTrackedDb: session owners fan-out", () => {
  async function ownedConversation() {
    const c = await setup();
    const conv = await c.t.run(({ db }) =>
      fixtureRows(
        makeChangeTrackedDb(db),
        "co-owned conversation",
      ).conversation(c.user),
    );
    const membership = {
      conversation_id: conv,
      user_id: c.peer,
      added_by: c.user,
      added_at: 1,
    };
    const addOwner = () =>
      c.t.run(({ db }) =>
        makeChangeTrackedDb(db).insert("session_owners", membership),
      );
    return { ...c, conv, membership, addOwner };
  }

  test("a session_owners insert emits a thin upsert in the new owner's scope, stamped with their grant", async () => {
    const c = await ownedConversation();
    await c.addOwner();
    const rows = await c.readSync(`user:${c.peer}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entity_type: "conversations",
      entity_id: c.conv,
      op: "upsert",
      access_owner: c.user,
      access_grants: [c.peer],
    });
    expect(rows[0].patch).toBeUndefined();
  });

  test("the runner joining as an owner appends nothing new", async () => {
    const c = await ownedConversation();
    const before = await c.readSync();
    await c.t.run(({ db }) =>
      makeChangeTrackedDb(db).insert("session_owners", {
        ...c.membership,
        user_id: c.user,
      }),
    );
    expect(await c.readSync()).toEqual(before);
  });

  test("a co-owner's patch lands positions in both the runner's and the co-owner's scope", async () => {
    const c = await ownedConversation();
    const scopes = await c.t.run(async ({ db }) => {
      await db.insert("session_owners", c.membership);
      const collector = makeSyncAckCollector();
      await makeChangeTrackedDb(db, collector).patch(c.conv, {
        inbox_pinned_at: 5,
      });
      return collector.positions.map((p) => p.scope_key).sort();
    });
    expect(scopes).toEqual([`user:${c.user}`, `user:${c.peer}`].sort());
    const [row] = await c.readSync(`user:${c.peer}`);
    expect(row).toMatchObject({ op: "upsert", access_grants: [c.peer] });
    expect(row.patch).toMatchObject({ inbox_pinned_at: 5 });
  });

  test("removing an owner emits nothing in the departed owner's scope, and later writes stop reaching it", async () => {
    const c = await ownedConversation();
    const row = await c.addOwner();
    const before = await c.readSync(`user:${c.peer}`);
    await c.t.run(async ({ db }) => {
      const writer = makeChangeTrackedDb(db);
      await writer.delete(row);
      await writer.patch(c.conv, { title: "renamed" });
    });
    expect(await c.readSync(`user:${c.peer}`)).toEqual(before);
    expect(
      (await c.readSync(`user:${c.user}`))[0].access_grants,
    ).toBeUndefined();
  });
});
