import { formatSessionMessage } from "@codecast/messages/machineMessages";
import { expect, test } from "bun:test";
import { asUser } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { setupRunLease } from "../test-helpers/run-lease.testkit";
import { api, internal } from "./_generated/api";

test("thread links fill the limit past a staged row and retain a legacy ghost", async () => {
  const f = await setupRunLease();
  const ids = await f.t.run(async ({ db }) => {
    const rows = fixtureRows(db, "staged thread links");
    const receiver = await rows.user();
    const sender = await rows.user();
    const target = await rows.conversation(receiver);
    const deleted = await rows.conversation(receiver);
    const legacyRow = {
      owner_user_id: receiver,
      from_user_id: sender,
      content: formatSessionMessage("sender", "legacy link"),
      status: "delivered" as const,
      retry_count: 0,
    };
    const older = await db.insert("pending_messages", {
      ...legacyRow,
      conversation_id: target,
      created_at: 2,
    });
    const ghost = await db.insert("pending_messages", {
      ...legacyRow,
      conversation_id: deleted,
      created_at: 1,
    });
    await db.delete(deleted);
    return { receiver, sender, target, deleted, older, ghost };
  });
  await f.t.mutation(internal.edgeRunLease.recordMove, {
    conversation_id: f.conversation,
    destination_device_id: "staged-thread-device",
    destination_runner_id: ids.receiver,
    expected_source_epoch: 1,
  });
  await f.t.run(({ db }) =>
    db.patch(f.message, {
      owner_user_id: ids.receiver,
      from_user_id: ids.sender,
      execution_epoch: 2,
      created_at: 3,
      content: formatSessionMessage("sender", "staged link"),
    }),
  );
  const query = asUser(f.t, ids.receiver).query;
  const limited = await query(api.sessionThreads.listSessionThreads, {
    limit: 1,
  });
  expect(limited.links.map((link) => link._id)).toEqual([ids.older]);
  expect(limited.links[0]?.to_id).toBe(ids.target);
  await f.t.run(({ db }) => db.delete(f.conversation));
  const result = await query(api.sessionThreads.listSessionThreads, {
    limit: 2,
  });
  const ghostId = "ghost:" + ids.deleted.slice(0, 7);
  expect(result.links.map((link) => link._id)).toEqual([ids.older, ids.ghost]);
  expect(result.links[1]?.to_id).toBe(ghostId);
  expect(result.nodes.find((node) => node._id === ghostId)).toMatchObject({
    resolved: false,
  });
});
