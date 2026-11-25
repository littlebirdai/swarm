import { describe, expect, test } from "bun:test";
import {
  appendSyncAction,
  readRangePage,
  buildCargo,
  mergeCargo,
  accessStampFromDoc,
  authorizedFor,
  projectAction,
  CARGO_MAX_BYTES,
  emitSyncActions,
  makeSyncAckCollector,
  scopesForChange,
  teamScopeKey,
  userScopeKey,
} from "./syncLog";
import { prunablePrefix } from "./syncLogPrune";
import { accessStampFor } from "./lib/accessKeys";

import { withSyncStore } from "../test-helpers/syncLog.testkit";

describe("scopesForChange (access-derived fan-out)", () => {
  test("tasks land in owner + the WORKSPACE team + the assignee's scope", () => {
    expect(
      scopesForChange("tasks", {
        owner_user_id: "users:1",
        team_id: "teams:9",
        workspace: "team:teams:9",
        grants: ["users:2"],
      }),
    ).toEqual(["user:users:1", "team:teams:9", "user:users:2"]);
  });
  test("private inside a team (team_id set, workspace user:owner) never enters the team scope", () => {
    expect(
      scopesForChange("docs", {
        owner_user_id: "users:1",
        team_id: "teams:9",
        workspace: "user:users:1",
      }),
    ).toEqual(["user:users:1"]);
  });
  test("a task assigned to me with no team reaches me through my user scope", () => {
    expect(
      scopesForChange("tasks", {
        owner_user_id: "users:1",
        workspace: "user:users:1",
        grants: ["users:7"],
      }),
    ).toEqual(["user:users:1", "user:users:7"]);
  });
  test("conversations never fan to a team, even with a team key", () => {
    expect(
      scopesForChange("conversations", {
        owner_user_id: "users:1",
        team_id: "teams:9",
        workspace: "team:teams:9",
      }),
    ).toEqual(["user:users:1"]);
  });
  test("conversations fan to the runner and every session owner, once each", () => {
    expect(
      scopesForChange("conversations", {
        owner_user_id: "users:1",
        team_id: "teams:9",
        grants: ["users:2", "users:1", "users:3", "users:2"],
      }),
    ).toEqual(["user:users:1", "user:users:2", "user:users:3"]);
  });
  test("no owner means no scopes (already-gone row)", () => {
    expect(
      scopesForChange("tasks", {
        owner_user_id: undefined,
        team_id: "teams:9",
      }),
    ).toEqual([]);
  });
});

