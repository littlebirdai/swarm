import { expect, test } from "bun:test";
import { api } from "./_generated/api";
import type { Doc, Id, TableNames } from "./_generated/dataModel";
import {
  asUser,
  serverTest,
  type ServerTest,
} from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { makeSessionStartsDb, sessionStartOf } from "./lib/sessionStarts";
import { collabRequests } from "./collab";
import { getMessageStatus } from "./pendingMessages";
import { listForUser, listOpenForLines } from "./sessionDecisions";

const shareToken = "shared-session";

async function setup() {
  const t = serverTest();
  const ids = await t.run(async ({ db }) => {
    const rows = fixtureRows(makeSessionStartsDb(db, db), "card-subscriptions");
    const team = await rows.team();
    const owner = await rows.user();
    const teammate = await rows.user();
    const teamViewer = await rows.user();
    const guest = await rows.user();
    const outsider = await rows.user();
    await rows.membership(owner, team);
    await rows.membership(teammate, team);
    await rows.membership(teamViewer, team);
    const conversation = await rows.conversation(owner, {
      title: "Current title",
      project_path: "/current",
      team_id: team,
      share_token: shareToken,
    });
    await db.insert("share_redemptions", {
      conversation_id: conversation,
      user_id: guest,
      token: shareToken,
      created_at: 2,
    });
    return { team, owner, teammate, teamViewer, guest, outsider, conversation };
  });
  const patch = (fields: Partial<Doc<"conversations">>) =>
    t.run(({ db }) =>
      makeSessionStartsDb(db, db).patch(ids.conversation, fields),
    );
  return { t, ...ids, patch };
}

async function readWithoutConversation(
  t: ServerTest,
  viewer: Id<"users">,
  conversation: Id<"conversations">,
  fn: unknown,
  args: object,
) {
  return asUser(t, viewer).run((ctx) => {
    const db = {
      ...ctx.db,
      get: (id: Id<TableNames>) => {
        expect(id).not.toBe(conversation);
        return ctx.db.get(id);
      },
    };
    return (fn as any)._handler({ ...ctx, db }, args);
  });
}

test("decision queue and Line subscriptions follow card edits without reading streamed conversations", async () => {
  const { t, team, owner, teammate, guest, outsider, conversation, patch } =
    await setup();
  const decision = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "card-subscription-task");
    const task = await rows.task(owner, {
      workspace: `team:${team}`,
      cause: { signal_count: 1, first_seen: 1, last_seen: 1, fingerprints: [] },
    });
    const run = await db.insert("workflow_runs", {
      user_id: owner,
      task_id: task,
      status: "paused",
      node_statuses: [],
      created_at: 3,
      updated_at: 3,
    });
    return db.insert("session_decisions", {
      conversation_id: conversation,
      session_id: "session",
      user_id: owner,
      team_id: team,
      task_id: task,
      workflow_run_id: run,
      question: "Ship?",
      options: [{ label: "Ship" }, { label: "Hold" }],
      blocking: true,
      status: "pending",
      created_at: 3,
      session_title: "Title at ask time",
      project_path: "/original",
    });
  });
  const workspace = { workspaces: [`team:${team}`] };
  const readQueue = () =>
    readWithoutConversation(t, owner, conversation, listForUser, {});
  const readLine = () =>
    readWithoutConversation(
      t,
      teammate,
      conversation,
      listOpenForLines,
      workspace,
    );
  const queue = await readQueue();
  const line = await readLine();
  const current = {
    _id: decision,
    session_title: "Current title",
    project_path: "/current",
  };
  expect(queue).toEqual([expect.objectContaining(current)]);
  expect(line).toEqual([expect.objectContaining(current)]);

  const card = () => t.run(({ db }) => sessionStartOf(db, conversation));
  const start = await card();
  expect(start?.card).toMatchObject({ title: "Current title" });
  await patch({
    message_count: 1,
    updated_at: 4,
    last_message_role: "assistant",
  });
  expect(await card()).toEqual(start);
  expect(await readQueue()).toEqual(queue);
  expect(await readLine()).toEqual(line);

  for (const viewer of [guest, outsider])
    expect(
      await asUser(t, viewer).query(
        api.sessionDecisions.listOpenForLines,
        workspace,
      ),
    ).toEqual([]);
  for (const viewer of [teammate, guest, outsider])
    expect(
      await asUser(t, viewer).query(api.sessionDecisions.listForUser, {}),
    ).toEqual([]);

  await patch({ title: "Renamed", project_path: undefined });
  const renamed = {
    _id: decision,
    session_title: "Renamed",
    project_path: "/original",
  };
  const renamedQueue = await readQueue();
  const renamedLine = await readLine();
  expect(renamedQueue).toEqual([expect.objectContaining(renamed)]);
  expect(renamedLine).toEqual([expect.objectContaining(renamed)]);

  await t.run(async ({ db }) => {
    const row = (await sessionStartOf(db, conversation))!;
    await db.patch(row._id, { card: undefined });
  });
  expect(
    await asUser(t, owner).query(api.sessionDecisions.listForUser, {}),
  ).toEqual(renamedQueue);
  expect(
    await asUser(t, teammate).query(
      api.sessionDecisions.listOpenForLines,
      workspace,
    ),
  ).toEqual(renamedLine);
});

