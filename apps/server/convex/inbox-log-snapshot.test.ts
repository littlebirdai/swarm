import { expect, test } from "bun:test";
import { api, internal } from "./_generated/api";
import { asUser, serverTest } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";

test("only the authenticated snapshot opt-in returns the caller's log checkpoint", async () => {
  const t = serverTest();
  const { viewer, id } = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "inbox-log-snapshot");
    const viewer = await rows.user();
    const now = Date.now();
    const id = await rows.conversation(viewer, {
      title: "Before",
      started_at: now,
      updated_at: now,
      message_count: 1,
    });
    return { viewer, id };
  });
  const query = api.conversations.listInboxSessions;
  expect(await t.query(query, { checkpoint: true })).toEqual({
    sessions: [],
    hidden_count: 0,
    truncated: [],
  });
  const owner = asUser(t, viewer);
  const args = { include_liveness: false, fast_fields_in_overlay: true };
  expect(await owner.query(query, args)).not.toHaveProperty("checkpoint");

  await t.mutation(internal.titleGeneration.setTitleAndSubtitle, {
    conversation_id: id,
    title: "After",
  });
  const slot = await t.run(({ db }) => db.query("sync_outbox").first());
  expect(slot).not.toBeNull();
  await t.mutation(internal.syncOutbox.drain, { id: slot!._id });
  const heads = await owner.query(api.syncLog.getHeads, {});
  const head = heads.heads.find(
    ({ scope_key }) => scope_key === `user:${viewer}`,
  );
  expect(head?.position).toBeGreaterThan(0);
  expect(await owner.query(query, { ...args, checkpoint: true })).toMatchObject(
    {
      sessions: [expect.objectContaining({ _id: id, title: "After" })],
      checkpoint: { scope: `user:${viewer}`, position: head?.position },
    },
  );
});
