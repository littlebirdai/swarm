import { expect, jest, test } from "bun:test";
import { asUser } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { machine, setupRunLease } from "../test-helpers/run-lease.testkit";
import { api, internal } from "./_generated/api";
import { applyMergeBackReport, subagentEnded } from "./subagentFleet";
import { provisionStandingAgent } from "./anchors";
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

test.each(["sendMessage", "queueMessage"])(
  "legacy %s uses its outbox identity when the client ID is blank",
  async (action) => {
    const f = await setupRunLease();
    const viewer = asUser(f.t, f.owner);
    const outbox = {
      id: `${Date.now()}:${crypto.randomUUID()}`,
      owner: f.owner,
      age_ms: 0,
    };
    const request = {
      action,
      args: [
        f.conversation,
        "Legacy outbox message",
        ...(action === "sendMessage" ? [null, ""] : [" "]),
      ],
      outbox,
    };
    const message = await viewer.mutation(api.dispatch.dispatch, request);
    expect(await viewer.mutation(api.dispatch.dispatch, request)).toBe(message);
    expect(await f.t.run(({ db }) => db.get(message))).toMatchObject({
      client_id: `dispatch:${f.owner}:${outbox.id}`,
      ...(action === "sendMessage" && { execution_epoch: 1 }),
    });
    await expect(
      viewer.mutation(api.dispatch.dispatch, {
        action: "queueMessage",
        args: [f.conversation, "Queue without an identity"],
      }),
    ).rejects.toThrow("FENCED_DELIVERY_ID_REQUIRED");
  },
);

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

test("queued dispatch falls back to the receipt when the client ID is blank", async () => {
  const f = await setupRunLease();
  const viewer = asUser(f.t, f.owner);
  const message = await viewer.mutation(api.dispatch.dispatch, {
    action: "queueMessage",
    args: [f.conversation, "Queued by receipt", ""],
    result: { receiptActionVersion: 1, commandId: "queue-receipt" },
  });
  expect(await f.t.run(({ db }) => db.get(message))).toMatchObject({
    client_id: "queue-receipt",
  });
});

async function fencedAnchor() {
  const f = await setupRunLease();
  const anchor = await f.t.run(async ({ db }) => {
    const id = await db.insert("anchors", {
      scope_type: "user",
      scope_user_id: f.owner,
      bot_user_id: f.owner,
      host_user_id: f.owner,
      conversation_id: f.conversation,
      name: "Workspace agent",
      status: "active",
      created_at: 1,
    });
    await db.patch(f.conversation, { anchor_id: id });
    await db.insert("anchor_channels", {
      surface: "slack",
      anchor_id: id,
      channel_key: "test-channel",
      workspace_key: "test-workspace",
      created_at: 1,
    });
    return id;
  });
  const deliveryIds = () =>
    f.t.run(async ({ db }) =>
      (await db.query("pending_messages").collect())
        .filter((row) => row.delivery_id !== "delivery")
        .map((row) => row.delivery_id),
    );
  return { ...f, anchor, deliveryIds };
}

test("a CLI anchor wake reaches a fenced anchor and replays by request ID", async () => {
  const f = await fencedAnchor();
  const wake = () =>
    f.t.mutation(api.anchors.wakeAnchor, {
      api_token: f.bearer,
      anchor_id: f.anchor,
      message: "Wake the anchor",
      client_id: "wake-1",
    });
  await wake();
  await wake();
  expect(await f.deliveryIds()).toEqual([`anchor-wake:${f.owner}:wake-1`]);
});

test("a CLI anchor wake without a client ID is refused on a fenced anchor", async () => {
  const f = await fencedAnchor();
  for (const client_id of [undefined, "  "])
    await expect(
      f.t.mutation(api.anchors.wakeAnchor, {
        api_token: f.bearer,
        anchor_id: f.anchor,
        message: "Wake the anchor",
        ...(client_id === undefined ? {} : { client_id }),
      }),
    ).rejects.toThrow("FENCED_DELIVERY_ID_REQUIRED");
  expect(await f.deliveryIds()).toEqual([]);
});

test("a Slack event wakes a fenced anchor only once", async () => {
  const f = await fencedAnchor();
  const wake = () =>
    f.t.mutation(internal.slack.wakeFromSlackEvent, {
      event_id: "event-1",
      channel: "test-channel",
      workspace: "test-workspace",
      text: "Wake the anchor",
    });
  await wake();
  expect(await wake()).toEqual({ status: "duplicate" });
  expect(await f.deliveryIds()).toEqual(["slack-anchor:event-1"]);
});

