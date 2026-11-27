import { afterEach, describe, expect, jest, test } from "bun:test";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { makeChangeTrackedDb } from "../changeLog";
import { patchConversationVisibility } from "../lib/conversationVisibility";
import { scopesForChange } from "../syncLog";
import { asUser, serverTest } from "../../test-helpers/database.testkit";
import { fixtureRows } from "../../test-helpers/rows.testkit";
import {
  computeHomeScope as reexportedComputeHomeScope,
  interestScopesEnabled as reexportedInterestScopesEnabled,
} from "./access";
import {
  computeHomeScope,
  computeHomeScopeDb,
  interestScopesEnabled,
} from "./accessKeys";

const PREVIOUS_FLAG = process.env.SWARM_INTEREST_SCOPES;

afterEach(() => {
  jest.useRealTimers();
  if (PREVIOUS_FLAG === undefined) {
    delete process.env.SWARM_INTEREST_SCOPES;
  } else {
    process.env.SWARM_INTEREST_SCOPES = PREVIOUS_FLAG;
  }
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
    expect(reexportedInterestScopesEnabled).toBe(interestScopesEnabled);
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

  test("returns session:<id> for team-accessible records linked to a conversation without project_id", () => {
    expect(
      computeHomeScope({
        user_id: U1,
        team_id: T1,
        workspace: `team:${T1}`,
        created_from_conversation_id: C1,
      }),
    ).toBe(`session:${C1}`);

    expect(
      computeHomeScope({
        user_id: U1,
        team_id: T1,
        workspace: `team:${T1}`,
        related_conversation_ids: [C2],
      }),
    ).toBe(`session:${C2}`);
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
      ).toBe(`session:${sharedConv}`);

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
      ).toBe(`session:${sharedConv}`);
      expect(gets).toBe(0);
    });
  });
});

describe("scopesForChange", () => {
  test("keeps team-only emission when SWARM_INTEREST_SCOPES is off", () => {
    delete process.env.SWARM_INTEREST_SCOPES;
    expect(interestScopesEnabled()).toBe(false);
    expect(
      scopesForChange("tasks", {
        owner_user_id: U2,
        workspace: `team:${T1}`,
        home_scope: `project:${P1}`,
      }),
    ).toEqual([`user:${U2}`, `team:${T1}`]);
  });

  test("dual-writes home_scope alongside team scope when SWARM_INTEREST_SCOPES is on", () => {
    process.env.SWARM_INTEREST_SCOPES = "1";
    expect(interestScopesEnabled()).toBe(true);
    expect(
      scopesForChange("tasks", {
        owner_user_id: U1,
        workspace: `team:${T1}`,
        home_scope: `project:${P1}`,
      }),
    ).toEqual([`user:${U1}`, `team:${T1}`, `project:${P1}`]);

    expect(
      scopesForChange("docs", {
        owner_user_id: U2,
        workspace: `team:${T1}`,
        home_scope: `dir:${T1}`,
      }),
    ).toEqual([`user:${U2}`, `team:${T1}`, `dir:${T1}`]);

    expect(
      scopesForChange("plans", {
        owner_user_id: U1,
        workspace: `team:${T1}`,
        home_scope: `session:${C1}`,
      }),
    ).toEqual([`user:${U1}`, `team:${T1}`, `session:${C1}`]);

    expect(
      scopesForChange("docs", {
        owner_user_id: U1,
        workspace: `team:${T1}`,
        home_scope: `channel:${CH1}`,
      }),
    ).toEqual([`user:${U1}`, `team:${T1}`, `channel:${CH1}`]);
  });

  test("never fans a personal workspace row into shared home scopes", () => {
    process.env.SWARM_INTEREST_SCOPES = "1";
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

describe("write-time home_scope and dual-write behind SWARM_INTEREST_SCOPES", () => {
  test("writes behave identically without home_scope when flag is off", async () => {
    delete process.env.SWARM_INTEREST_SCOPES;
    jest.useFakeTimers();
    const t = serverTest();
    const setup = await t.run(async (ctx) => {
      const rows = fixtureRows(ctx.db, "flag-off");
      const user = await rows.user({ name: "Alice" });
      const team = await rows.team({
        name: "Alpha",
        features: { chat: true },
      });
      await rows.membership(user, team);
      const project = await ctx.db.insert("projects", {
        user_id: user,
        team_id: team,
        workspace: `team:${team}`,
        title: "Core",
        status: "active",
        created_at: 1,
        updated_at: 1,
      });
      const channel = await ctx.db.insert("chat_channels", {
        team_id: team,
        name: "general",
        kind: "public",
        workspace: `team:${team}`,
        created_by: user,
        created_at: 1,
        updated_at: 1,
      });
      return { user, team, project, channel };
    });

    const client = asUser(t, setup.user);
    const createdTask = await client.mutation(api.tasks.webCreate, {
      title: "Off task",
      workspace: "team",
      team_id: setup.team,
      project_id: setup.project,
    });
    const createdPlan = await client.mutation(api.plans.webCreate, {
      title: "Off plan",
      workspace: "team",
      team_id: setup.team,
    });
    const createdDoc = await client.mutation(api.docs.webCreate, {
      title: "Off doc",
      workspace: "team",
      team_id: setup.team,
    });
    const messageResult = await client.mutation(api.chat.sendMessage, {
      channel_id: setup.channel,
      content: "hello off",
    });
    await t.finishAllScheduledFunctions(() => jest.runAllTimers());

    await t.run(async (ctx) => {
      const task = await ctx.db.get(createdTask.id);
      const plan = await ctx.db.get(createdPlan.id);
      const doc = await ctx.db.get(createdDoc.id);
      const msg = await ctx.db.get(messageResult.message_id);
      expect(task?.home_scope).toBeUndefined();
      expect(plan?.home_scope).toBeUndefined();
      expect(doc?.home_scope).toBeUndefined();
      expect(msg?.home_scope).toBeUndefined();
      const actions = await ctx.db.query("sync_actions").collect();
      expect(
        actions.some(
          (a) =>
            a.scope_key === `team:${setup.team}` &&
            a.entity_id === String(createdTask.id),
        ),
      ).toBe(true);
      expect(
        actions.some(
          (a) =>
            a.scope_key.startsWith("project:") ||
            a.scope_key.startsWith("dir:") ||
            a.scope_key.startsWith("session:") ||
            a.scope_key.startsWith("channel:"),
        ),
      ).toBe(false);
    });
  });

  test("stamps home_scope for tasks, plans, docs, and chat_messages and dual-writes sync_actions when flag is on", async () => {
    process.env.SWARM_INTEREST_SCOPES = "1";
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

      expect(task?.home_scope).toBe(`project:${setup.p2}`);
      expect(pTask?.home_scope).toBe(`user:${setup.user}`);
      expect(plan?.home_scope).toBe(`dir:${setup.team}`);
      expect(doc?.home_scope).toBe(`dir:${setup.team}`);
      expect(patchedDoc?.home_scope).toBe(`project:${setup.p1}`);
      expect(msg?.home_scope).toBe(`channel:${setup.channel}`);

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
      expect(taskTeam.some((a) => a.op === "upsert")).toBe(true);

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
      expect(recomputedTask?.home_scope).toBe(`session:${setup.privConv}`);

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
});
