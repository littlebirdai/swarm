import { describe, expect, spyOn, test } from "bun:test";
import { makeChangeTrackedDb } from "./changeLog";
import {
  appendSyncAction,
  buildCargo,
  isChurnOnlyPatch,
  makeSyncAckCollector,
  teamScopeKey,
  userScopeKey,
} from "./syncLog";
import { rollUpUsage } from "./messages";

import { withSyncStore } from "../test-helpers/syncLog.testkit";
import type { Id } from "./_generated/dataModel";

describe("makeChangeTrackedDb — dual emission through the interceptor", () => {
  test("tracked insert dual-writes change_log and the sync log with a collected position", async () => {
    await withSyncStore(async ({ db, actions, users, teams, rowsFor }) => {
      const collector = makeSyncAckCollector();
      const tdb = makeChangeTrackedDb(db, collector);
      const id = await rowsFor(tdb).task(users.one, {
        team_id: teams.shared,
        workspace: `team:${teams.shared}`,
      });
      expect(
        (await actions(userScopeKey(users.one))).map((r) => r.entity_id),
      ).toEqual([String(id)]);
      expect(
        (await actions(teamScopeKey(teams.shared))).map((r) => r.entity_id),
      ).toEqual([String(id)]);
      expect(collector.positions).toEqual([
        { scope_key: `user:${users.one}`, position: 1 },
        { scope_key: `team:${teams.shared}`, position: 1 },
      ]);
    });
  });

  test("a tracked insert without a stored workspace key is stamped at the chokepoint (review)", async () => {
    await withSyncStore(async ({ db, users, rowsFor }) => {
      const tdb = makeChangeTrackedDb(db, makeSyncAckCollector());
      const id = await rowsFor(tdb).doc(users.one, {
        title: "raw insert site",
        workspace: undefined,
      });
      const row = await db.get(id);
      expect(row.workspace).toBe(`user:${users.one}`);
      const cid = await rowsFor(tdb).conversation(users.one, {
        title: "c",
      });
      expect(await db.get(cid)).not.toHaveProperty("workspace");
    });
  });

  test("a stale routing-era upsert in a team scope the row no longer fans to is flipped to a delete on the next write", async () => {
    await withSyncStore(async ({ db, actions, users, teams, rowsFor }) => {
      const tdb = makeChangeTrackedDb(db, makeSyncAckCollector());
      const id = await rowsFor(tdb).task(users.one, {
        team_id: teams.routed,
        workspace: `user:${users.one}`,
        title: "t",
      });
      expect(await actions(teamScopeKey(teams.routed))).toHaveLength(0);
      await db.insert("sync_actions", {
        scope_key: `team:${teams.routed}`,
        position: 1,
        entity_type: "tasks",
        entity_id: String(id),
        op: "upsert",
        ts: 1,
      });
      const tdb2 = makeChangeTrackedDb(db, makeSyncAckCollector());
      await tdb2.patch(id, { title: "t2" });
      const stale = await actions(teamScopeKey(teams.routed));
      expect(stale).toHaveLength(1);
      expect(stale[0].op).toBe("delete");
      expect(stale[0].patch).toBeUndefined();
      const tdb3 = makeChangeTrackedDb(db, makeSyncAckCollector());
      await tdb3.patch(id, { title: "t3" });
      expect(
        (await actions(teamScopeKey(teams.routed))).map((r) => r.op),
      ).toEqual(["delete"]);
    });
  });

  test("a current team scope's upsert is never flipped", async () => {
    await withSyncStore(async ({ db, actions, users, teams, rowsFor }) => {
      const tdb = makeChangeTrackedDb(db, makeSyncAckCollector());
      const id = await rowsFor(tdb).task(users.one, {
        team_id: teams.routed,
        workspace: `team:${teams.routed}`,
        title: "t",
      });
      const tdb2 = makeChangeTrackedDb(db, makeSyncAckCollector());
      await tdb2.patch(id, { title: "t2" });
      expect(
        (await actions(teamScopeKey(teams.routed))).map((r) => r.op),
      ).toEqual(["upsert"]);
    });
  });

  test("patch that moves team emits revocation in the departed team scope", async () => {
    await withSyncStore(async ({ db, actions, users, teams, rowsFor }) => {
      const tdb = makeChangeTrackedDb(db, makeSyncAckCollector());
      const id = await rowsFor(tdb).task(users.one, {
        team_id: teams.a,
        workspace: `team:${teams.a}`,
      });
      const tdb2 = makeChangeTrackedDb(db, makeSyncAckCollector());
      await tdb2.patch(id, { team_id: teams.b, workspace: `team:${teams.b}` });
      const departed = await actions(teamScopeKey(teams.a));
      expect(departed).toHaveLength(1);
      expect(departed[0].op).toBe("delete");
      expect((await actions(teamScopeKey(teams.b))).map((r) => r.op)).toEqual([
        "upsert",
      ]);
    });
  });

  test("ordinary semantic patch stays in-scope and just moves the row forward", async () => {
    await withSyncStore(async ({ db, actions, head, users, rowsFor }) => {
      const tdb = makeChangeTrackedDb(db, makeSyncAckCollector());
      const id = await rowsFor(tdb).conversation(users.one, {});
      const tdb2 = makeChangeTrackedDb(db, makeSyncAckCollector());
      await tdb2.patch(id, { title: "one" });
      const tdb3 = makeChangeTrackedDb(db, makeSyncAckCollector());
      await tdb3.patch(id, { inbox_dismissed_at: 42 });
      const rows = await actions(userScopeKey(users.one));
      expect(rows).toHaveLength(1);
      expect(rows[0].position).toBe(3);
      expect((await head(userScopeKey(users.one)))?.position).toBe(3);
    });
  });

  test("a member row's patch always carries project_id (sticky cargo), so a replica without the row can name the project", async () => {
    await withSyncStore(async ({ db, actions, users, project, rowsFor }) => {
      const tdb = makeChangeTrackedDb(db, makeSyncAckCollector());
      const id = await rowsFor(tdb).task(users.one, {
        workspace: `user:${users.one}`,
        status: "open",
        project_id: project,
      });
      const tdb2 = makeChangeTrackedDb(db, makeSyncAckCollector());
      await tdb2.patch(id, { status: "done" });
      const [row] = await actions(userScopeKey(users.one));
      expect(row.patch).toMatchObject({
        status: "done",
        project_id: project,
      });
      const bare = await rowsFor(tdb).plan(users.one, {
        workspace: `user:${users.one}`,
        status: "active",
      });
      await makeChangeTrackedDb(db, makeSyncAckCollector()).patch(bare, {
        status: "done",
      });
      const planRow = (await actions(userScopeKey(users.one))).find(
        (r) => r.entity_id === String(bare),
      );
      expect(planRow.patch.status).toBe("done");
      expect("project_id" in planRow.patch).toBe(false);
    });
  });

  test("delete emits a delete action in every visible scope", async () => {
    await withSyncStore(async ({ db, actions, users, teams, rowsFor }) => {
      const tdb = makeChangeTrackedDb(db, makeSyncAckCollector());
      const id = await rowsFor(tdb).doc(users.one, {
        team_id: teams.shared,
        workspace: `team:${teams.shared}`,
      });
      const tdb2 = makeChangeTrackedDb(db, makeSyncAckCollector());
      await tdb2.delete(id);
      expect((await actions(userScopeKey(users.one))).map((r) => r.op)).toEqual(
        ["delete"],
      );
      expect(
        (await actions(teamScopeKey(teams.shared))).map((r) => r.op),
      ).toEqual(["delete"]);
    });
  });

  test("membership insert/delete emits scope lifecycle actions in the member's scope", async () => {
    await withSyncStore(async ({ db, actions, users, teams, rowsFor }) => {
      const tdb = makeChangeTrackedDb(db, makeSyncAckCollector());
      const mid = await rowsFor(tdb).membership(users.seven, teams.shared, {
        role: "member",
      });
      const tdb2 = makeChangeTrackedDb(db, makeSyncAckCollector());
      await tdb2.delete(mid);
      expect(
        (await actions(userScopeKey(users.seven))).map((r) => [
          r.entity_type,
          r.op,
        ]),
      ).toEqual([
        ["scope", "scope_added"],
        ["scope", "scope_removed"],
      ]);
      expect(
        (await actions(teamScopeKey(teams.shared))).map((r) => [
          r.entity_type,
          r.entity_id,
          r.op,
        ]),
      ).toEqual([["member", users.seven, "scope_removed"]]);
    });
  });

  test("a member removal row never coalesces with the team's entity rows or a repeat", async () => {
    await withSyncStore(async ({ db, actions, users, teams }) => {
      await appendSyncAction(
        db,
        null,
        `team:${teams.shared}`,
        "tasks",
        users.seven,
        "upsert",
      );
      await appendSyncAction(
        db,
        null,
        `team:${teams.shared}`,
        "member",
        users.seven,
        "scope_removed",
      );
      await appendSyncAction(
        db,
        null,
        `team:${teams.shared}`,
        "member",
        users.seven,
        "scope_removed",
      );
      expect(
        (await actions(`team:${teams.shared}`)).map((r) => [
          r.entity_type,
          r.op,
        ]),
      ).toEqual([
        ["tasks", "upsert"],
        ["member", "scope_removed"],
        ["member", "scope_removed"],
      ]);
    });
  });

  test("conversations never emit into the team scope", async () => {
    await withSyncStore(async ({ db, actions, users, teams, rowsFor }) => {
      const tdb = makeChangeTrackedDb(db, makeSyncAckCollector());
      await rowsFor(tdb).conversation(users.one, {
        team_id: teams.shared,
        team_visibility: "full",
      });
      expect(await actions(teamScopeKey(teams.shared))).toHaveLength(0);
      expect(await actions(userScopeKey(users.one))).toHaveLength(1);
    });
  });
});

