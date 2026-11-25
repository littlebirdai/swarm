import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { asUser, serverTest } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { api } from "./_generated/api";

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test.each(["path", "project hash"] as const)(
  "deleting by %s purges the conversation's related rows",
  async (mode) => {
    const t = serverTest();
    const { user, conversation, claim } = await t.run(async ({ db }) => {
      const fixtures = fixtureRows(db, "conversation-row-purge");
      const user = await fixtures.user();
      const conversation = await fixtures.conversation(user, {
        git_root: "/projects/purge",
        project_hash: "project-hash",
      });
      const claim = await db.insert("claims", {
        conversation_id: conversation,
        kind: "steer",
        holder: user,
        token: 5,
        lease_until: Date.now() + 30_000,
        request_id: "claim",
        request_holder: user,
      });
      return { user, conversation, claim };
    });
    const owner = asUser(t, user);
    if (mode === "path") {
      expect(
        await owner.mutation(api.users.deleteConversationsForPath, {
          path_prefix: "/projects/purge",
        }),
      ).toMatchObject({ conversationsDeleted: 1 });
    } else {
      expect(
        await owner.mutation(api.conversations.deleteByProjectHash, {
          project_hash: "project-hash",
        }),
      ).toMatchObject({ deleted: 1 });
    }
    expect(await t.run(({ db }) => db.get(conversation))).toBeNull();
    await t.finishAllScheduledFunctions(() => jest.runAllTimers());
    expect(await t.run(({ db }) => db.get(claim))).toBeNull();
  },
);
