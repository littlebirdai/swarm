import { expect, test, setDefaultTimeout } from "bun:test";
import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import schema from "./schema";

setDefaultTimeout(60_000);

const markCompleted = makeFunctionReference<"mutation">(
  "conversationStatus:markSessionCompleted",
);
const modules = {
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
  "./_generated/server.ts": () => import("./_generated/server"),
  "./syncOutbox.ts": () => import("./syncOutbox"),
};

test("an agent stopped by its own move in flight is not ended; once the fence is off, an exit ends it", async () => {
  const t = convexTest(schema, modules);
  const { user, conv } = await t.run(async (ctx) => {
    const user = await ctx.db.insert("users", {});
    const conv = await ctx.db.insert("conversations", {
      user_id: user,
      session_id: "s1",
      agent_type: "claude_code",
      status: "active",
      is_private: true,
      message_count: 1,
      started_at: Date.now(),
      updated_at: Date.now(),
      migration: {
        batch_id: "mg-x",
        migration_id: "m1",
        to_device_id: "box",
        started_at: Date.now(),
      } as any,
    });
    return { user, conv };
  });
  const authed = t.withIdentity({ subject: user });
  await authed.mutation(markCompleted, { conversation_id: conv });
  expect((await t.run((ctx) => ctx.db.get(conv)))?.status).toBe("active");
  await t.run((ctx) => ctx.db.patch(conv, { migration: undefined }));
  await authed.mutation(markCompleted, { conversation_id: conv });
  expect((await t.run((ctx) => ctx.db.get(conv)))?.status).toBe("completed");
});