describe("appendSyncAction — ordering and coalescing", () => {
  test("positions are strictly increasing per scope in append order", async () => {
    await withSyncStore(async ({ db, actions, head }) => {
      await appendSyncAction(db, null, "user:u1", "tasks", "tasks:1", "upsert");
      await appendSyncAction(db, null, "user:u1", "tasks", "tasks:2", "upsert");
      await appendSyncAction(db, null, "user:u1", "docs", "docs:1", "upsert");
      expect((await actions("user:u1")).map((r) => r.position)).toEqual([
        1, 2, 3,
      ]);
      expect((await head("user:u1"))?.position).toBe(3);
    });
  });

  test("scopes have independent counters", async () => {
    await withSyncStore(async ({ db, head }) => {
      await appendSyncAction(db, null, "user:u1", "tasks", "tasks:1", "upsert");
      await appendSyncAction(db, null, "team:t1", "tasks", "tasks:1", "upsert");
      expect((await head("user:u1"))?.position).toBe(1);
      expect((await head("team:t1"))?.position).toBe(1);
    });
  });

  test("a re-written entity MOVES its row to the new head instead of appending", async () => {
    await withSyncStore(async ({ db, actions, head }) => {
      await appendSyncAction(db, null, "user:u1", "tasks", "tasks:1", "upsert");
      await appendSyncAction(db, null, "user:u1", "tasks", "tasks:2", "upsert");
      await appendSyncAction(db, null, "user:u1", "tasks", "tasks:1", "upsert");
      const rows = await actions("user:u1");
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => [r.entity_id, r.position])).toEqual([
        ["tasks:2", 2],
        ["tasks:1", 3],
      ]);
      expect((await head("user:u1"))?.position).toBe(3);
    });
  });

  test("a reader whose cursor already passed the entity sees it again after the move", async () => {
    await withSyncStore(async ({ db, actions }) => {
      await appendSyncAction(db, null, "user:u1", "tasks", "tasks:1", "upsert"); // pos 1
      const cursorAfterFirstApply = 1;
      await appendSyncAction(db, null, "user:u1", "tasks", "tasks:1", "upsert"); // moves to 2
      const unseen = (await actions("user:u1")).filter(
        (r) => r.position > cursorAfterFirstApply,
      );
      expect(unseen.map((r) => r.entity_id)).toEqual(["tasks:1"]);
    });
  });

  test("delete flips the entity's active row in place at the new head", async () => {
    await withSyncStore(async ({ db, actions }) => {
      await appendSyncAction(db, null, "user:u1", "tasks", "tasks:1", "upsert");
      await appendSyncAction(db, null, "user:u1", "tasks", "tasks:1", "delete");
      const rows = await actions("user:u1");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        entity_id: "tasks:1",
        op: "delete",
        position: 2,
      });
    });
  });

  test("scope lifecycle actions always insert (never coalesce with entity rows)", async () => {
    await withSyncStore(async ({ db, actions, teams }) => {
      await appendSyncAction(
        db,
        null,
        "user:u1",
        "scope",
        teams.shared,
        "scope_added",
      );
      await appendSyncAction(
        db,
        null,
        "user:u1",
        "scope",
        teams.shared,
        "scope_removed",
      );
      expect((await actions("user:u1")).map((r) => r.op)).toEqual([
        "scope_added",
        "scope_removed",
      ]);
    });
  });

  test("collector dedupes repeated identical appends within one transaction", async () => {
    await withSyncStore(async ({ db, actions }) => {
      const collector = makeSyncAckCollector();
      await appendSyncAction(
        db,
        collector,
        "user:u1",
        "tasks",
        "tasks:1",
        "upsert",
      );
      await appendSyncAction(
        db,
        collector,
        "user:u1",
        "tasks",
        "tasks:1",
        "upsert",
      );
      expect(await actions("user:u1")).toHaveLength(1);
      expect(collector.positions).toEqual([
        { scope_key: "user:u1", position: 1 },
      ]);
    });
  });
});

describe("emitSyncActions — scope moves", () => {
  test("moving a task between teams revokes in the departed scope", async () => {
    await withSyncStore(async ({ db, actions, users, teams }) => {
      await emitSyncActions(db, null, "tasks", "tasks:1", "upsert", {
        owner_user_id: users.one,
        team_id: teams.a,
        workspace: `team:${teams.a}`,
      });
      await emitSyncActions(
        db,
        null,
        "tasks",
        "tasks:1",
        "upsert",
        {
          owner_user_id: users.one,
          team_id: teams.b,
          workspace: `team:${teams.b}`,
        },
        {
          owner_user_id: users.one,
          team_id: teams.a,
          workspace: `team:${teams.a}`,
        },
      );
      const departed = await actions(teamScopeKey(teams.a));
      expect(departed).toHaveLength(1);
      expect(departed[0].op).toBe("delete");
      const entered = await actions(teamScopeKey(teams.b));
      expect(entered).toHaveLength(1);
      expect(entered[0].op).toBe("upsert");
      // Owner scope keeps one moved upsert row.
      const owner = await actions(userScopeKey(users.one));
      expect(owner).toHaveLength(1);
      expect(owner[0].op).toBe("upsert");
    });
  });

  test("unchanged scope emits no revocation", async () => {
    await withSyncStore(async ({ db, actions, users, teams }) => {
      await emitSyncActions(
        db,
        null,
        "tasks",
        "tasks:1",
        "upsert",
        {
          owner_user_id: users.one,
          team_id: teams.a,
          workspace: `team:${teams.a}`,
        },
        {
          owner_user_id: users.one,
          team_id: teams.a,
          workspace: `team:${teams.a}`,
        },
      );
      expect((await actions(teamScopeKey(teams.a))).map((r) => r.op)).toEqual([
        "upsert",
      ]);
    });
  });
});