test("an adopted fenced anchor receives its role bootstrap", async () => {
  const f = await fencedAnchor();
  const role = await f.t.run(async (ctx) => {
    const roleId = await ctx.db.insert("org_roles", {
      short_id: "or-1",
      scope_type: "user",
      scope_user_id: f.owner,
      host_user_id: f.owner,
      name: "Role",
      handle: "role",
      scope: { project_ids: [], plan_ids: [] },
      reports_to: { kind: "user", user_id: f.owner },
      status: "active",
      created_by: f.owner,
      created_at: 1,
      updated_at: 1,
    });
    await provisionStandingAgent(ctx, f.owner, {
      scope_type: "user",
      role: {
        _id: roleId,
        bootstrap: {
          handle: "role",
          scopeNames: [],
          parentName: "Owner",
          startsOnItsOwn: false,
        },
        adopt: await ctx.db.get(f.conversation),
      },
    });
    return roleId;
  });
  expect(await f.deliveryIds()).toEqual([`anchor-adopt:${f.anchor}:${role}`]);
});

test("a repeated merge-back report does not send twice to a fenced parent", async () => {
  const f = await setupRunLease();
  const worker = await f.t.run(async ({ db }) => {
    const id = await fixtureRows(db, "merge back").conversation(f.owner);
    await db.patch(id, { parent_conversation_id: f.conversation });
    return id;
  });
  const report = (state: "merged" | "conflict") =>
    f.t.run((ctx) =>
      applyMergeBackReport(ctx, f.owner, {
        conversation_id: worker,
        state,
        files: ["README.md"],
      }),
    );
  await report("merged");
  await report("merged");
  await report("conflict");
  const rows = await f.t.run(({ db }) =>
    db.query("pending_messages").collect(),
  );
  const notices = rows.filter((row) => row.from_conversation_id === worker);
  expect(notices.map((row) => row.conversation_sequence)).toEqual([2, 3]);
  expect(
    notices.every(
      (row) =>
        row.execution_epoch === 1 &&
        row.delivery_id?.startsWith(`merge-back:${worker}:`),
    ),
  ).toBe(true);
});

test("a regular fenced session can become a role and receive its bootstrap", async () => {
  const f = await setupRunLease();
  const role = await f.t.run(({ db }) =>
    fixtureRows(db, "fenced role adoption").role(f.owner, {
      scope_user_id: f.owner,
    }),
  );
  expect(
    (await f.t.run(({ db }) => db.get(f.conversation)))?.anchor_id,
  ).toBeUndefined();

  const viewer = asUser(f.t, f.owner);
  const request = { role_id: role, adopt_conversation_id: f.conversation };
  const adopted = await viewer.mutation(api.orgRoles.provision, request);
  expect(adopted).toMatchObject({
    conversation_id: f.conversation,
    adopted: true,
  });
  expect(await viewer.mutation(api.orgRoles.provision, request)).toMatchObject({
    conversation_id: f.conversation,
    already_existed: true,
  });

  const rows = await f.t.run(({ db }) =>
    db
      .query("pending_messages")
      .withIndex("by_conversation_id", (q) =>
        q.eq("conversation_id", f.conversation),
      )
      .collect(),
  );
  const bootstrapId = `anchor-bootstrap:${role}:${f.conversation}`;
  expect(rows.filter((row) => row.delivery_id === bootstrapId)).toMatchObject([
    { client_id: bootstrapId, execution_epoch: 1 },
  ]);
});

test.each([
  ["failed", "done", "other-machine"],
  ["kept", "blocked", machine],
] as const)(
  "a resumed worker sends both direct %s reports",
  async (state, outcome, ownerDevice) => {
    const f = await setupRunLease();
    const worker = await f.t.run(async ({ db }) => {
      await db.patch(f.conversation, { project_path: "/checkout" });
      return fixtureRows(db, "resumed worker").conversation(f.owner, {
        parent_conversation_id: f.conversation,
        merge_back_on_done: true,
        worktree_path: "/worktree",
        owner_device_id: ownerDevice,
      });
    });
    const settle = () =>
      f.t.run(async (ctx) =>
        subagentEnded(ctx, await ctx.db.get(worker), outcome),
      );
    jest.useFakeTimers();
    try {
      await settle();
      await settle();
      expect(await f.t.run(({ db }) => db.get(worker))).toMatchObject({
        merge_back: { state },
        merge_back_attempt: 2,
      });
      const rows = await f.t.run(({ db }) =>
        db.query("pending_messages").collect(),
      );
      expect(
        rows
          .filter((row) => row.from_conversation_id === worker)
          .map((row) => row.delivery_id),
      ).toEqual([
        `merge-back:${worker}:attempt:1`,
        `merge-back:${worker}:attempt:2`,
      ]);
    } finally {
      jest.useRealTimers();
    }
  },
);
