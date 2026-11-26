import { formatSessionMessage } from "@codecast/messages/machineMessages";
import { afterEach, expect, jest, test } from "bun:test";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  asUser,
  scheduledJobs,
  serverTest,
} from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";

const deviceId = "account-claim-device";
const statuses = [
  "pending",
  "held",
  "injected",
  "failed",
  "undeliverable",
] as const;

afterEach(() => jest.useRealTimers());

async function claimFixture() {
  const t = serverTest({});
  const apiToken = "next-account-" + crypto.randomUUID();
  const previousToken = "previous-account-" + crypto.randomUUID();
  const ids = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "queue relink accounts");
    const previous = await rows.user();
    const next = await rows.user();
    const sender = await rows.user();
    const team = await rows.team();
    for (const user of [previous, next, sender])
      await rows.membership(user, team);
    await rows.token(previous, previousToken);
    await rows.token(next, apiToken);
    await rows.device(next, { device_id: deviceId, last_seen: Date.now() });
    const conversation = await rows.conversation(previous, {
      owner_device_id: deviceId,
      is_private: false,
      team_id: team,
    });
    return { previous, next, sender, conversation };
  });
  return {
    ...ids,
    t,
    claim: () =>
      t.mutation(api.devices.claimDeviceAccount, {
        previous_user_id: ids.previous,
        previous_api_token: previousToken,
        api_token: apiToken,
        device_id: deviceId,
      }),
    poll: (user: Id<"users">) =>
      asUser(t, user).query(api.pendingMessages.getPendingMessagesForDaemon, {
        device_id: deviceId,
      }),
    take: (user: Id<"users">, message_id: Id<"pending_messages">) =>
      asUser(t, user).mutation(
        api.pendingMessages.claimPendingMessageForDelivery,
        {
          device_id: deviceId,
          message_id,
        },
      ),
    page: (cursor: string | null) =>
      t.run(({ db }) =>
        db
          .query("pending_messages")
          .withIndex("by_conversation_id", (q) =>
            q.eq("conversation_id", ids.conversation),
          )
          .paginate({ cursor, numItems: 1000, maximumBytesRead: 512 * 1024 }),
      ),
  };
}

type Fixture = Awaited<ReturnType<typeof claimFixture>>;

async function insertMessages(
  f: Fixture,
  count: number,
  {
    size = 10,
    batch = 1000,
    states = statuses,
  }: {
    size?: number;
    batch?: number;
    states?: readonly Doc<"pending_messages">["status"][];
  } = {},
) {
  const ids: Id<"pending_messages">[] = [];
  const content = "x".repeat(size);
  for (let offset = 0; offset < count; offset += batch) {
    const inserted = await f.t.run(async ({ db }) => {
      const result = [];
      for (let i = offset; i < Math.min(count, offset + batch); i++) {
        result.push(
          await db.insert("pending_messages", {
            conversation_id: f.conversation,
            from_user_id: f.sender,
            owner_user_id: i === 1 ? undefined : f.previous,
            content,
            status: states[i % states.length]!,
            created_at: i,
            retry_count: i % 5,
          }),
        );
      }
      return result;
    });
    ids.push(...inserted);
  }
  return ids;
}

test("a small queue relinks atomically with the account claim", async () => {
  const f = await claimFixture();
  const states = [...statuses, "delivered", "cancelled"] as const;
  const ids = await insertMessages(f, states.length, { states });
  const before = await f.t.run(({ db }) =>
    Promise.all(ids.map((id) => db.get(id))),
  );
  expect(await f.claim()).toEqual({ moved: 1, more: false });
  expect(
    await scheduledJobs(f.t, internal.devices.continueClaimQueueRelink),
  ).toEqual([]);
  const after = await f.t.run(({ db }) =>
    Promise.all(ids.map((id) => db.get(id))),
  );
  expect(after).toEqual(
    before.map((row) =>
      row?.status === "delivered" || row?.status === "cancelled"
        ? row
        : { ...row, owner_user_id: f.next },
    ),
  );
  expect(await f.poll(f.next)).toMatchObject([{ _id: ids[0] }]);
  expect(await f.poll(f.previous)).toEqual([]);
});

