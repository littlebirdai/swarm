import { expect, jest, onTestFinished, test } from "bun:test";
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
  const heads = await owner.query(api.syncLog.getHeads, {
    scopes: [`user:${viewer}`],
  });
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

test("publishing a pending outbox revision puts it after the snapshot checkpoint", async () => {
  jest.useFakeTimers();
  onTestFinished(() => {
    jest.useRealTimers();
  });
  const t = serverTest();
  const { viewer, id } = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "pending-inbox-checkpoint");
    const viewer = await rows.user();
    const id = await rows.conversation(viewer, {
      title: "Before",
      started_at: Date.now(),
      updated_at: Date.now(),
      message_count: 1,
    });
    return { viewer, id };
  });
  const owner = asUser(t, viewer);
  const query = () =>
    owner.query(api.conversations.listInboxSessions, { checkpoint: true });
  expect(await query()).toMatchObject({
    checkpoint: { scope: `user:${viewer}`, position: 0 },
  });
  await t.mutation(internal.titleGeneration.setTitleAndSubtitle, {
    conversation_id: id,
    title: "Pending",
  });
  expect(await query()).toMatchObject({
    sessions: [expect.objectContaining({ _id: id, title: "Pending" })],
    checkpoint: { scope: `user:${viewer}`, position: 0 },
  });
  const slot = await t.run(({ db }) => db.query("sync_outbox").first());
  expect(slot?.pending).toBe(true);
  await t.mutation(internal.syncOutbox.drain, { id: slot!._id });
  expect(
    await owner.query(api.syncLog.getRange, {
      scope_key: `user:${viewer}`,
      from: 0,
    }),
  ).toMatchObject({
    actions: [
      expect.objectContaining({ position: 1, entity_id: id, op: "upsert" }),
    ],
  });
  expect(await query()).toMatchObject({
    checkpoint: { scope: `user:${viewer}`, position: 1 },
  });
});

test("a stranded outbox slot does not block snapshots while the log is disabled", async () => {
  jest.useFakeTimers();
  const disabled = process.env.SYNC_LOG_DISABLED;
  delete process.env.SYNC_LOG_DISABLED;
  onTestFinished(() => {
    jest.useRealTimers();
    if (disabled === undefined) delete process.env.SYNC_LOG_DISABLED;
    else process.env.SYNC_LOG_DISABLED = disabled;
  });
  const t = serverTest();
  const { viewer, id } = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "disabled-inbox-checkpoint");
    const viewer = await rows.user();
    const id = await rows.conversation(viewer, {
      title: "Before",
      started_at: Date.now(),
      updated_at: Date.now(),
      message_count: 1,
    });
    return { viewer, id };
  });
  await t.mutation(internal.titleGeneration.setTitleAndSubtitle, {
    conversation_id: id,
    title: "Committed",
  });
  const slot = await t.run(({ db }) => db.query("sync_outbox").first());
  expect(slot?.pending).toBe(true);
  process.env.SYNC_LOG_DISABLED = "1";
  await t.mutation(internal.syncOutbox.drain, { id: slot!._id });
  expect((await t.run(({ db }) => db.get(slot!._id)))?.pending).toBe(true);
  expect(
    await asUser(t, viewer).query(api.conversations.listInboxSessions, {
      checkpoint: true,
    }),
  ).toMatchObject({
    sessions: [expect.objectContaining({ _id: id, title: "Committed" })],
    checkpoint: { scope: `user:${viewer}`, position: 0 },
  });
});

test("removing an owner revokes only their personal claim in the log", async () => {
  const t = serverTest();
  const { runner, viewer, id } = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "inbox-owner-revocation");
    const runner = await rows.user();
    const viewer = await rows.user();
    const team = await rows.team();
    await rows.membership(runner, team);
    await rows.membership(viewer, team);
    const id = await rows.conversation(runner, {
      team_id: team,
      owner_user_id: viewer,
    });
    await db.insert("session_owners", {
      conversation_id: id,
      user_id: viewer,
      added_by: runner,
      added_at: Date.now(),
    });
    return { runner, viewer, id };
  });
  const former = asUser(t, viewer);
  await former.mutation(api.sessionOwnership.removeSessionOwner, {
    session_id: id,
  });
  const slots = await t.run(({ db }) => db.query("sync_outbox").collect());
  for (const slot of slots)
    await t.mutation(internal.syncOutbox.drain, { id: slot._id });
  const action = {
    entity_type: "session_owner",
    entity_id: `session-owner:${id}`,
    op: "scope_removed",
  };
  const page = await former.query(api.syncLog.getRange, {
    scope_key: `user:${viewer}`,
    from: 0,
  });
  expect(page.actions).toContainEqual(expect.objectContaining(action));
  expect(page.actions).not.toContainEqual(
    expect.objectContaining({
      entity_type: "conversations",
      entity_id: id,
      op: "delete",
    }),
  );
  const runnerPage = await asUser(t, runner).query(api.syncLog.getRange, {
    scope_key: `user:${runner}`,
    from: 0,
  });
  expect(runnerPage.actions).not.toContainEqual(
    expect.objectContaining(action),
  );
});
