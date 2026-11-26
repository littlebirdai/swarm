import { expect, test } from "bun:test";
import { asUser } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { setupRunLease } from "../test-helpers/run-lease.testkit";
import { api, internal } from "./_generated/api";

async function replay(f: Awaited<ReturnType<typeof setupRunLease>>) {
  return asUser(f.t, f.owner).mutation(api.pendingMessages.sendMessageV2, {
    conversation_id: f.conversation,
    command_id: "delivery",
    client_id: "delivery",
    content: "queued",
  });
}

test.each(["legacy without an owner", "fenced with an unrelated owner"])(
  "a non-moving conversation rejects a %s pending intent",
  async (kind) => {
    const f = await setupRunLease();
    const before = await f.t.run(async ({ db }) => {
      if (kind === "legacy without an owner") {
        await db.patch(f.message, {
          owner_user_id: undefined,
          execution_epoch: undefined,
          delivery_protocol_version: undefined,
          conversation_sequence: undefined,
          delivery_status: undefined,
          delivery_id: undefined,
        });
      } else {
        const rows = fixtureRows(db, "unrelated replay owner");
        await db.patch(f.message, { owner_user_id: await rows.user() });
      }
      return db.get(f.message);
    });
    expect(await replay(f)).toMatchObject({
      status: "rejected",
      rejection: { code: "CLIENT_ID_REUSED" },
    });
    expect(
      await f.t.run(({ db }) => db.query("pending_messages").collect()),
    ).toEqual([before]);
  },
);

test("the active move record can authorize the staged owner of a replay", async () => {
  const f = await setupRunLease();
  const destination = await f.t.run(({ db }) =>
    fixtureRows(db, "replay move record owner").user(),
  );
  await f.t.mutation(internal.edgeRunLease.recordMove, {
    conversation_id: f.conversation,
    destination_device_id: "replay-destination",
    destination_runner_id: destination,
    expected_source_epoch: 1,
  });
  const before = await f.t.run(async ({ db }) => {
    await db.patch(f.message, { owner_user_id: destination });
    return db.get(f.message);
  });
  expect(await replay(f)).toMatchObject({ status: "acknowledged" });
  expect(
    await f.t.run(({ db }) => db.query("pending_messages").collect()),
  ).toEqual([before]);
});
