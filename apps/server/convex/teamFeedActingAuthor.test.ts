// A role seat's session renders under its bot on the team feed, and the row
// says so with acting_user_id at every visibility level. The people pills key
// on acting_user_id ?? user_id, so a full row without it files the seat under
// its host and names the host's pill after the role ("Paid" for Ashot).
import { describe, expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import schema from "./schema";

const modules = {
  "./_generated/server.ts": () => import("./_generated/server"),
  "./syncOutbox.ts": () => import("./syncOutbox"),
  "./cliFeed.ts": () => import("./cliFeed"),
  "./cliInbox.ts": () => import("./cliInbox"),
  "./cliSearch.ts": () => import("./cliSearch"),
  "./cliSessionActions.ts": () => import("./cliSessionActions"),
  "./conversationExport.ts": () => import("./conversationExport"),
  "./conversationFavorites.ts": () => import("./conversationFavorites"),
  "./conversationFeeds.ts": () => import("./conversationFeeds"),
  "./conversationForks.ts": () => import("./conversationForks"),
  "./conversationLifecycle.ts": () => import("./conversationLifecycle"),
  "./conversationList.ts": () => import("./conversationList"),
  "./conversationLookup.ts": () => import("./conversationLookup"),
  "./conversationMessages.ts": () => import("./conversationMessages"),
  "./conversationMetadata.ts": () => import("./conversationMetadata"),
  "./conversationNav.ts": () => import("./conversationNav"),
  "./conversationPrivacy.ts": () => import("./conversationPrivacy"),
  "./conversationProjects.ts": () => import("./conversationProjects"),
  "./conversationReads.ts": () => import("./conversationReads"),
  "./conversationSharing.ts": () => import("./conversationSharing"),
  "./conversationStatus.ts": () => import("./conversationStatus"),
  "./conversationTrees.ts": () => import("./conversationTrees"),
  "./inboxLists.ts": () => import("./inboxLists"),
  "./inboxLiveness.ts": () => import("./inboxLiveness"),
  "./inboxShelves.ts": () => import("./inboxShelves"),
  "./sessionControl.ts": () => import("./sessionControl"),
  "./sessionHierarchy.ts": () => import("./sessionHierarchy"),
  "./sessionRestart.ts": () => import("./sessionRestart"),
  "./sessionSearch.ts": () => import("./sessionSearch"),
  "./sessionThreadState.ts": () => import("./sessionThreadState"),
};

describe("team feed acting author", () => {
  test("a full-visibility seat row carries the bot as acting_user_id", async () => {
    const t = convexTest(schema, modules);
    const { viewer, bot, team, seat, own } = await t.run(async (ctx) => {
      const now = Date.now();
      const viewer = await ctx.db.insert("users", {
        name: "Ashot Petrosian",
        email: "a@x.com",
      } as any);
      const bot = await ctx.db.insert("users", {
        name: "Paid Ads lead",
        email: "bot@x.com",
      } as any);
      const team = await ctx.db.insert("teams", {
        name: "T",
        invite_code: "t",
        created_at: now,
      } as any);
      await ctx.db.insert("team_memberships", {
        team_id: team,
        user_id: viewer,
        role: "member",
        joined_at: 0,
        visibility: "full",
      } as any);
      await ctx.db.patch(viewer, {
        team_id: team,
        active_team_id: team,
      } as any);
      const conv = (extra: Record<string, unknown>) =>
        ctx.db.insert("conversations", {
          user_id: viewer,
          agent_type: "claude_code",
          status: "active",
          message_count: 3,
          is_private: false,
          team_id: team,
          project_path: "/Users/a/src/repo",
          subtitle: "",
          idle_summary: "",
          started_at: now - 9000,
          ...extra,
        } as any);
      const seat = await conv({
        session_id: "seat",
        title: "Paid ads pass",
        acting_user_id: bot,
        updated_at: now - 100,
      });
      const own = await conv({
        session_id: "own",
        title: "Fix the feed",
        updated_at: now - 200,
      });
      return { viewer, bot, team, seat: String(seat), own: String(own) };
    });
    const r = await t
      .withIdentity({ subject: `${viewer}|test` })
      .query(anyApi.conversationList.listConversations, {
        filter: "team",
        activeTeamId: team,
        include_message_previews: true,
      });
    const byId = new Map(r.conversations.map((c: any) => [String(c._id), c]));
    expect(byId.get(seat)).toMatchObject({
      visibility_mode: "full",
      acting_user_id: bot,
      author_name: "Paid Ads lead",
    });
    expect(byId.get(own)).toMatchObject({
      acting_user_id: null,
      author_name: "Ashot Petrosian",
    });
  });
});