test("message status keeps sender and owner access without subscribing to their transcript", async () => {
  const {
    t,
    owner,
    teammate,
    teamViewer,
    guest,
    outsider,
    conversation,
    patch,
  } = await setup();
  const message_id = await t.run(({ db }) =>
    db.insert("pending_messages", {
      conversation_id: conversation,
      from_user_id: teammate,
      content: "Status check",
      status: "pending",
      created_at: 3,
      retry_count: 0,
    }),
  );
  const args = { message_id };
  const status = (viewer: Id<"users">) =>
    asUser(t, viewer).query(api.pendingMessages.getMessageStatus, args);
  const ownerRead = () =>
    readWithoutConversation(t, owner, conversation, getMessageStatus, args);
  const pending = { status: "pending", created_at: 3, retry_count: 0 };
  expect(await ownerRead()).toMatchObject(pending);
  expect(await status(teammate)).toMatchObject(pending);
  for (const viewer of [guest, outsider])
    await expect(status(viewer)).rejects.toThrow("Unauthorized");
  await patch({ is_private: false });
  await expect(status(teamViewer)).rejects.toThrow("Unauthorized");

  await patch({
    message_count: 1,
    updated_at: 4,
    last_message_role: "assistant",
  });
  expect(await ownerRead()).toMatchObject(pending);
  await patch({ user_id: outsider });
  await expect(status(owner)).rejects.toThrow("Unauthorized");
  expect(await status(outsider)).toMatchObject(pending);

  await t.run(async ({ db }) => {
    await db.patch(message_id, { owner_user_id: owner });
    const start = (await sessionStartOf(db, conversation))!;
    await db.delete(start._id);
  });
  expect(await status(owner)).toMatchObject(pending);
  await expect(status(outsider)).rejects.toThrow("Unauthorized");
  await t.run(({ db }) => db.delete(conversation));
  await expect(status(owner)).rejects.toThrow("Unauthorized");
  expect(await status(teammate)).toMatchObject(pending);
});

test("collaboration requests follow the runner without subscribing to the transcript", async () => {
  const { t, owner, teammate, guest, outsider, conversation, patch } =
    await setup();
  const grant = await t.run(({ db }) =>
    db.insert("collab_grants", {
      conversation_id: conversation,
      owner_user_id: owner,
      grantee_user_id: guest,
      status: "requested",
      created_at: 3,
      updated_at: 3,
    }),
  );
  const args = { conversation_id: conversation };
  const requests = (viewer: Id<"users">) =>
    asUser(t, viewer).query(api.collab.collabRequests, args);
  const runnerRead = (viewer: Id<"users">) =>
    readWithoutConversation(t, viewer, conversation, collabRequests, args);
  const expected = [
    {
      grant_id: grant,
      grantee_user_id: guest,
      status: "requested",
      updated_at: 3,
    },
  ];
  expect(await runnerRead(owner)).toEqual(expected);
  await patch({ is_private: false });
  for (const viewer of [teammate, guest, outsider])
    expect(await requests(viewer)).toEqual([]);
  await patch({
    message_count: 1,
    updated_at: 4,
    last_message_role: "assistant",
  });
  expect(await runnerRead(owner)).toEqual(expected);
  await patch({ user_id: teammate });
  expect(await requests(owner)).toEqual([]);
  expect(await runnerRead(teammate)).toEqual(expected);
  await t.run(async ({ db }) => {
    const row = (await sessionStartOf(db, conversation))!;
    await db.delete(row._id);
  });
  expect(await requests(teammate)).toEqual(expected);
});