describe("prunablePrefix (retention prefix walk)", () => {
  test("deletes the old prefix and stops at the first young row", () => {
    const { toDelete, stoppedEarly } = prunablePrefix(
      [{ ts: 1 }, { ts: 2 }, { ts: 100 }, { ts: 3 }],
      50,
    );
    expect(toDelete).toEqual([{ ts: 1 }, { ts: 2 }]);
    expect(stoppedEarly).toBe(true);
  });
  test("consumes the whole page when everything is old", () => {
    const { toDelete, stoppedEarly } = prunablePrefix(
      [{ ts: 1 }, { ts: 2 }],
      50,
    );
    expect(toDelete).toHaveLength(2);
    expect(stoppedEarly).toBe(false);
  });
  test("empty page is not an early stop", () => {
    const { toDelete, stoppedEarly } = prunablePrefix([], 50);
    expect(toDelete).toHaveLength(0);
    expect(stoppedEarly).toBe(false);
  });
});

describe("allocatePosition — sub-mutation safety (review C2)", () => {
  test("a second collector's bump between a parent's writes never mints a duplicate position", async () => {
    await withSyncStore(async ({ db, actions, head }) => {
      const parent = makeSyncAckCollector();
      // Parent writes (caches head at position 1).
      await appendSyncAction(
        db,
        parent,
        "user:u1",
        "tasks",
        "tasks:1",
        "upsert",
      );
      // Sub-mutation with its OWN collector bumps the same scope (same txn, same db).
      const child = makeSyncAckCollector();
      await appendSyncAction(
        db,
        child,
        "user:u1",
        "tasks",
        "tasks:2",
        "upsert",
      );
      // Parent writes again from its (stale) cache — must re-read, not reuse.
      await appendSyncAction(db, parent, "user:u1", "docs", "docs:1", "upsert");
      const positions = (await actions("user:u1"))
        .map((r) => r.position)
        .sort((a, b) => a - b);
      expect(positions).toEqual([1, 2, 3]); // no duplicates
      expect((await head("user:u1"))?.position).toBe(3);
    });
  });
});

describe("readRangePage (review C19)", () => {
  const seed = async (db: any, n: number) => {
    for (let i = 1; i <= n; i++) {
      await appendSyncAction(
        db,
        null,
        "user:u1",
        "tasks",
        `tasks:${i}`,
        "upsert",
      );
    }
  };
  test("pages ascending with hasMore and nextFrom", async () => {
    await withSyncStore(async ({ db, actions }) => {
      await seed(db, 5);
      const p1 = await readRangePage(db, "user:u1", 0, 2);
      expect(p1.actions.map((a) => a.position)).toEqual([1, 2]);
      expect(p1.hasMore).toBe(true);
      expect(p1.nextFrom).toBe(2);
      const p2 = await readRangePage(db, "user:u1", p1.nextFrom, 100);
      expect(p2.actions.map((a) => a.position)).toEqual([3, 4, 5]);
      expect(p2.hasMore).toBe(false);
      expect(p2.nextFrom).toBe(5);
    });
  });
  test("floor above the cursor returns resync", async () => {
    await withSyncStore(async ({ db, head }) => {
      await seed(db, 3);
      const h = await head("user:u1");
      await db.patch(h!._id, { floor: 2 });
      expect((await readRangePage(db, "user:u1", 1, 10)).resync).toBe(true);
      // Cursor exactly at the floor is fine (floor rows are deleted, gt(floor) is the range).
      expect(
        (await readRangePage(db, "user:u1", 2, 10)).resync,
      ).toBeUndefined();
    });
  });
  test("empty scope with no head is caught up at 0", async () => {
    await withSyncStore(async ({ db, actions }) => {
      const r = await readRangePage(db, "user:u1", 0, 10);
      expect(r).toMatchObject({ actions: [], nextFrom: 0, hasMore: false });
    });
  });
});

// ── Cargo (sync-log-cargo E1–E4) ─────────────────────────────────────────────

