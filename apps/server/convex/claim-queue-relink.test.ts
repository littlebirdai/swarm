import { formatSessionMessage } from "@codecast/messages/machineMessages";
import { afterEach, expect, jest, test } from "bun:test";
import { getFunctionName, type FunctionArgs } from "convex/server";
import crons from "./crons";
import { DEVICE_ONLINE_MS } from "./deviceRouting";
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
    apiToken,
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

const continueRelink = internal.devices.continueClaimQueueRelink;
const recoverRelinks = internal.devices.recoverClaimQueueRelinks;

async function lastContinuation(f: Fixture) {
  const job = (await scheduledJobs(f.t, continueRelink)).at(-1);
  if (!job) throw new Error("Expected a scheduled relink");
  return {
    id: job._id,
    args: job.args[0] as FunctionArgs<typeof continueRelink>,
  };
}

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

test("the recovery cron resumes a lost continuation at the last committed cursor", async () => {
  jest.useFakeTimers();
  const now = Date.now();
  const f = await claimFixture();
  const ids = await insertMessages(f, 1001);
  const cron = crons.crons["recover pending queue relinks"];
  expect(cron).toMatchObject({
    name: getFunctionName(recoverRelinks),
    schedule: { type: "interval", minutes: 1 },
  });
  expect(await f.claim()).toEqual({ moved: 1, more: false });
  const first = await lastContinuation(f);
  await f.t.run((ctx) => ctx.scheduler.cancel(first.id));
  jest.setSystemTime(now + 60_000);
  await f.t.mutation(continueRelink, first.args);
  const lost = await lastContinuation(f);
  expect(lost.args.cursor).not.toBeNull();
  expect(await f.t.run(({ db }) => db.get(first.args.jobId))).toMatchObject({
    value: lost.args.cursor,
    updated_at: now + 60_000,
  });
  await f.t.run((ctx) => ctx.scheduler.cancel(lost.id));

  jest.setSystemTime(now + 121_000);
  await f.t.mutation(recoverRelinks, {});
  expect(await lastContinuation(f)).toEqual(lost);
  expect(await f.poll(f.next)).toEqual([]);

  jest.setSystemTime(now + 181_000);
  await f.t.mutation(recoverRelinks, {});
  const replacement = await lastContinuation(f);
  expect(replacement.id).not.toBe(lost.id);
  expect(replacement.args).toEqual(lost.args);
  expect(await f.t.run(({ db }) => db.get(first.args.jobId))).toMatchObject({
    value: lost.args.cursor,
    updated_at: now + 181_000,
  });
  await f.t.mutation(recoverRelinks, {});
  expect(await lastContinuation(f)).toEqual(replacement);
  await f.t.finishAllScheduledFunctions(() => jest.runAllTimers());
  expect(await f.t.run(({ db }) => db.get(first.args.jobId))).toBeNull();
  expect(await f.t.run(({ db }) => db.get(ids[1000]!))).toMatchObject({
    owner_user_id: f.next,
  });
  expect(await f.poll(f.next)).toMatchObject([{ _id: ids[0] }]);
});

test("the recovery sweep pages past fresh markers and ignores other config keys", async () => {
  jest.useFakeTimers();
  const f = await claimFixture();
  const now = Date.now();
  const unrelated = await f.t.run(({ db }) =>
    db.insert("system_config", { key: "aaa_config", value: "", updated_at: 0 }),
  );
  const scan = () =>
    f.t.mutation(async (ctx) => {
      await ctx.runMutation(recoverRelinks, {});
      return ctx.meta.getTransactionMetrics();
    });
  expect((await scan()).documentsRead.used).toBe(0);

  const stale = await f.t.run(async ({ db }) => {
    const rows = fixtureRows(db, "queue relink recovery pages");
    const keys = [];
    for (let i = 0; i < 65; i++) {
      const id = await rows.conversation(f.next);
      keys.push("pending_queue_relink:" + id);
    }
    keys.sort();
    const stale = await db.insert("system_config", {
      key: keys.pop()!,
      value: "",
      updated_at: now - 121_000,
      updated_by: f.next,
    });
    for (const key of keys)
      await db.insert("system_config", { key, value: "", updated_at: now });
    return stale;
  });

  expect((await scan()).documentsRead.used).toBe(64);
  expect(await scheduledJobs(f.t, continueRelink)).toEqual([]);
  expect(await scheduledJobs(f.t, recoverRelinks)).toHaveLength(1);
  await f.t.finishAllScheduledFunctions(() => jest.runAllTimers());
  expect(await f.t.run(({ db }) => db.get(stale))).toBeNull();
  expect(await f.t.run(({ db }) => db.get(unrelated))).toMatchObject({
    updated_at: 0,
  });
  expect(await scheduledJobs(f.t, continueRelink)).toHaveLength(1);
});

