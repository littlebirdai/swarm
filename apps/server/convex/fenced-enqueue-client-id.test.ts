import { expect, test } from "bun:test";
import { asUser } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { setupRunLease } from "../test-helpers/run-lease.testkit";
import { api } from "./_generated/api";
import { notifyStuckSend } from "./pendingMessages";

test("legacy send requests require an identity on fenced sessions and replay by that identity", async () => {
  const f = await setupRunLease();
  const send = (client_id?: string) =>
    f.t.mutation(api.pendingMessages.sendSessionMessage, {
      to: f.conversation,
      body: "Same words",
      api_token: f.bearer,
      ...(client_id && { client_id }),
    });
  await expect(send()).rejects.toThrow("FENCED_DELIVERY_ID_REQUIRED");
  const first = await send("legacy-first");
  const replay = await send("legacy-first");
  const second = await send("legacy-second");
  expect(first.message_id).toBe(replay.message_id);
  expect(first.message_id).not.toBe(second.message_id);
  expect(await f.t.run(({ db }) => db.get(first.message_id!))).toMatchObject({
    delivery_id: "legacy-first",
    execution_epoch: 1,
  });
});

test("legacy dispatch can use its durable outbox identity on a fenced session", async () => {
  const f = await setupRunLease();
  const viewer = asUser(f.t, f.owner);
  const outbox = {
    id: `${Date.now()}:${crypto.randomUUID()}`,
    owner: f.owner,
    age_ms: 0,
  };
  const request = {
    action: "sendMessage",
    args: [f.conversation, "Legacy outbox message"],
    outbox,
  };
  const message = await viewer.mutation(api.dispatch.dispatch, request);
  expect(await viewer.mutation(api.dispatch.dispatch, request)).toBe(message);
  expect(await f.t.run(({ db }) => db.get(message))).toMatchObject({
    delivery_id: `dispatch:${f.owner}:${outbox.id}`,
    execution_epoch: 1,
  });
  await expect(
    viewer.mutation(api.dispatch.dispatch, {
      action: "queueMessage",
      args: [f.conversation, "Queue without an identity"],
    }),
  ).rejects.toThrow("FENCED_DELIVERY_ID_REQUIRED");
});

test("a failure notice replays once and revised evidence does not rewrite a fenced notice", async () => {
  const f = await setupRunLease();
  const sent = await f.t.run(async ({ db }) => {
    const target = await fixtureRows(db, "fenced sender notice").conversation(
      f.owner,
    );
    return await db.insert("pending_messages", {
      conversation_id: target,
      from_user_id: f.owner,
      from_conversation_id: f.conversation,
      content: "A delivery that did not settle",
      status: "pending",
      created_at: Date.now(),
      retry_count: 0,
    });
  });
  const notify = (reach: "unconfirmed" | "gone") =>
    f.t.run(async (ctx) => notifyStuckSend(ctx, await ctx.db.get(sent), reach));
  const rows = () =>
    f.t.run(({ db }) =>
      db
        .query("pending_messages")
        .withIndex("by_conversation_id", (q) =>
          q.eq("conversation_id", f.conversation),
        )
        .collect(),
    );

  await notify("unconfirmed");
  const first = (await rows()).find(
    (row) => row.delivery_id === `send-notice:${sent}:unconfirmed`,
  );
  expect(first?.execution_epoch).toBe(1);
  await notify("unconfirmed");
  expect(await rows()).toHaveLength(2);

  await notify("gone");
  expect(await rows()).toHaveLength(3);
  expect(await f.t.run(({ db }) => db.get(first!._id))).toEqual(first);
});