describe("churn exemption (design D1)", () => {
  test("status probe bookkeeping never rides cargo, while semantic changes still advance the head", async () => {
    await withSyncStore(async ({ db, actions, head, users, rowsFor }) => {
      const scope = userScopeKey(users.one);
      const probe = {
        at: 100,
        due_at: 10100,
        has_assistant_message: true,
        has_tool_result_reply: false,
      };
      const id = await rowsFor(db).conversation(users.one, {
        title: "Before",
      });
      const tracked = makeChangeTrackedDb(db, makeSyncAckCollector());
      await tracked.patch(id, { agent_status_probe: probe });
      expect(await head(scope)).toBeNull();
      expect(await actions(scope)).toEqual([]);
      expect((await db.get(id)).agent_status_probe).toEqual(probe);
      await tracked.patch(id, {
        agent_status_probe: { ...probe, at: 200 },
        title: "After",
      });
      expect((await head(scope)).position).toBe(1);
      expect((await actions(scope))[0].patch).toMatchObject({ title: "After" });
      expect((await actions(scope))[0].patch).not.toHaveProperty(
        "agent_status_probe",
      );
      expect(
        buildCargo("conversations", await db.get(id), { full: true }).patch,
      ).not.toHaveProperty("agent_status_probe");
    });
  });

  test("assistant usage rollups persist without reading or advancing the shared sync head", async () => {
    await withSyncStore(async ({ ctx, db, actions, head, users, rowsFor }) => {
      const scope = userScopeKey(users.one);
      const query = spyOn(db, "query");
      let lastId!: Id<"conversations">;
      for (let i = 0; i < 25; i++) {
        lastId = await rowsFor(db).conversation(users.one, {});
        const conversation = await db.get(lastId);
        const tracked = makeChangeTrackedDb(db, makeSyncAckCollector());
        const patch: Record<string, unknown> = {
          message_count: 1,
          updated_at: 100,
        };
        await rollUpUsage(
          { db: tracked, scheduler: ctx.scheduler },
          conversation,
          [{ usage: { input_tokens: 10, output_tokens: 5 }, inserted: true }],
          patch,
          100,
        );
        await tracked.patch(lastId, patch);
        expect((await db.get(lastId)).usage_totals).toMatchObject({
          input: 10,
          output: 5,
          cache_read: 0,
          cache_write: 0,
          updated_at: 100,
        });
      }
      expect(
        query.mock.calls.filter(([table]) => table === "sync_heads"),
      ).toHaveLength(0);
      expect(await head(scope)).toBeNull();
      expect(await actions(scope)).toEqual([]);

      const tracked = makeChangeTrackedDb(db, makeSyncAckCollector());
      const patch: Record<string, unknown> = { title: "Updated title" };
      await rollUpUsage(
        { db: tracked, scheduler: ctx.scheduler },
        await db.get(lastId),
        [{ usage: { input_tokens: 2, output_tokens: 3 }, inserted: true }],
        patch,
        200,
      );
      await tracked.patch(lastId, patch);
      expect((await head(scope))?.position).toBe(1);
      expect((await actions(scope))[0].patch).toEqual({
        title: "Updated title",
      });
      expect((await db.get(lastId)).usage_totals).toMatchObject({
        input: 12,
        output: 8,
        updated_at: 200,
      });
    });
  });

  test("counter/liveness-only conversation patches emit no sync action", async () => {
    await withSyncStore(async ({ db, actions, users, rowsFor }) => {
      const tdb = makeChangeTrackedDb(db, makeSyncAckCollector());
      const id = await rowsFor(tdb).conversation(users.one, {});
      const before = await actions(userScopeKey(users.one));
      const tdb2 = makeChangeTrackedDb(db, makeSyncAckCollector());
      await tdb2.patch(id, {
        message_count: 7,
        updated_at: 123,
      });
      const after = await actions(userScopeKey(users.one));
      expect(after).toEqual(before);
    });
  });

  test("a mixed patch (churn + semantic field) still emits", async () => {
    await withSyncStore(async ({ db, actions, users, rowsFor }) => {
      const tdb = makeChangeTrackedDb(db, makeSyncAckCollector());
      const id = await rowsFor(tdb).conversation(users.one, {});
      const tdb2 = makeChangeTrackedDb(db, makeSyncAckCollector());
      await tdb2.patch(id, { message_count: 7, inbox_dismissed_at: 999 });
      expect((await actions(userScopeKey(users.one)))[0].position).toBe(2);
    });
  });

  test("isChurnOnlyPatch: only listed tables, only full-churn key sets", () => {
    expect(isChurnOnlyPatch("conversations", { message_count: 1 })).toBe(true);
    expect(
      isChurnOnlyPatch("conversations", {
        message_count: 1,
        updated_at: 2,
        activity: { text: "editing a.ts", tool: "Edit", at: 2 },
      }),
    ).toBe(true);
    expect(
      isChurnOnlyPatch("conversations", { message_count: 1, title: "x" }),
    ).toBe(false);
    expect(isChurnOnlyPatch("conversations", {})).toBe(false);
    expect(isChurnOnlyPatch("tasks", { updated_at: 1 })).toBe(false);
  });
});