test("sendMessageV2 adopts the same queued intent before its owner is relinked", async () => {
  jest.useFakeTimers();
  const f = await claimFixture();
  const ids = await insertMessages(f, 300);
  const clientId = crypto.randomUUID();
  const messageId = ids[299]!;
  const content = "original send";
  await f.t.run(({ db }) =>
    db.patch(messageId, { client_id: clientId, content }),
  );
  expect(await f.claim()).toEqual({ moved: 1, more: false });
  const before = await f.t.run(({ db }) => db.get(messageId));
  expect(before?.owner_user_id).toBe(f.previous);
  const result = await asUser(f.t, f.sender).mutation(
    api.pendingMessages.sendMessageV2,
    {
      conversation_id: f.conversation,
      command_id: clientId,
      client_id: clientId,
      content,
    },
  );
  expect(result).toMatchObject({ status: "acknowledged" });
  expect(
    await f.t.run(({ db }) =>
      db
        .query("pending_messages")
        .withIndex("by_conversation_client_id", (q) =>
          q.eq("conversation_id", f.conversation).eq("client_id", clientId),
        )
        .collect(),
    ),
  ).toEqual([before]);
  await f.t.finishAllScheduledFunctions(() => jest.runAllTimers());
});

test("a new send during relink is owned by the new runner and lies outside the scan", async () => {
  jest.useFakeTimers();
  const f = await claimFixture();
  const ids = await insertMessages(f, 1000);
  expect(await f.claim()).toEqual({ moved: 1, more: false });
  const first = await lastContinuation(f);
  jest.setSystemTime(Date.now() + 1000);
  const clientId = crypto.randomUUID();
  await asUser(f.t, f.sender).mutation(api.pendingMessages.sendMessageV2, {
    conversation_id: f.conversation,
    command_id: clientId,
    client_id: clientId,
    content: "send after account claim",
  });
  const newRow = () =>
    f.t.run(({ db }) =>
      db
        .query("pending_messages")
        .withIndex("by_conversation_client_id", (q) =>
          q.eq("conversation_id", f.conversation).eq("client_id", clientId),
        )
        .unique(),
    );
  const before = await newRow();
  expect(before).toMatchObject({ owner_user_id: f.next, status: "pending" });
  expect(await f.poll(f.next)).toEqual([]);
  await f.t.mutation(continueRelink, first.args);
  expect(await f.t.run(({ db }) => db.get(first.args.jobId))).toBeNull();
  expect(await lastContinuation(f)).toEqual(first);
  expect(await newRow()).toEqual(before);
  expect(await f.t.run(({ db }) => db.get(ids[999]!))).toMatchObject({
    owner_user_id: f.next,
  });
  await f.t.finishAllScheduledFunctions(() => jest.runAllTimers());
});

test("a second account claim replaces a partially completed relink", async () => {
  jest.useFakeTimers();
  const f = await claimFixture();
  const ids = await insertMessages(f, 1001);
  expect(await f.claim()).toEqual({ moved: 1, more: false });
  await f.t.mutation(continueRelink, (await lastContinuation(f)).args);
  const superseded = await lastContinuation(f);
  jest.setSystemTime(Date.now() + DEVICE_ONLINE_MS + 1);
  const senderToken = "sender-account-" + crypto.randomUUID();
  await f.t.run(async ({ db }) => {
    const rows = fixtureRows(db, "second device claim");
    await rows.token(f.sender, senderToken);
    await rows.device(f.sender, { device_id: deviceId, last_seen: Date.now() });
  });
  expect(
    await f.t.mutation(api.devices.claimDeviceAccount, {
      previous_user_id: f.next,
      previous_api_token: f.apiToken,
      api_token: senderToken,
      device_id: deviceId,
    }),
  ).toEqual({ moved: 1, more: false });
  const replacement = await lastContinuation(f);
  expect(replacement.args.jobId).not.toBe(superseded.args.jobId);
  expect(await f.t.run(({ db }) => db.get(superseded.args.jobId))).toBeNull();
  const snapshot = await f.t.run(({ db }) => db.get(ids[1000]!));
  await f.t.mutation(continueRelink, superseded.args);
  expect(await f.t.run(({ db }) => db.get(ids[1000]!))).toEqual(snapshot);
  expect(await lastContinuation(f)).toEqual(replacement);

  await f.t.finishAllScheduledFunctions(() => jest.runAllTimers());
  expect(await f.t.run(({ db }) => db.get(replacement.args.jobId))).toBeNull();
  for (const id of [ids[0]!, ids[1000]!])
    expect(await f.t.run(({ db }) => db.get(id))).toMatchObject({
      owner_user_id: f.sender,
    });
});

test("deleting a conversation during relink clears the marker without touching its tail", async () => {
  jest.useFakeTimers();
  const f = await claimFixture();
  const ids = await insertMessages(f, 1001);
  expect(await f.claim()).toEqual({ moved: 1, more: false });
  await f.t.mutation(continueRelink, (await lastContinuation(f)).args);
  const last = await lastContinuation(f);
  const tail = await f.t.run(({ db }) => db.get(ids[1000]!));
  await f.t.run(({ db }) => db.delete(f.conversation));
  await f.t.finishAllScheduledFunctions(() => jest.runAllTimers());
  expect(await f.t.run(({ db }) => db.get(last.args.jobId))).toBeNull();
  expect(await f.t.run(({ db }) => db.get(ids[1000]!))).toEqual(tail);
  expect(await lastContinuation(f)).toEqual(last);
});
