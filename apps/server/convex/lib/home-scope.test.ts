import { afterEach, describe, expect, jest, test } from "bun:test";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { makeChangeTrackedDb } from "../changeLog";
import { patchConversationVisibility } from "../lib/conversationVisibility";
import { projectAction, scopesForChange } from "../syncLog";
import { asUser, serverTest } from "../../test-helpers/database.testkit";
import { fixtureRows } from "../../test-helpers/rows.testkit";
import { computeHomeScope as reexportedComputeHomeScope } from "./access";
import { computeHomeScope, computeHomeScopeDb } from "./accessKeys";
import { derivedHomeScope } from "./homeScopeDerivation";

afterEach(() => {
  jest.useRealTimers();
});

const U1 = "user_001" as Id<"users">;
const U2 = "user_002" as Id<"users">;
const T1 = "team_001" as Id<"teams">;
const P1 = "proj_001" as Id<"projects">;
const C1 = "conv_001" as Id<"conversations">;
const C2 = "conv_002" as Id<"conversations">;
const CH1 = "chan_001" as Id<"chat_channels">;

describe("computeHomeScope", () => {
  test("re-exports helper through convex/lib/access.ts", () => {
    expect(reexportedComputeHomeScope).toBe(computeHomeScope);
  });

  test("returns channel:<id> whenever channel_id is present", () => {
    expect(
      computeHomeScope({
        user_id: U1,
        team_id: T1,
        project_id: P1,
        channel_id: CH1,
      }),
    ).toBe(`channel:${CH1}`);
  });

  test("returns project:<id> for team-accessible records with project_id", () => {
    expect(
      computeHomeScope({
        user_id: U1,
        team_id: T1,
        workspace: `team:${T1}`,
        project_id: P1,
        created_from_conversation_id: C1,
      }),
    ).toBe(`project:${P1}`);
  });

  test("returns dir:<team> for team-accessible records linked to a conversation without project_id", () => {
    expect(
      computeHomeScope({
        user_id: U1,
        team_id: T1,
        workspace: `team:${T1}`,
        created_from_conversation_id: C1,
      }),
    ).toBe(`dir:${T1}`);

    expect(
      computeHomeScope({
        user_id: U1,
        team_id: T1,
        workspace: `team:${T1}`,
        related_conversation_ids: [C2],
      }),
    ).toBe(`dir:${T1}`);
  });

  test("returns dir:<team> for team-accessible records with neither project nor conversation", () => {
    expect(
      computeHomeScope({
        user_id: U1,
        team_id: T1,
        workspace: `team:${T1}`,
      }),
    ).toBe(`dir:${T1}`);
  });

  test("returns user:<id> for personal and private-in-team records regardless of project or conversation", () => {
    expect(
      computeHomeScope({
        user_id: U1,
        workspace: `user:${U1}`,
        project_id: P1,
        created_from_conversation_id: C1,
      }),
    ).toBe(`user:${U1}`);

    expect(
      computeHomeScope(
        {
          user_id: U1,
          team_id: T1,
          project_id: P1,
          created_from_conversation_id: C1,
        },
        {
          team_id: T1,
          is_private: true,
        },
      ),
    ).toBe(`user:${U1}`);
  });

  test("computeHomeScopeDb resolves linked conversation access from db", async () => {
    const t = serverTest();
    await t.run(async (ctx) => {
      const rows = fixtureRows(ctx.db, "home-scope-db");
      const owner = await rows.user({ name: "Owner" });
      const team = await rows.team({ name: "Team" });
      const privateConv = await rows.conversation(owner, {
        team_id: team,
        is_private: true,
      });
      const sharedConv = await rows.conversation(owner, {
        team_id: team,
        is_private: false,
        team_visibility: "full",
      });
      expect(
        await computeHomeScopeDb(ctx, {
          user_id: owner,
          team_id: team,
          created_from_conversation_id: privateConv,
        }),
      ).toBe(`user:${owner}`);
      expect(
        await computeHomeScopeDb(ctx, {
          user_id: owner,
          team_id: team,
          created_from_conversation_id: sharedConv,
        }),
      ).toBe(`dir:${team}`);

      let gets = 0;
      const countingCtx = {
        db: {
          ...ctx.db,
          get: async (...args: any[]) => {
            gets++;
            return await (ctx.db.get as any)(...args);
          },
        },
      };
      expect(
        await computeHomeScopeDb(countingCtx, {
          user_id: owner,
          team_id: team,
          workspace: `team:${team}`,
          created_from_conversation_id: sharedConv,
        }),
      ).toBe(`dir:${team}`);
      expect(gets).toBe(0);
    });
  });
});