test("a 20,000-row queue finishes in bounded transactions without exposing either daemon to a partially relinked queue", async () => {
  jest.useFakeTimers();
  const f = await claimFixture();
  const ids = await insertMessages(f, 20_000);
  expect(await f.claim()).toEqual({ moved: 1, more: false });
  expect(await f.claim()).toEqual({ moved: 0, more: false });
  const jobs = await scheduledJobs(
    f.t,
    internal.devices.continueClaimQueueRelink,
  );
  expect(jobs).toHaveLength(1);
  const first = jobs[0]!.args[0] as {
    conversationId: Id<"conversations">;
    jobId: Id<"system_config">;
    cursor: string | null;
  };
  await f.t.mutation(internal.devices.continueClaimQueueRelink, first);
  const queued = await scheduledJobs(
    f.t,
    internal.devices.continueClaimQueueRelink,
  );
  expect(queued).toHaveLength(2);
  await f.t.mutation(internal.devices.continueClaimQueueRelink, first);
  expect(
    await scheduledJobs(f.t, internal.devices.continueClaimQueueRelink),
  ).toEqual(queued);
  const tailId = ids[19_995]!;
  const [head, tail] = await f.t.run(({ db }) =>
    Promise.all([db.get(ids[0]!), db.get(tailId)]),
  );
  expect(head?.owner_user_id).toBe(f.next);
  expect(tail?.owner_user_id).toBe(f.previous);
  expect(await f.poll(f.next)).toEqual([]);
  expect(await f.poll(f.previous)).toEqual([]);
  expect(await f.take(f.next, ids[0]!)).toBeNull();
  expect(await f.take(f.previous, tailId)).toBeNull();

  await f.t.finishAllScheduledFunctions(() => jest.runAllTimers());
  const completed = await scheduledJobs(
    f.t,
    internal.devices.continueClaimQueueRelink,
  );
  expect(completed.length).toBeGreaterThanOrEqual(20);
  expect(completed.every((job) => job.state.kind === "success")).toBe(true);
  expect(await f.t.run(({ db }) => db.get(first.jobId))).toBeNull();

  let cursor: string | null = null;
  let seen = 0;
  while (true) {
    const result: Awaited<ReturnType<Fixture["page"]>> = await f.page(cursor);
    for (const row of result.page) {
      expect(row.owner_user_id).toBe(f.next);
      expect(row.status).toBe(statuses[row.created_at % statuses.length]);
      expect(row.retry_count).toBe(row.created_at % 5);
      expect(row.from_user_id).toBe(f.sender);
      seen++;
    }
    if (result.isDone) break;
    cursor = result.continueCursor;
  }
  expect(seen).toBe(ids.length);
  expect(await f.poll(f.previous)).toEqual([]);
  expect(await f.poll(f.next)).toMatchObject([{ _id: ids[0] }]);
  expect(await f.take(f.next, ids[0]!)).toMatchObject({ _id: ids[0] });
}, 30_000);

test("large rows exhaust the relink byte budget before the row budget", async () => {
  jest.useFakeTimers();
  const f = await claimFixture();
  const ids = await insertMessages(f, 44, { size: 420_000, batch: 5 });
  expect(await f.claim()).toEqual({ moved: 1, more: false });
  await f.t.finishAllScheduledFunctions(() => jest.runAllTimers());
  const jobs = await scheduledJobs(
    f.t,
    internal.devices.continueClaimQueueRelink,
  );
  expect(jobs.length).toBeGreaterThan(1);
  expect(jobs.every((job) => job.state.kind === "success")).toBe(true);
  expect(await f.t.run(({ db }) => db.get(ids[42]!))).toMatchObject({
    owner_user_id: f.next,
  } satisfies Partial<Doc<"pending_messages">>);
}, 30_000);

test("the previous runner cannot read or settle a pending row during a paged relink", async () => {
  jest.useFakeTimers();
  const f = await claimFixture();
  const ids = await insertMessages(f, 1030);
  const target = ids[1029]!;
  const { previousWriter, nextWriter } = await f.t.run(async ({ db }) => {
    const rows = fixtureRows(db, "transcript writers during relink");
    await db.patch(target, {
      content: formatSessionMessage("sender1", "queued for the new owner"),
      status: "injected",
    });
    return {
      previousWriter: await rows.conversation(f.previous),
      nextWriter: await rows.conversation(f.next),
    };
  });
  const threadLinks = (user: Id<"users">) =>
    asUser(f.t, user).query(api.sessionThreads.listSessionThreads, {});
  const status = (user: Id<"users">) =>
    asUser(f.t, user).query(api.pendingMessages.getMessageStatus, {
      message_id: target,
    });

  expect((await threadLinks(f.previous)).links).toMatchObject([
    { _id: target, body: "queued for the new owner" },
  ]);
  expect(await f.claim()).toEqual({ moved: 1, more: false });
  expect(
    await scheduledJobs(f.t, internal.devices.continueClaimQueueRelink),
  ).toHaveLength(1);
  expect(await f.t.run(({ db }) => db.get(target))).toMatchObject({
    owner_user_id: f.previous,
    status: "injected",
  });
  expect((await threadLinks(f.previous)).links).toEqual([]);
  expect((await threadLinks(f.sender)).links).toMatchObject([{ _id: target }]);
  await expect(status(f.previous)).rejects.toThrow("Unauthorized");
  expect(await status(f.next)).toMatchObject({ status: "injected" });

  const echo = (user: Id<"users">, conversation_id: Id<"conversations">) =>
    asUser(f.t, user).mutation(api.messages.addMessages, {
      conversation_id,
      echo_ids: true,
      messages: [
        {
          role: "user",
          content: "queued for the new owner",
          message_uuid: crypto.randomUUID(),
          delivery_ids: [target],
        },
      ],
    });

  expect(await echo(f.previous, previousWriter)).toMatchObject({ inserted: 1 });
  expect(await f.t.run(({ db }) => db.get(target))).toMatchObject({
    status: "injected",
  });
  expect(await echo(f.next, nextWriter)).toMatchObject({ inserted: 1 });
  expect(await f.t.run(({ db }) => db.get(target))).toMatchObject({
    status: "delivered",
  });
  expect((await threadLinks(f.previous)).links).toEqual([]);
  await expect(status(f.previous)).rejects.toThrow("Unauthorized");
  await f.t.finishAllScheduledFunctions(() => jest.runAllTimers());
});
