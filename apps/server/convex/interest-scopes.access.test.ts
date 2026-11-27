import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { api } from "./_generated/api";
import { asUser, serverTest } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";

const PREVIOUS_FLAG = process.env.SWARM_INTEREST_SCOPES;

afterEach(() => {
  if (PREVIOUS_FLAG === undefined) {
    delete process.env.SWARM_INTEREST_SCOPES;
  } else {
    process.env.SWARM_INTEREST_SCOPES = PREVIOUS_FLAG;
  }
});

describe("interest scopes never widen workspace access", () => {
  test("getHeads and getRange reject unauthorized project, session, dir, channel, and user scopes", async () => {
    process.env.SWARM_INTEREST_SCOPES = "1";
    const t = serverTest();
    const setup = await t.run(async (ctx) => {
      const rows = fixtureRows(ctx.db, "interest-access-gates");
      const owner = await rows.user({ name: "Owner" });
      const teammate = await rows.user({ name: "Teammate" });
      const outsider = await rows.user({ name: "Outsider" });
      const team = await rows.team({
        name: "T1",
        features: { chat: true },
      });
      await rows.membership(owner, team);
      await rows.membership(teammate, team);

      const teamProj = await ctx.db.insert("projects", {
        user_id: owner,
        team_id: team,
        workspace: `team:${team}`,
        title: "Shared Project",
        status: "active",
        created_at: 1,
        updated_at: 1,
      });
      const privProj = await ctx.db.insert("projects", {
        user_id: owner,
        workspace: `user:${owner}`,
        title: "Personal Project",
        status: "active",
        created_at: 1,
        updated_at: 1,
      });
      const pubConv = await rows.conversation(owner, {
        team_id: team,
        is_private: false,
        team_visibility: "full",
      });
      const privConv = await rows.conversation(owner, {
        team_id: team,
        is_private: true,
      });
      const pubChan = await ctx.db.insert("chat_channels", {
        team_id: team,
        name: "general",
        kind: "public",
        workspace: `team:${team}`,
        created_by: owner,
        created_at: 1,
        updated_at: 1,
      });
      const privChan = await ctx.db.insert("chat_channels", {
        team_id: team,
        name: "secret",
        kind: "private",
        workspace: `restricted:secret`,
        created_by: owner,
        created_at: 1,
        updated_at: 1,
      });

      const scopesToSeed = [
        `team:${team}`,
        `user:${owner}`,
        `dir:${team}`,
        `project:${teamProj}`,
        `project:${privProj}`,
        `session:${pubConv}`,
        `session:${privConv}`,
        `channel:${pubChan}`,
        `channel:${privChan}`,
      ];
      for (const scope_key of scopesToSeed) {
        await ctx.db.insert("sync_heads", {
          scope_key,
          position: 1,
          floor: 0,
          updated_at: 1,
        });
      }

      return {
        owner,
        teammate,
        outsider,
        team,
        teamProj,
        privProj,
        pubConv,
        privConv,
        pubChan,
        privChan,
        scopesToSeed,
      };
    });

    const outsiderClient = asUser(t, setup.outsider);
    const outsiderHeads = await outsiderClient.query(api.syncLog.getHeads, {
      scopes: setup.scopesToSeed,
    });
    expect(outsiderHeads.heads).toEqual([]);

    for (const scope_key of setup.scopesToSeed) {
      const range = await outsiderClient.query(api.syncLog.getRange, {
        scope_key,
        from: 0,
        cargo: true,
        limit: 50,
      });
      expect(range.authorized).toBe(false);
      expect(range.actions).toEqual([]);
    }

    const teammateClient = asUser(t, setup.teammate);
    const teammateHeads = await teammateClient.query(api.syncLog.getHeads, {
      scopes: setup.scopesToSeed,
    });
    expect(teammateHeads.heads.map((h) => h.scope_key)).toEqual([
      `team:${setup.team}`,
      `dir:${setup.team}`,
      `project:${setup.teamProj}`,
      `session:${setup.pubConv}`,
      `channel:${setup.pubChan}`,
    ]);

    for (const forbidden of [
      `user:${setup.owner}`,
      `project:${setup.privProj}`,
      `session:${setup.privConv}`,
      `channel:${setup.privChan}`,
    ]) {
      const range = await teammateClient.query(api.syncLog.getRange, {
        scope_key: forbidden,
        from: 0,
        cargo: true,
        limit: 50,
      });
      expect(range.authorized).toBe(false);
      expect(range.actions).toEqual([]);
    }

    delete process.env.SWARM_INTEREST_SCOPES;
    const offRange = await teammateClient.query(api.syncLog.getRange, {
      scope_key: `project:${setup.teamProj}`,
      from: 0,
      cargo: true,
      limit: 50,
    });
    expect(offRange.authorized).toBe(false);
    expect(offRange.actions).toEqual([]);
  });

  test("rows stamped with private workspace inside an accessible interest scope are projected as delete without cargo and hidden from entity queries", async () => {
    process.env.SWARM_INTEREST_SCOPES = "1";
    const t = serverTest();
    const setup = await t.run(async (ctx) => {
      const rows = fixtureRows(ctx.db, "interest-adversarial-row");
      const owner = await rows.user({ name: "Owner" });
      const teammate = await rows.user({ name: "Teammate" });
      const team = await rows.team({ name: "T1" });
      const otherTeam = await rows.team({ name: "Other" });
      await rows.membership(owner, team);
      await rows.membership(teammate, team);

      const teamProj = await ctx.db.insert("projects", {
        user_id: owner,
        team_id: team,
        workspace: `team:${team}`,
        title: "Proj",
        status: "active",
        created_at: 1,
        updated_at: 1,
      });

      const privateTask = await rows.task(owner, {
        team_id: team,
        project_id: teamProj,
        workspace: `user:${owner}`,
        home_scope: `project:${teamProj}`,
        title: "Secret task",
      });
      const privatePlan = await rows.plan(owner, {
        team_id: team,
        workspace: `user:${owner}`,
        home_scope: `dir:${team}`,
        title: "Secret plan",
      });
      const privateDoc = await rows.doc(owner, {
        team_id: team,
        project_id: teamProj,
        workspace: `user:${owner}`,
        home_scope: `project:${teamProj}`,
        title: "Secret doc",
      });

      const tamperedScope = `project:${teamProj}`;
      await ctx.db.insert("sync_heads", {
        scope_key: tamperedScope,
        position: 2,
        floor: 0,
        updated_at: 1,
      });
      await ctx.db.insert("sync_actions", {
        scope_key: tamperedScope,
        position: 1,
        entity_type: "tasks",
        entity_id: String(privateTask),
        op: "upsert",
        ts: 1,
        patch: { title: "Secret task" },
        access_owner: String(owner),
        access_key: `user:${owner}`,
      });
      await ctx.db.insert("sync_actions", {
        scope_key: tamperedScope,
        position: 2,
        entity_type: "tasks",
        entity_id: String(privateTask),
        op: "upsert",
        ts: 2,
        patch: { title: "Other team secret" },
        access_owner: String(owner),
        access_key: `team:${otherTeam}`,
      });

      return {
        teammate,
        team,
        teamProj,
        privateTask,
        privatePlan,
        privateDoc,
        tamperedScope,
      };
    });

    const teammateClient = asUser(t, setup.teammate);
    const range = await teammateClient.query(api.syncLog.getRange, {
      scope_key: setup.tamperedScope,
      from: 0,
      cargo: true,
      limit: 50,
    });
    expect(range.authorized).not.toBe(false);
    expect(range.actions).toHaveLength(2);
    for (const action of range.actions) {
      expect(action.op).toBe("delete");
      expect(action.patch).toBeUndefined();
    }

    const byIdsTasks = await teammateClient.query(api.tasks.webGetByIds, {
      ids: [String(setup.privateTask)],
    });
    expect(byIdsTasks.items).toEqual([]);

    const listedTasks = await teammateClient.query(api.tasks.webList, {
      workspace: "team",
      team_id: setup.team,
      project_id: String(setup.teamProj),
    });
    expect(listedTasks.items.map((row: any) => String(row._id))).not.toContain(
      String(setup.privateTask),
    );

    const byIdsDocs = await teammateClient.query(api.docs.webGetByIds, {
      ids: [String(setup.privateDoc)],
    });
    expect(byIdsDocs.docs).toEqual([]);

    const listedDocs = await teammateClient.query(api.docs.webListPaginated, {
      workspace: "team",
      team_id: setup.team,
      project_id: String(setup.teamProj),
      paginationOpts: { numItems: 50, cursor: null },
    });
    expect(listedDocs.page.map((row: any) => String(row._id))).not.toContain(
      String(setup.privateDoc),
    );

    const byIdsPlans = await teammateClient.query(api.plans.webGetByIds, {
      ids: [String(setup.privatePlan)],
    });
    expect(byIdsPlans).toEqual([]);
  });

  test("access predicates in access.ts and accessKeys.ts never read home_scope", () => {
    const extractBlock = (source: string, needle: string): string => {
      const start = source.indexOf(needle);
      if (start < 0) throw new Error(`Missing symbol ${needle}`);
      const rest = source.slice(start + needle.length);
      const next = rest.search(/\nexport\s+(?:async\s+)?function\s+/);
      return next < 0 ? rest : rest.slice(0, next);
    };

    const accessKeysSrc = readFileSync(
      join(import.meta.dir, "lib/accessKeys.ts"),
      "utf8",
    );
    for (const fn of [
      "export async function heldKeysFor(",
      "export function authorizedFor(",
      "export async function accessStampFor(",
      "export async function workspaceGrantsAccess(",
    ]) {
      expect(extractBlock(accessKeysSrc, fn)).not.toContain("home_scope");
    }

    const accessSrc = readFileSync(
      join(import.meta.dir, "lib/access.ts"),
      "utf8",
    );
    for (const fn of [
      "export async function canAccessTask(",
      "export async function canAccessPlan(",
      "export async function canAccessDoc(",
      "export async function canAccessProject(",
    ]) {
      expect(extractBlock(accessSrc, fn)).not.toContain("home_scope");
    }
  });
});