describe("scopesForChange", () => {
  test("routes team-workspace work to home_scope or dir:<team> without team:<id> fan-out", () => {
    expect(
      scopesForChange("tasks", {
        owner_user_id: U1,
        workspace: `team:${T1}`,
        home_scope: `project:${P1}`,
      }),
    ).toEqual([`user:${U1}`, `project:${P1}`]);

    expect(
      scopesForChange("docs", {
        owner_user_id: U2,
        workspace: `team:${T1}`,
        home_scope: `dir:${T1}`,
      }),
    ).toEqual([`user:${U2}`, `dir:${T1}`]);

    expect(
      scopesForChange("plans", {
        owner_user_id: U1,
        workspace: `team:${T1}`,
        home_scope: `project:${P1}`,
      }),
    ).toEqual([`user:${U1}`, `project:${P1}`]);

    expect(
      scopesForChange("docs", {
        owner_user_id: U1,
        workspace: `team:${T1}`,
        home_scope: `channel:${CH1}`,
      }),
    ).toEqual([`user:${U1}`, `channel:${CH1}`]);

    expect(
      scopesForChange("projects", {
        owner_user_id: U1,
        workspace: `team:${T1}`,
      }),
    ).toEqual([`user:${U1}`, `dir:${T1}`]);
  });

  test("never fans a personal workspace row into shared home scopes", () => {
    expect(
      scopesForChange("tasks", {
        owner_user_id: U1,
        workspace: `user:${U1}`,
        home_scope: `project:${P1}`,
      }),
    ).toEqual([`user:${U1}`]);

    expect(
      scopesForChange("tasks", {
        owner_user_id: U1,
        workspace: `user:${U1}`,
        home_scope: `user:${U1}`,
      }),
    ).toEqual([`user:${U1}`]);
  });
});