describe("buildCargo", () => {
  test("carries top-level fields, turns undefined into unset, drops system fields", () => {
    expect(
      buildCargo(
        "tasks",
        { _id: "x", title: "t", status: undefined },
        { full: false },
      ),
    ).toEqual({
      patch: { title: "t" },
      unset: ["status"],
      full: undefined,
      partial: undefined,
    });
  });
  test("denylisted (OMIT-class) fields are dropped silently with their names recorded — never partial", () => {
    const c = buildCargo(
      "docs",
      { title: "d", content: "big body", team_id: "teams:1" },
      { full: false },
    );
    expect(c.patch).toEqual({ title: "d" });
    expect(c.partial).toBeUndefined();
    expect(c.omitted!.sort()).toEqual(["content", "team_id"]);
  });
  test("churn-exempt fields never ride cargo, even inside a semantic patch", () => {
    const c = buildCargo(
      "conversations",
      { pending_api_error: true, last_message_preview: "A", model: "x" },
      { full: false },
    );
    expect(c.patch).toEqual({ pending_api_error: true });
  });
  test("oversized patch drops cargo to partial", () => {
    const c = buildCargo(
      "tasks",
      { description: "x".repeat(CARGO_MAX_BYTES + 1) },
      { full: false },
    );
    expect(c.patch).toBeUndefined();
    expect(c.partial).toBe(true);
  });
  test("full flag rides through", () => {
    expect(buildCargo("projects", { title: "p" }, { full: true }).full).toBe(
      true,
    );
  });
  test("kill switch strips cargo but keeps the action honest (partial)", () => {
    const prev = process.env.SYNC_LOG_PAYLOADS_DISABLED;
    process.env.SYNC_LOG_PAYLOADS_DISABLED = "1";
    try {
      expect(buildCargo("tasks", { title: "t" }, { full: false })).toEqual({
        partial: true,
      });
    } finally {
      if (prev === undefined) delete process.env.SYNC_LOG_PAYLOADS_DISABLED;
      else process.env.SYNC_LOG_PAYLOADS_DISABLED = prev;
    }
  });
});

describe("mergeCargo (coalesce merge, E2)", () => {
  test("later fields overlay, unset removes, re-set clears unset", () => {
    const a = { patch: { title: "a", status: "open" } };
    const b = { patch: { status: "done" }, unset: ["title"] };
    const ab = mergeCargo(a, b);
    expect(ab.patch).toEqual({ status: "done" });
    expect(ab.unset).toEqual(["title"]);
    const c = { patch: { title: "c" } };
    const abc = mergeCargo(ab, c);
    expect(abc.patch).toEqual({ status: "done", title: "c" });
    expect(abc.unset).toBeUndefined();
  });
  test("set → unset → set converges to the same row for every reader (idempotent merge)", () => {
    const steps = [
      { patch: { x: 1 } },
      { unset: ["x"], patch: {} },
      { patch: { x: 3 } },
    ];
    const merged = steps.reduce((acc: any, s) => mergeCargo(acc, s), null);
    // A reader at cursor 0 applies merged; a reader at cursor 2 applies step 3 — same end state.
    const applyTo = (row: any, c: any) => {
      const r = { ...row, ...(c.patch ?? {}) };
      for (const k of c.unset ?? []) delete r[k];
      return r;
    };
    expect(applyTo({}, merged)).toEqual({ x: 3 });
    expect(applyTo(applyTo(applyTo({}, steps[0]), steps[1]), steps[2])).toEqual(
      { x: 3 },
    );
  });
  test("a full cargo replaces whatever came before (including a prior partial)", () => {
    // The accumulated unset names ride along: a reader whose base still holds
    // `b` must learn it is gone, and a full patch cannot say so by itself.
    expect(
      mergeCargo(
        { patch: { a: 1 }, unset: ["b"], partial: true },
        { patch: { c: 3 }, full: true },
      ),
    ).toEqual({ patch: { c: 3 }, full: true, unset: ["b"] });
  });
  test("a full cargo drops carried unset names its own patch re-sets (review)", () => {
    expect(
      mergeCargo(
        { patch: { a: 1 }, unset: ["b", "d"] },
        { patch: { b: 2 }, full: true },
      ),
    ).toEqual({ patch: { b: 2 }, full: true, unset: ["d"] });
  });
  test("partial is sticky even when the next cargo carries a patch (review blocker)", () => {
    const m = mergeCargo({ partial: true }, { patch: { b: 2 } });
    expect(m.partial).toBe(true);
    expect(m.patch).toEqual({ b: 2 });
  });
  test("an incoming cargo without a patch poisons the row to partial", () => {
    const m = mergeCargo({ patch: { a: 1 } }, { partial: true });
    expect(m.patch).toBeUndefined();
    expect(m.partial).toBe(true);
  });
  test("partial is sticky across merges until a full cargo", () => {
    const m = mergeCargo(
      { patch: { a: 1 }, partial: true },
      { patch: { b: 2 } },
    );
    expect(m.partial).toBe(true);
    expect(
      mergeCargo(m, { patch: { z: 1 }, full: true }).partial,
    ).toBeUndefined();
  });
});

