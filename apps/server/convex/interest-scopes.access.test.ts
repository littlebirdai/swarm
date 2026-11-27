import { afterEach, describe, expect, jest, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { api } from "./_generated/api";
import { syncConversationAccess } from "./lib/conversationAccess";
import {
  canReadSyncScope,
  MAX_HEADS_SCOPES,
  resolveHeadsScopes,
} from "./lib/interestScopes";
import { asUser, serverTest } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";

const PREVIOUS_FLAG = process.env.SWARM_INTEREST_SCOPES;

async function assertDenied(client: any, scope_key: string) {
  expect(
    (await client.query(api.syncLog.getHeads, { scopes: [scope_key] })).heads,
  ).toEqual([]);
  const range = await client.query(api.syncLog.getRange, {
    scope_key,
    from: 0,
    cargo: true,
    limit: 50,
  });
  expect(range.authorized).toBe(false);
  expect(range.actions).toEqual([]);
}

afterEach(() => {
  jest.useRealTimers();
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
      await syncConversationAccess(ctx.db, await ctx.db.get(pubConv));
      const privConv = await rows.conversation(owner, {
        team_id: team,
        is_private: true,
      });
      await syncConversationAccess(ctx.db, await ctx.db.get(privConv));
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
      await assertDenied(outsiderClient, scope_key);
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
      await assertDenied(teammateClient, forbidden);
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

  test("caps and dedupes getHeads scopes, rejects forged and unauthenticated calls, and isolates channel workspace and kind checks", async () => {
    process.env.SWARM_INTEREST_SCOPES = "1";
    const t = serverTest();
    const setup = await t.run(async (ctx) => {
      const rows = fixtureRows(ctx.db, "interest-bounds-channels");
      const owner = await rows.user({ name: "Owner" });
      const teammateA = await rows.user({ name: "TeammateA" });
      const teammateB = await rows.user({ name: "TeammateB" });
      const outsider = await rows.user({ name: "Outsider" });
      const teamA = await rows.team({
        name: "TeamA",
        features: { chat: true },
      });
      const teamB = await rows.team({
        name: "TeamB",
        features: { chat: true },
      });
      await rows.membership(owner, teamA);
      await rows.membership(teammateA, teamA);
      await rows.membership(owner, teamB);
      await rows.membership(teammateB, teamB);

      const proj = await ctx.db.insert("projects", {
        user_id: owner,
        team_id: teamA,
        workspace: `team:${teamA}`,
        title: "P",
        status: "active",
        created_at: 1,
        updated_at: 1,
      });
      const task = await rows.task(owner, {
        team_id: teamA,
        workspace: `team:${teamA}`,
      });
      const sharedConv = await rows.conversation(owner, {
        team_id: teamA,
        is_private: false,
        team_visibility: "full",
        share_token: "share-tok-1",
      });
      await syncConversationAccess(ctx.db, await ctx.db.get(sharedConv));

      const mismatchChan = await ctx.db.insert("chat_channels", {
        team_id: teamA,
        name: "routed-a-owned-b",
        kind: "public",
        workspace: `team:${teamB}`,
        created_by: owner,
        created_at: 1,
        updated_at: 1,
      });
      const unknownKindChan = await ctx.db.insert("chat_channels", {
        team_id: teamA,
        name: "future-kind",
        kind: "public",
        workspace: `team:${teamA}`,
        created_by: owner,
        created_at: 1,
        updated_at: 1,
      });
      const restrictedPublicChan = await ctx.db.insert("chat_channels", {
        team_id: teamA,
        name: "restricted-open-kind",
        kind: "public",
        workspace: `restricted:custom`,
        created_by: owner,
        created_at: 1,
        updated_at: 1,
      });
      const agentsChan = await ctx.db.insert("chat_channels", {
        team_id: teamA,
        name: "agents",
        kind: "agents",
        workspace: `team:${teamA}`,
        created_by: owner,
        created_at: 1,
        updated_at: 1,
      });
      const privChan = await ctx.db.insert("chat_channels", {
        team_id: teamA,
        name: "priv",
        kind: "private",
        workspace: `restricted:priv`,
        created_by: owner,
        created_at: 1,
        updated_at: 1,
      });
      await ctx.db.insert("chat_channel_members", {
        channel_id: privChan,
        user_id: owner,
        added_by: owner,
        added_at: 1,
      });

      return {
        owner,
        teammateA,
        teammateB,
        outsider,
        teamA,
        teamB,
        proj,
        task,
        sharedConv,
        mismatchChan,
        unknownKindChan,
        restrictedPublicChan,
        agentsChan,
        privChan,
      };
    });

    const unauthHeads = await t.query(api.syncLog.getHeads, {
      scopes: [`dir:${setup.teamA}`, `channel:${setup.agentsChan}`],
    });
    expect(unauthHeads.heads).toEqual([]);
    const unauthRange = await t.query(api.syncLog.getRange, {
      scope_key: `dir:${setup.teamA}`,
      from: 0,
      limit: 10,
    });
    expect(unauthRange.actions).toEqual([]);

    const memberAClient = asUser(t, setup.teammateA);
    const deduped = await memberAClient.query(api.syncLog.getHeads, {
      scopes: [
        `dir:${setup.teamA}`,
        `dir:${setup.teamA}`,
        `channel:${setup.agentsChan}`,
        `channel:${setup.agentsChan}`,
      ],
    });
    expect(deduped.heads.map((h) => h.scope_key)).toEqual([
      `dir:${setup.teamA}`,
      `channel:${setup.agentsChan}`,
    ]);

    const overCap = Array.from(
      { length: MAX_HEADS_SCOPES + 1 },
      (_, i) => `dir:${i === 0 ? setup.teamA : setup.teamB}`,
    );
    await expect(
      memberAClient.query(api.syncLog.getHeads, { scopes: overCap }),
    ).rejects.toThrow(/max 64/i);

    const forged = [
      `project:${setup.task}`,
      `session:${setup.proj}`,
      "dir:",
      "dir:not-a-team",
      "unknown:x",
      "",
    ];
    for (const scope_key of forged) {
      await assertDenied(memberAClient, scope_key);
    }

    const memberAHeads = await memberAClient.query(api.syncLog.getHeads, {
      scopes: [
        `channel:${setup.mismatchChan}`,
        `channel:${setup.restrictedPublicChan}`,
        `channel:${setup.agentsChan}`,
        `channel:${setup.privChan}`,
      ],
    });
    expect(memberAHeads.heads.map((h) => h.scope_key)).toEqual([
      `channel:${setup.agentsChan}`,
    ]);

    await t.run(async (ctx) => {
      const chan = await ctx.db.get(setup.unknownKindChan);
      const fakeCtx = {
        db: {
          ...ctx.db,
          get: async (id: any) =>
            String(id) === String(setup.unknownKindChan)
              ? { ...chan, kind: "thread_only" }
              : await ctx.db.get(id),
        },
      };
      expect(
        await canReadSyncScope(
          fakeCtx,
          setup.teammateA,
          new Set([`team:${setup.teamA}`]),
          `channel:${setup.unknownKindChan}`,
        ),
      ).toBe(false);
    });

    const memberBClient = asUser(t, setup.teammateB);
    const memberBHeads = await memberBClient.query(api.syncLog.getHeads, {
      scopes: [`channel:${setup.mismatchChan}`],
    });
    expect(memberBHeads.heads.map((h) => h.scope_key)).toEqual([
      `channel:${setup.mismatchChan}`,
    ]);

    const membershipId = await t.run(async (ctx) => {
      return await ctx.db.insert("chat_channel_members", {
        channel_id: setup.privChan,
        user_id: setup.teammateA,
        added_by: setup.owner,
        added_at: 2,
      });
    });
    const joinedHeads = await memberAClient.query(api.syncLog.getHeads, {
      scopes: [`channel:${setup.privChan}`],
    });
    expect(joinedHeads.heads.map((h) => h.scope_key)).toEqual([
      `channel:${setup.privChan}`,
    ]);
    const joinedRange = await memberAClient.query(api.syncLog.getRange, {
      scope_key: `channel:${setup.privChan}`,
      from: 0,
      limit: 10,
    });
    expect(joinedRange.authorized).not.toBe(false);

    await t.run(async (ctx) => {
      await ctx.db.delete(membershipId);
    });
    await assertDenied(memberAClient, `channel:${setup.privChan}`);
    await assertDenied(
      asUser(t, setup.outsider),
      `session:${setup.sharedConv}`,
    );
  });

  test("message flushes and heartbeats do not re-run getHeads, and locking a session private revokes via delete and stops further emission", async () => {
    process.env.SWARM_INTEREST_SCOPES = "1";
    jest.useFakeTimers();
    const t = serverTest();
    const setup = await t.run(async (ctx) => {
      const rows = fixtureRows(ctx.db, "interest-reactive-privacy");
      const owner = await rows.user({ name: "Owner" });
      const teammate = await rows.user({ name: "Teammate" });
      const team = await rows.team({ name: "T1" });
      await rows.membership(owner, team);
      await rows.membership(teammate, team);
      const conv = await rows.conversation(owner, {
        team_id: team,
        session_id: "sess-react-1",
        is_private: false,
        team_visibility: "full",
      });
      await syncConversationAccess(ctx.db, await ctx.db.get(conv));
      await rows.token(owner, "owner-tok");
      await rows.session(owner, {
        session_id: "sess-react-1",
        conversation_id: conv,
        agent_status: "working",
      });
      return { owner, teammate, team, conv };
    });

    const readTables = new Set<string>();
    const readAccessRowIdsBefore = await t.run(async (ctx) => {
      const ids: string[] = [];
      const trackedDb = {
        normalizeId: ctx.db.normalizeId.bind(ctx.db),
        get: async (id: any) => {
          const doc = await ctx.db.get(id);
          if (doc && ctx.db.normalizeId("conversations", id)) {
            readTables.add("conversations");
          }
          ids.push(String(id));
          return doc;
        },
        query: (table: string) => {
          readTables.add(table);
          const q = (ctx.db as any).query(table);
          return {
            withIndex: (name: string, fn: any) => {
              const iq = q.withIndex(name, fn);
              return {
                first: async () => {
                  const row = await iq.first();
                  if (row) ids.push(String(row._id));
                  return row;
                },
                collect: async () => {
                  const rows = await iq.collect();
                  for (const r of rows) ids.push(String(r._id));
                  return rows;
                },
              };
            },
          };
        },
      };
      const resolved = await resolveHeadsScopes(
        { db: trackedDb },
        setup.teammate,
        [`session:${setup.conv}`],
      );
      expect([...resolved.scopes]).toEqual([`session:${setup.conv}`]);
      return ids;
    });
    expect(readTables.has("conversations")).toBe(false);

    const accessBefore = await t.run(async (ctx) => {
      const row = await ctx.db
        .query("conversation_access")
        .withIndex("by_conversation", (q) =>
          q.eq("conversation_id", setup.conv),
        )
        .first();
      return row ? { ...row } : null;
    });

    const ownerClient = asUser(t, setup.owner);
    const teammateClient = asUser(t, setup.teammate);

    await ownerClient.mutation(api.messages.addMessages, {
      conversation_id: setup.conv,
      messages: [
        {
          message_uuid: "msg-1",
          role: "assistant",
          timestamp: Date.now(),
          content: "Streaming progress flush",
        },
      ],
    });
    await ownerClient.mutation(api.managedSessions.heartbeat, {
      session_id: "sess-react-1",
    });
    await t.finishAllScheduledFunctions(() => jest.runAllTimers());

    const accessAfterFlush = await t.run(async (ctx) => {
      const row = await ctx.db
        .query("conversation_access")
        .withIndex("by_conversation", (q) =>
          q.eq("conversation_id", setup.conv),
        )
        .first();
      return row ? { ...row } : null;
    });
    expect(accessAfterFlush).toEqual(accessBefore);
    expect(readAccessRowIdsBefore).toContain(String(accessBefore?._id));

    const headsAfterFlush = await teammateClient.query(api.syncLog.getHeads, {
      scopes: [`session:${setup.conv}`],
    });
    expect(headsAfterFlush.heads).toEqual([
      { scope_key: `session:${setup.conv}`, position: 0, floor: 0 },
    ]);

    const task = await ownerClient.mutation(api.tasks.create, {
      api_token: "owner-tok",
      title: "Session task",
      workspace: "team",
      team_id: setup.team,
      conversation_id: String(setup.conv),
    });
    await t.finishAllScheduledFunctions(() => jest.runAllTimers());

    const headsAfterTask = await teammateClient.query(api.syncLog.getHeads, {
      scopes: [`session:${setup.conv}`],
    });
    expect(headsAfterTask.heads).toEqual([
      { scope_key: `session:${setup.conv}`, position: 1, floor: 0 },
    ]);

    await ownerClient.mutation(api.conversations.setPrivacyBySessionId, {
      session_id: "sess-react-1",
      is_private: true,
    });
    await t.finishAllScheduledFunctions(() => jest.runAllTimers());

    const lockedHeads = await teammateClient.query(api.syncLog.getHeads, {
      scopes: [`session:${setup.conv}`],
    });
    expect(lockedHeads.heads).toEqual([]);
    const lockedRange = await teammateClient.query(api.syncLog.getRange, {
      scope_key: `session:${setup.conv}`,
      from: 0,
      limit: 20,
    });
    expect(lockedRange.authorized).toBe(false);

    const actionsAfterLock = await t.run(async (ctx) => {
      return await ctx.db.query("sync_actions").collect();
    });
    expect(
      actionsAfterLock.some(
        (a) =>
          a.scope_key === `session:${setup.conv}` &&
          a.entity_id === String(task.id) &&
          a.op === "delete",
      ),
    ).toBe(true);
    expect(
      actionsAfterLock.some(
        (a) =>
          a.scope_key === `team:${setup.team}` &&
          a.entity_id === String(task.id) &&
          a.op === "delete",
      ),
    ).toBe(true);

    const countBeforeUpdate = actionsAfterLock.filter(
      (a) =>
        a.scope_key === `session:${setup.conv}` ||
        a.scope_key === `team:${setup.team}`,
    ).length;

    await ownerClient.mutation(api.tasks.webUpdate, {
      short_id: task.short_id,
      title: "Private follow-up edit",
    });
    await t.finishAllScheduledFunctions(() => jest.runAllTimers());

    const actionsAfterFollowUp = await t.run(async (ctx) => {
      return await ctx.db.query("sync_actions").collect();
    });
    const countAfterUpdate = actionsAfterFollowUp.filter(
      (a) =>
        a.scope_key === `session:${setup.conv}` ||
        a.scope_key === `team:${setup.team}`,
    ).length;
    expect(countAfterUpdate).toBe(countBeforeUpdate);
    expect(
      actionsAfterFollowUp.some(
        (a) =>
          a.scope_key === `user:${setup.owner}` &&
          a.entity_id === String(task.id) &&
          a.op === "upsert" &&
          a.patch?.title === "Private follow-up edit",
      ),
    ).toBe(true);
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
