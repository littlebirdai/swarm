import { describe, expect, test } from "bun:test";
import { asUser, serverTest } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { GALLERY_LIMIT } from "./artifacts";

describe("listForWeb workspace scoping", () => {
  test("stamps each page's workspace and keeps teammates' pages to shared teams", async () => {
    const t = serverTest();
    const { owner, mate, shared } = await t.run(async ({ db, storage }) => {
      const rows = fixtureRows(db, "gallery workspace");
      const owner = await rows.user();
      const mate = await rows.user();
      const shared = await rows.team();
      const other = await rows.team();
      const workspace = `team:${shared}`;
      await rows.membership(owner, shared);
      await rows.membership(mate, shared, { visibility: "full" });
      await rows.membership(mate, other, { visibility: "full" });
      const sharedSession = await rows.conversation(mate, {
        team_id: shared,
        team_visibility: "full",
      });
      const otherSession = await rows.conversation(mate, {
        team_id: other,
        team_visibility: "full",
      });
      const privateSession = await rows.conversation(mate, {
        team_id: shared,
        is_private: true,
      });
      const task = await rows.task(mate, { workspace, team_id: shared });
      const blob = await storage.store(new Blob(["page"]));

      await rows.artifact(owner, blob, {
        slug: "mine-team",
        session_conversation_id: sharedSession,
      });
      await rows.artifact(owner, blob, { slug: "mine-solo" });
      await rows.artifact(mate, blob, {
        slug: "mate-shared",
        session_conversation_id: sharedSession,
      });
      await rows.artifact(mate, blob, {
        slug: "mate-task",
        session_conversation_id: otherSession,
        task_id: task,
      });
      await rows.artifact(mate, blob, {
        slug: "mate-other-team",
        session_conversation_id: otherSession,
      });
      await rows.artifact(mate, blob, {
        slug: "mate-private",
        session_conversation_id: privateSession,
      });
      await rows.artifact(mate, blob, { slug: "mate-solo" });
      return { owner, mate, shared };
    });

    const { artifacts } = await asUser(t, owner).query(
      api.artifacts.listForWeb,
      {},
    );
    const got = Object.fromEntries(
      artifacts.map((a) => [a.slug, [a.workspace, a.author_id, a.mine]]),
    );
    expect(got).toEqual({
      "mine-team": [`team:${shared}`, owner, true],
      "mine-solo": [`user:${owner}`, owner, true],
      "mate-shared": [`team:${shared}`, mate, false],
      "mate-task": [`team:${shared}`, mate, false],
    });
  });
});

describe("listForWeb read budget", () => {
  test("an account with thousands of pages stays under Convex's read cap and gets its newest pages", async () => {
    const t = serverTest({ databaseQueries: 4095 });
    const viewer = await t.run(async ({ db, storage }) => {
      const rows = fixtureRows(db, "gallery read budget");
      const team = await rows.team();
      const blob = await storage.store(new Blob(["page"]));
      const owners = [await rows.user(), await rows.user(), await rows.user()];
      for (const [index, owner] of owners.entries()) {
        await rows.membership(owner, team, { visibility: "full" });
        for (let i = 0; i < 2000; i++) {
          const task = await rows.task(owner, {
            workspace: `team:${team}`,
            team_id: team,
          });
          await rows.artifact(owner, blob, {
            slug: `u${index + 1}-p${i}`,
            task_id: task,
            updated_at: i * 3 + (index === 1 ? 1 : 0),
          });
        }
      }
      return owners[0];
    });

    const { artifacts } = await asUser(t, viewer).query(
      api.artifacts.listForWeb,
      {},
    );
    expect(artifacts).toHaveLength(GALLERY_LIMIT);
    expect(artifacts[0].slug).toBe("u2-p1999");
    const times = artifacts.map((a) => a.updated_at);
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });
});

describe("teamEditAuth scope", () => {
  async function setup() {
    const t = serverTest();
    const ids = await t.run(async ({ db, storage }) => {
      const rows = fixtureRows(db, "gallery team edit");
      const owner = await rows.user();
      const mate = await rows.user();
      const other = await rows.user();
      const sharedTeam = await rows.team();
      const otherTeam = await rows.team();
      await rows.membership(owner, sharedTeam, { visibility: "full" });
      await rows.membership(mate, sharedTeam, { visibility: "full" });
      await rows.membership(owner, otherTeam, { visibility: "full" });
      await rows.membership(other, otherTeam, { visibility: "full" });
      const conversation = await rows.conversation(owner, {
        team_id: sharedTeam,
        team_visibility: "full",
      });
      const blob = await storage.store(new Blob(["page"]));
      await rows.artifact(owner, blob, {
        slug: "team-page",
        session_conversation_id: conversation,
        edit_mode: "team",
      });
      await rows.artifact(owner, blob, {
        slug: "solo-page",
        edit_mode: "team",
      });
      return { owner, mate, other };
    });
    const run = (slug: string, editor_user_id: Id<"users">) =>
      t.query(internal.artifacts.teamEditAuth, { slug, editor_user_id });
    return { ...ids, run };
  }

  test("a member of the page's team may edit; a member of the owner's other team may not", async () => {
    const { run, mate, other } = await setup();
    expect((await run("team-page", mate))?.is_owner).toBe(false);
    expect(await run("team-page", other)).toBeNull();
  });

  test("a page in the owner's personal space has no team editors", async () => {
    const { run, owner, mate } = await setup();
    expect(await run("solo-page", mate)).toBeNull();
    expect((await run("solo-page", owner))?.is_owner).toBe(true);
  });
});