describe("access stamp + projection (E4)", () => {
  test("stamp: owner always, workspace key for scoped tables, assignee grant for tasks, no key for conversations", () => {
    expect(
      accessStampFromDoc("tasks", {
        user_id: "u1",
        workspace: "team:T",
        assignee: "u2",
      }),
    ).toEqual({
      access_owner: "u1",
      access_key: "team:T",
      access_grants: ["u2"],
    });
    expect(
      accessStampFromDoc("conversations", {
        user_id: "u1",
        workspace: "team:T",
      }),
    ).toEqual({ access_owner: "u1" });
    expect(accessStampFromDoc("docs", null)).toBeNull();
  });
  test("stamp: a conversation grants its session owners other than the runner, sorted", async () => {
    await withSyncStore(async ({ db, users, rowsFor }) => {
      const conv = await rowsFor(db).conversation(users.one, {});
      for (const u of [users.three, users.one, users.two]) {
        await db.insert("session_owners", {
          conversation_id: conv,
          user_id: u,
          added_by: u,
          added_at: 1,
        });
      }
      expect(
        await accessStampFor({ db }, "conversations", await db.get(conv)),
      ).toEqual({
        access_owner: users.one,
        access_grants: [users.two, users.three],
      });
      const lone = await rowsFor(db).conversation(users.one, {});
      expect(
        await accessStampFor({ db }, "conversations", await db.get(lone)),
      ).toEqual({ access_owner: users.one });
    });
  });
  test("projectAction: a co-owner gets the conversation's cargo, a teammate who is no owner a delete", () => {
    const row = {
      position: 3,
      entity_type: "conversations",
      entity_id: "c1",
      op: "upsert",
      patch: { title: "anchor" },
      access_owner: "ada",
      access_grants: ["bo"],
    };
    expect(
      projectAction(row, {
        userId: "bo",
        heldKeys: new Set(["user:bo", "team:T"]),
      }).patch,
    ).toEqual({ title: "anchor" });
    expect(
      projectAction(row, {
        userId: "cy",
        heldKeys: new Set(["user:cy", "team:T"]),
      }),
    ).toEqual({
      position: 3,
      entity_type: "conversations",
      entity_id: "c1",
      op: "delete",
    });
  });
  test("authorizedFor: owner, grant, held key; pre-cargo rows pass", () => {
    const held = new Set(["user:u9", "team:T"]);
    expect(
      authorizedFor({ access_owner: "u1", access_key: "team:T" }, "u9", held),
    ).toBe(true);
    expect(
      authorizedFor({ access_owner: "u1", access_key: "user:u1" }, "u9", held),
    ).toBe(false);
    expect(
      authorizedFor(
        { access_owner: "u1", access_key: "user:u1", access_grants: ["u9"] },
        "u9",
        held,
      ),
    ).toBe(true);
    expect(
      authorizedFor(
        { access_owner: "u9", access_key: "user:u9" },
        "u9",
        new Set(),
      ),
    ).toBe(true);
    expect(authorizedFor({}, "u9", new Set())).toBe(false); // fail closed
  });
  test("projectAction: a stampless upsert ships no cargo; cargo rides only on opt-in", () => {
    const stampless = {
      position: 1,
      entity_type: "tasks",
      entity_id: "t",
      op: "upsert",
      patch: { title: "x" },
    };
    expect(
      projectAction(stampless, { userId: "u1", heldKeys: new Set() }).patch,
    ).toBeUndefined();
    const stamped = { ...stampless, access_owner: "u1", access_key: "user:u1" };
    expect(
      projectAction(stamped, { userId: "u1", heldKeys: new Set() }, false)
        .patch,
    ).toBeUndefined();
    expect(
      projectAction(stamped, { userId: "u1", heldKeys: new Set() }, true).patch,
    ).toEqual({ title: "x" });
  });
  test("projectAction: unauthorized upsert becomes a bare delete; authorized carries cargo", () => {
    const row = {
      position: 5,
      entity_type: "tasks",
      entity_id: "t1",
      op: "upsert",
      patch: { title: "secret" },
      access_owner: "u1",
      access_key: "user:u1",
    };
    expect(
      projectAction(row, { userId: "u9", heldKeys: new Set(["team:T"]) }),
    ).toEqual({
      position: 5,
      entity_type: "tasks",
      entity_id: "t1",
      op: "delete",
    });
    expect(
      projectAction(row, { userId: "u1", heldKeys: new Set() }).patch,
    ).toEqual({ title: "secret" });
  });
});