describe("kill switch", () => {
  test("SYNC_LOG_DISABLED=1 stops emission without touching change_log", async () => {
    const prev = process.env.SYNC_LOG_DISABLED;
    process.env.SYNC_LOG_DISABLED = "1";
    try {
      await withSyncStore(async ({ db, actions, rowsFor, users }) => {
        const tdb = makeChangeTrackedDb(db, makeSyncAckCollector());
        const task = await rowsFor(tdb).task(users.one);
        expect(await actions()).toEqual([]);
        expect(await db.query("change_log").collect()).toEqual([
          expect.objectContaining({ entity_id: task, op: "upsert" }),
        ]);
      });
    } finally {
      if (prev === undefined) delete process.env.SYNC_LOG_DISABLED;
      else process.env.SYNC_LOG_DISABLED = prev;
    }
  });
});

describe("scope-move sequences (review majors)", () => {
  test("move + unrelated patch in ONE transaction keeps the revocation", async () => {
    await withSyncStore(async ({ db, actions, users, teams, rowsFor }) => {
      const tdb = makeChangeTrackedDb(db, makeSyncAckCollector());
      const id = await rowsFor(tdb).doc(users.one, {
        team_id: teams.a,
        workspace: `team:${teams.a}`,
      });
      const tdb2 = makeChangeTrackedDb(db, makeSyncAckCollector());
      await tdb2.patch(id, { team_id: teams.b, workspace: `team:${teams.b}` });
      await tdb2.patch(id, { title: "renamed" });
      expect((await actions(teamScopeKey(teams.a))).map((r) => r.op)).toEqual([
        "delete",
      ]);
      expect((await actions(teamScopeKey(teams.b))).map((r) => r.op)).toEqual([
        "upsert",
      ]);
      expect((await actions(userScopeKey(users.one))).map((r) => r.op)).toEqual(
        ["upsert"],
      );
    });
  });

  test("double move T1→T2→T3 leaves revocations in both departed scopes", async () => {
    await withSyncStore(async ({ db, actions, users, teams, rowsFor }) => {
      const tdb = makeChangeTrackedDb(db, makeSyncAckCollector());
      const id = await rowsFor(tdb).doc(users.one, {
        team_id: teams.a,
        workspace: `team:${teams.a}`,
      });
      const tdb2 = makeChangeTrackedDb(db, makeSyncAckCollector());
      await tdb2.patch(id, { team_id: teams.b, workspace: `team:${teams.b}` });
      const tdb3 = makeChangeTrackedDb(db, makeSyncAckCollector());
      await tdb3.patch(id, { team_id: teams.c, workspace: `team:${teams.c}` });
      expect((await actions(teamScopeKey(teams.a))).map((r) => r.op)).toEqual([
        "delete",
      ]);
      expect((await actions(teamScopeKey(teams.b))).map((r) => r.op)).toEqual([
        "delete",
      ]);
      expect((await actions(teamScopeKey(teams.c))).map((r) => r.op)).toEqual([
        "upsert",
      ]);
    });
  });
});