describe("write-time home_scope and interest-scope sync_actions emission", () => {
  test("stamps home_scope for tasks, plans, docs, and chat_messages and writes sync_actions without team fan-out", async () => {
    jest.useFakeTimers();
    const t = serverTest();
    const setup = await t.run(async (ctx) => {
      const rows = fixtureRows(ctx.db, "flag-on");
      const user = await rows.user({ name: "Bob" });
      const team = await rows.team({
        name: "Beta",
        features: { chat: true },
      });
      await rows.membership(user, team);
      const p1 = await ctx.db.insert("projects", {
        user_id: user,
        team_id: team,
        workspace: `team:${team}`,
        title: "P1",
        status: "active",
        created_at: 1,
        updated_at: 1,
      });
      const p2 = await ctx.db.insert("projects", {
        user_id: user,
        team_id: team,
        workspace: `team:${team}`,
        title: "P2",
        status: "active",
        created_at: 1,
        updated_at: 1,
      });
      const channel = await ctx.db.insert("chat_channels", {
        team_id: team,
        name: "engineering",
        kind: "public",
        workspace: `team:${team}`,
        created_by: user,
        created_at: 1,
        updated_at: 1,
      });
      const preFlagDoc = await rows.doc(user, {
        team_id: team,
        workspace: `team:${team}`,
        project_id: p1,
        title: "Legacy doc",
      });
      const privConv = await rows.conversation(user, {
        team_id: team,
        is_private: true,
      });
      const convTask = await rows.task(user, {
        team_id: team,
        created_from_conversation: privConv,
        workspace: `user:${user}`,
        home_scope: `user:${user}`,
      });
      return { user, team, p1, p2, channel, preFlagDoc, privConv, convTask };
    });

    const client = asUser(t, setup.user);
    const teamTask = await client.mutation(api.tasks.webCreate, {
      title: "Team task",
      workspace: "team",
      team_id: setup.team,
      project_id: setup.p1,
    });
    const personalTask = await client.mutation(api.tasks.webCreate, {
      title: "Personal task",
      workspace: "personal",
    });
    const teamPlan = await client.mutation(api.plans.webCreate, {
      title: "Team plan",
      workspace: "team",
      team_id: setup.team,
    });
    const teamDoc = await client.mutation(api.docs.webCreate, {
      title: "Team doc",
      workspace: "team",
      team_id: setup.team,
    });
    await client.mutation(api.docs.webUpdate, {
      id: setup.preFlagDoc,
      title: "Legacy doc updated",
    });
    const messageResult = await client.mutation(api.chat.sendMessage, {
      channel_id: setup.channel,
      content: "hello on",
    });
    const replyResult = await client.mutation(api.chat.sendMessage, {
      channel_id: setup.channel,
      thread_root_id: messageResult.message_id,
      content: "thread reply on",
    });
    const voiceResult = await client.mutation(api.chat.startVoiceBurst, {
      channel_id: setup.channel,
      room_key: "room-on-1",
    });
    await client.mutation(api.tasks.webUpdate, {
      short_id: teamTask.short_id,
      project_id: setup.p2,
    });
    await t.finishAllScheduledFunctions(() => jest.runAllTimers());

    await t.run(async (ctx) => {
      const task = await ctx.db.get(teamTask.id);
      const pTask = await ctx.db.get(personalTask.id);
      const plan = await ctx.db.get(teamPlan.id);
      const doc = await ctx.db.get(teamDoc.id);
      const patchedDoc = await ctx.db.get(setup.preFlagDoc);
      const msg = await ctx.db.get(messageResult.message_id);
      const replyMsg = await ctx.db.get(replyResult.message_id);
      const voiceMsg = await ctx.db.get(voiceResult.message_id);

      expect(task?.home_scope).toBe(`project:${setup.p2}`);
      expect(pTask?.home_scope).toBe(`user:${setup.user}`);
      expect(plan?.home_scope).toBe(`dir:${setup.team}`);
      expect(doc?.home_scope).toBe(`dir:${setup.team}`);
      expect(patchedDoc?.home_scope).toBe(`project:${setup.p1}`);
      expect(msg?.home_scope).toBe(`channel:${setup.channel}`);
      expect(replyMsg?.home_scope).toBe(`channel:${setup.channel}`);
      expect(voiceMsg?.home_scope).toBe(`channel:${setup.channel}`);

      const actions = await ctx.db.query("sync_actions").collect();
      const taskP1 = actions.filter(
        (a) =>
          a.scope_key === `project:${setup.p1}` &&
          a.entity_id === String(teamTask.id),
      );
      const taskP2 = actions.filter(
        (a) =>
          a.scope_key === `project:${setup.p2}` &&
          a.entity_id === String(teamTask.id),
      );
      const taskTeam = actions.filter(
        (a) =>
          a.scope_key === `team:${setup.team}` &&
          a.entity_id === String(teamTask.id),
      );
      expect(taskP1.some((a) => a.op === "delete")).toBe(true);
      expect(taskP2.some((a) => a.op === "upsert")).toBe(true);
      expect(taskTeam).toHaveLength(0);

      expect(
        actions.some(
          (a) =>
            a.scope_key === `dir:${setup.team}` &&
            a.entity_id === String(teamPlan.id) &&
            a.op === "upsert",
        ),
      ).toBe(true);
      expect(
        actions.some(
          (a) =>
            a.scope_key === `project:${setup.p1}` &&
            a.entity_id === String(setup.preFlagDoc) &&
            a.op === "upsert" &&
            a.patch?.home_scope === `project:${setup.p1}`,
        ),
      ).toBe(true);
      expect(
        actions.some(
          (a) =>
            a.entity_id === String(personalTask.id) &&
            a.scope_key !== `user:${setup.user}`,
        ),
      ).toBe(false);

      const conv = await ctx.db.get(setup.privConv);
      await patchConversationVisibility({ db: ctx.db } as any, conv!, {
        is_private: false,
        team_visibility: "full",
      });
      const recomputedTask = await ctx.db.get(setup.convTask);
      expect(recomputedTask?.workspace).toBe(`team:${setup.team}`);
      expect(recomputedTask?.home_scope).toBe(`dir:${setup.team}`);

      const trackedDb = makeChangeTrackedDb(ctx.db);
      const replaceSource = await ctx.db.get(teamTask.id);
      const { _id, _creationTime, ...rest } = replaceSource!;
      await trackedDb.replace(teamTask.id, {
        ...rest,
        project_id: setup.p1,
        home_scope: `project:${setup.p2}`,
      });
      const replacedTask = await ctx.db.get(teamTask.id);
      expect(replacedTask?.home_scope).toBe(`project:${setup.p1}`);
      const actionsAfterReplace = await ctx.db.query("sync_actions").collect();
      expect(
        actionsAfterReplace.some(
          (a) =>
            a.scope_key === `project:${setup.p2}` &&
            a.entity_id === String(teamTask.id) &&
            a.op === "delete",
        ),
      ).toBe(true);
      expect(
        actionsAfterReplace.some(
          (a) =>
            a.scope_key === `project:${setup.p1}` &&
            a.entity_id === String(teamTask.id) &&
            a.op === "upsert" &&
            a.patch?.home_scope === `project:${setup.p1}`,
        ),
      ).toBe(true);
    });
  });

  test("syncOutbox.getReceipts enforces heldKeys and canReadSyncScope", async () => {
    const t = serverTest();
    const setup = await t.run(async (ctx) => {
      const rows = fixtureRows(ctx.db, "outbox-receipts");
      const member = await rows.user({ name: "Member" });
      const outsider = await rows.user({ name: "Outsider" });
      const team = await rows.team({ name: "OutboxTeam" });
      await rows.membership(member, team);
      const teamProj = await ctx.db.insert("projects", {
        user_id: member,
        team_id: team,
        workspace: `team:${team}`,
        title: "Accessible project",
        status: "active",
        created_at: 1,
        updated_at: 1,
      });
      const privProj = await ctx.db.insert("projects", {
        user_id: outsider,
        workspace: `user:${outsider}`,
        title: "Foreign project",
        status: "active",
        created_at: 1,
        updated_at: 1,
      });

      const insertSlot = async (
        scope_key: string,
        entity_id: string,
        position: number,
        delivered_revision: number,
      ) =>
        await ctx.db.insert("sync_outbox", {
          scope_key,
          entity_type: "tasks",
          entity_id,
          revision: delivered_revision,
          delivered_revision,
          position,
          pending: false,
          updated_at: 1,
          op: "upsert",
        });

      const teamSlot = await insertSlot(`team:${team}`, "e-team", 10, 2);
      const dirSlot = await insertSlot(`dir:${team}`, "e-dir", 11, 3);
      const projSlot = await insertSlot(`project:${teamProj}`, "e-proj", 12, 4);
      const privProjSlot = await insertSlot(
        `project:${privProj}`,
        "e-priv",
        13,
        5,
      );
      const sessionSlot = await insertSlot("session:conv_any", "e-sess", 14, 6);

      return {
        member,
        outsider,
        team,
        teamProj,
        teamSlot,
        dirSlot,
        projSlot,
        privProjSlot,
        sessionSlot,
      };
    });

    const memberClient = asUser(t, setup.member);
    const outsiderClient = asUser(t, setup.outsider);
    const request = [
      { id: setup.teamSlot, revision: 1 },
      { id: setup.dirSlot, revision: 1 },
      { id: setup.projSlot, revision: 1 },
      { id: setup.privProjSlot, revision: 1 },
      { id: setup.sessionSlot, revision: 1 },
    ];

    const memberOn = await memberClient.query(api.syncOutbox.getReceipts, {
      receipts: request,
    });
    expect(memberOn).toEqual([
      {
        id: setup.teamSlot,
        revision: 2,
        scope_key: `team:${setup.team}`,
        position: 10,
      },
      {
        id: setup.dirSlot,
        revision: 3,
        scope_key: `dir:${setup.team}`,
        position: 11,
      },
      {
        id: setup.projSlot,
        revision: 4,
        scope_key: `project:${setup.teamProj}`,
        position: 12,
      },
      { id: setup.privProjSlot, revision: 1, revoked: true },
      { id: setup.sessionSlot, revision: 1, revoked: true },
    ]);

    const outsiderOn = await outsiderClient.query(api.syncOutbox.getReceipts, {
      receipts: request.slice(0, 3),
    });
    expect(outsiderOn).toEqual([
      { id: setup.teamSlot, revision: 1, revoked: true },
      { id: setup.dirSlot, revision: 1, revoked: true },
      { id: setup.projSlot, revision: 1, revoked: true },
    ]);
  });

  test("a write to a home scope field carries home_scope even when it does not change", async () => {
    jest.useFakeTimers();
    const t = serverTest();
    const setup = await t.run(async (ctx) => {
      const rows = fixtureRows(ctx.db, "home-kept");
      const user = await rows.user({ name: "Kai" });
      const team = await rows.team({ name: "Gamma" });
      await rows.membership(user, team);
      const project = await ctx.db.insert("projects", {
        user_id: user,
        team_id: team,
        workspace: `team:${team}`,
        title: "P",
        status: "active",
        created_at: 1,
        updated_at: 1,
      });
      const conv = await rows.conversation(user, { team_id: team });
      const task = await rows.task(user, {
        team_id: team,
        workspace: `team:${team}`,
        project_id: project,
        home_scope: `project:${project}`,
      });
      return { team, project, conv, task };
    });
    await t.run(async (ctx) => {
      await makeChangeTrackedDb(ctx.db).patch(setup.task, {
        conversation_ids: [setup.conv],
      });
    });
    await t.finishAllScheduledFunctions(() => jest.runAllTimers());
    await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("sync_actions")
        .withIndex("by_scope_entity", (q: any) =>
          q
            .eq("scope_key", `project:${setup.project}`)
            .eq("entity_id", String(setup.task)),
        )
        .collect();
      const latest = rows.sort((a: any, b: any) => b.position - a.position)[0];
      expect(latest?.patch?.home_scope).toBe(`project:${setup.project}`);
      const shipped = projectAction(latest, undefined, true).patch ?? {};
      expect(
        shipped.home_scope ??
          derivedHomeScope("tasks", shipped, latest.access_key),
      ).toBe(`project:${setup.project}`);
    });
  });

  test("projectAction strips redundant home_scope and keeps differing overrides", () => {
    const redundant = projectAction(
      {
        position: 1,
        entity_type: "docs",
        entity_id: "d1",
        op: "upsert",
        access_owner: "u1",
        access_key: "user:u1",
        patch: { title: "A", workspace: "user:u1", home_scope: "user:u1" },
      },
      undefined,
      true,
    );
    expect(redundant.patch).toEqual({ title: "A", workspace: "user:u1" });

    const teamProject = projectAction(
      {
        position: 2,
        entity_type: "tasks",
        entity_id: "t1",
        op: "upsert",
        access_owner: "u1",
        access_key: "team:T",
        patch: { project_id: "P", home_scope: "project:P" },
      },
      undefined,
      true,
    );
    expect(teamProject.patch).toEqual({ project_id: "P" });

    const channelOverride = projectAction(
      {
        position: 3,
        entity_type: "tasks",
        entity_id: "t2",
        op: "upsert",
        access_owner: "u1",
        access_key: "team:T",
        patch: { channel_id: "CH", home_scope: "channel:CH" },
      },
      undefined,
      true,
    );
    expect(channelOverride.patch).toEqual({
      channel_id: "CH",
      home_scope: "channel:CH",
    });

    const noRoutingField = projectAction(
      {
        position: 4,
        entity_type: "tasks",
        entity_id: "t3",
        op: "upsert",
        access_owner: "u1",
        access_key: "team:T",
        patch: { title: "B", home_scope: "dir:T" },
      },
      undefined,
      true,
    );
    expect(noRoutingField.patch).toEqual({ title: "B", home_scope: "dir:T" });
  });
});
