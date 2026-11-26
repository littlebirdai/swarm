import { afterEach, expect, setSystemTime, test } from "bun:test";
import { asUser, serverTest } from "../../test-helpers/database.testkit";
import { fixtureRows } from "../../test-helpers/rows.testkit";
import { api } from "../_generated/api";
import { claim } from "./claims";

const originalFlag = process.env.SWARM_TURN_BATON;

afterEach(() => {
  setSystemTime();
  if (originalFlag === undefined) delete process.env.SWARM_TURN_BATON;
  else process.env.SWARM_TURN_BATON = originalFlag;
});

async function setup() {
  const t = serverTest();
  const { owner, sender, conversation } = await t.run(async ({ db }) => {
    const fixtures = fixtureRows(db, "turn-takeover");
    const owner = await fixtures.user();
    const sender = await fixtures.user();
    const conversation = await fixtures.conversation(owner);
    return { owner, sender, conversation };
  });
  return { t, owner, sender, conversation };
}

const takeover = api.pendingMessages.requestTurnTakeover;

test("turn takeover is disabled by default with a zero database budget", async () => {
  delete process.env.SWARM_TURN_BATON;
  const { t, owner, conversation } = await setup();
  await asUser(t, owner).run(async (ctx) => {
    const result = await ctx.runMutation(takeover, {
      conversation_id: conversation,
    });
    expect(result).toEqual({ status: "not_available", reason: "disabled" });
    const { documentsRead, documentsWritten } =
      await ctx.meta.getTransactionMetrics();
    expect(documentsRead.used).toBe(0);
    expect(documentsWritten.used).toBe(0);
  });
});

test("the takeover flag preserves legacy delivery bytes and database use", async () => {
  setSystemTime(new Date("2026-11-25T12:00:00Z"));
  const admit = async () => {
    const { t, owner, conversation } = await setup();
    const message = await t.run(({ db }) =>
      db.insert("pending_messages", {
        conversation_id: conversation,
        from_user_id: owner,
        content: "Continue",
        status: "pending",
        created_at: 1,
        retry_count: 0,
      }),
    );
    return asUser(t, owner).run(async (ctx) => {
      const result = await ctx.runMutation(
        api.pendingMessages.claimPendingMessageForDelivery,
        { message_id: message, device_id: "laptop" },
      );
      const { bytesRead, bytesWritten, documentsRead, documentsWritten } =
        await ctx.meta.getTransactionMetrics();
      expect(result?._id).toBe(message);
      return {
        bytes: JSON.stringify(result),
        reads: [documentsRead.used, bytesRead.used],
        writes: [documentsWritten.used, bytesWritten.used],
      };
    });
  };

  delete process.env.SWARM_TURN_BATON;
  const disabled = await admit();
  expect(disabled.reads[0]).toBeGreaterThan(0);
  expect(disabled.writes[0]).toBeGreaterThan(0);

  process.env.SWARM_TURN_BATON = "1";
  expect(await admit()).toEqual(disabled);
});

test("turn takeover refuses anonymous users, other users, and deleted targets", async () => {
  process.env.SWARM_TURN_BATON = "1";
  const { t, owner, sender, conversation } = await setup();
  const args = { conversation_id: conversation };
  expect(await t.mutation(takeover, args)).toEqual({ status: "refused" });
  expect(await asUser(t, sender).mutation(takeover, args)).toEqual({
    status: "refused",
  });
  await t.run(({ db }) => db.delete(conversation));
  expect(await asUser(t, owner).mutation(takeover, args)).toEqual({
    status: "refused",
  });
});

test("turn takeover requires a machine fence and preserves the holder on retry", async () => {
  process.env.SWARM_TURN_BATON = "1";
  const { t, owner, sender, conversation } = await setup();
  await t.run((ctx) =>
    claim(ctx, {
      kind: "steer",
      id: conversation,
      holder: sender,
      requestId: "starter",
      expectedToken: 0,
      steering: { mode: "contested" },
    }),
  );
  const claims = () => t.run(({ db }) => db.query("claims").collect());
  const before = await claims();
  expect(before).toEqual([expect.objectContaining({ holder: sender })]);
  for (const result of await Promise.all([
    asUser(t, owner).mutation(takeover, { conversation_id: conversation }),
    asUser(t, owner).mutation(takeover, { conversation_id: conversation }),
  ])) {
    expect(result).toEqual({
      status: "not_available",
      reason: "machine_fence_required",
    });
  }
  expect(await claims()).toEqual(before);
});