// ── Source guards (sync-log-cargo E4/E7) ────────────────────────────────────
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

describe("source guards", () => {
  const DIR = import.meta.dir;
  const sources = () =>
    readdirSync(DIR).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
    );
  test("access_key is read only by the stamp builder, the projection, the interceptor and the schema", () => {
    const allowed = new Set(["syncLog.ts", "schema.ts", "changeLog.ts"]);
    const offenders = sources().filter(
      (f) =>
        !allowed.has(f) &&
        readFileSync(join(DIR, f), "utf8").includes("access_key"),
    );
    expect(offenders).toEqual([]);
    expect(readFileSync(join(DIR, "lib", "accessKeys.ts"), "utf8")).toContain(
      "access_key",
    ); // the builder
  });
  test("scope_key is never an access input (lib/access.ts does not know the log's scopes)", () => {
    const access = readFileSync(join(DIR, "lib", "access.ts"), "utf8");
    expect(access).not.toContain("scope_key");
    expect(access).not.toContain("sync_actions");
  });
  test("every task_comments insert goes through insertTaskComment (the last_comment_at stamp)", () => {
    const offenders = sources().filter(
      (f) =>
        f !== "tasks.ts" &&
        /\.insert\(\s*"task_comments"/.test(readFileSync(join(DIR, f), "utf8")),
    );
    expect(offenders).toEqual([]);
    expect(
      (
        readFileSync(join(DIR, "tasks.ts"), "utf8").match(
          /\.insert\(\s*"task_comments"/g,
        ) ?? []
      ).length,
    ).toBe(1);
  });
  test("visibleInTeamList agrees with the stamp predicate", async () => {
    const { visibleInTeamList } = await import("./lib/access");
    await withSyncStore(async ({ db, users, teams }) => {
      const docs = [
        { user_id: users.one, workspace: `team:${teams.member}` },
        { user_id: users.one, workspace: `user:${users.one}` },
        {
          user_id: users.one,
          workspace: `user:${users.one}`,
          assignee: users.nine,
        },
        {
          user_id: users.one,
          workspace: `user:${users.one}`,
          assignee: "agent:claude",
        },
      ];
      for (const d of docs)
        for (const v of [users.one, users.nine, users.five]) {
          const viaList = await visibleInTeamList(
            { db } as any,
            v as any,
            "tasks",
            d,
            teams.member,
          );
          const viaStamp = authorizedFor(
            accessStampFromDoc("tasks", d),
            v,
            new Set([`user:${v}`, `team:${teams.member}`]),
          );
          expect([d, v, viaList]).toEqual([d, v, viaStamp]);
        }
    });
  });
  test("agent:* assignees are neither grants nor scopes", () => {
    const stamp = accessStampFromDoc("tasks", {
      user_id: "u1",
      workspace: "user:u1",
      assignee: "agent:claude",
    });
    expect(stamp).not.toBeNull();
    expect(stamp?.access_grants).toBeUndefined();
    expect(
      scopesForChange("tasks", {
        owner_user_id: "u1",
        workspace: "user:u1",
        grants: ["agent:claude"],
      }),
    ).toEqual(["user:u1"]);
  });
  test("coalescing onto a cargo-less existing row cannot emit a thin patch (review blocker)", () => {
    const m = mergeCargo({ op: "upsert" } as any, { patch: { title: "t" } });
    expect(m.partial).toBe(true); // the self-heal then rebuilds a full cargo
  });
});
