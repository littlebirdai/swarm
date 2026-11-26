import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { asUser, serverTest } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

const flag = "CODECAST_SESSION_READ_ANCHORS";
const env = process.env[flag];
const anchors = api.conversationReadAnchors;

beforeEach(() => {
  process.env[flag] = "1";
  jest.useFakeTimers();
  jest.setSystemTime(1000);
});
afterEach(() => {
  if (env === undefined) delete process.env[flag];
  else process.env[flag] = env;
  jest.useRealTimers();
});

async function setup() {
  const t = serverTest();
  const ids = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "saved reading anchor");
    const owner = await rows.user({ email: "reader@example.test" });
    const guest = await rows.user();
    const other = await rows.user({ email: "reader@example.test" });
    const conversation = await rows.conversation(owner, {
      is_private: true,
      share_token: "read-token",
    });
    const elsewhere = await rows.conversation(other, { is_private: true });
    const first = await rows.message(conversation, { timestamp: 100 });
    const second = await rows.message(conversation, { timestamp: 200 });
    const foreign = await rows.message(elsewhere);
    await db.insert("share_redemptions", {
      user_id: guest,
      conversation_id: conversation,
      token: "read-token",
      created_at: 100,
    });
    return {
      owner,
      guest,
      other,
      conversation,
      elsewhere,
      first,
      second,
      foreign,
    };
  });
  const args = { conversation_id: ids.conversation };
  const doc = { doc_id: `compose:${ids.conversation}` };
  const reader = asUser(t, ids.owner);
  const rows = () =>
    t.run(({ db }) => db.query("conversation_read_anchors").collect());
  const begin = (user = reader) => user.mutation(anchors.begin, args);
  const get = (user = reader) => user.query(anchors.get, args);
  const save = (
    view: string | null,
    seq: number,
    message = ids.first,
    offset = 0.4,
    user = reader,
  ) =>
    user.mutation(anchors.save, {
      ...args,
      view_id: view!,
      sequence: seq,
      message_id: message,
      offset,
    });
  return { t, ...ids, args, doc, reader, rows, begin, get, save };
}

test("flag off keeps composer presence reads and deletes and adds no saved anchor", async () => {
  const f = await setup();
  delete process.env[flag];
  const anchor = { message_id: f.first, offset: 0.4 };
  await f.reader.mutation(api.docSync.updatePresence, { ...f.doc, anchor });
  const guest = asUser(f.t, f.guest);
  expect(await guest.query(api.docSync.getPresence, f.doc)).toMatchObject([
    { user_id: f.owner, anchor, anchor_at: 1000 },
  ]);
  expect(await f.begin()).toBeNull();
  expect(await f.save("old-view", 1)).toBe("unavailable");
  expect(await f.get()).toBeNull();
  await f.reader.mutation(api.docSync.removePresence, f.doc);
  expect(await guest.query(api.docSync.getPresence, f.doc)).toEqual([]);
  expect(await f.rows()).toEqual([]);
});

test("takes the last valid legacy anchor on removal, without writing on heartbeat or sharing it as a live mark", async () => {
  const f = await setup();
  const guest = asUser(f.t, f.guest);
  const anchor = { message_id: f.first, offset: 0.4 };
  await f.reader.mutation(api.docSync.updatePresence, { ...f.doc, anchor });
  jest.setSystemTime(4000);
  await f.reader.mutation(api.docSync.updatePresence, { ...f.doc, anchor });
  expect(await f.rows()).toEqual([]);
  expect(await guest.query(api.docSync.getPresence, f.doc)).toMatchObject([
    { user_id: f.owner, anchor, anchor_at: 1000 },
  ]);
  await f.reader.mutation(api.docSync.removePresence, f.doc);
  expect(await f.get()).toMatchObject({ ...anchor, changed_at: 1000 });
  expect(await guest.query(api.docSync.getPresence, f.doc)).toEqual([]);
  expect(await f.get(guest)).toBeNull();
  const view = await f.begin();
  await f.save(view, 1, f.second);
  await f.reader.mutation(api.docSync.updatePresence, { ...f.doc, anchor });
  await f.reader.mutation(api.docSync.removePresence, f.doc);
  expect(await f.get()).toMatchObject({
    message_id: f.second,
    changed_at: 4000,
  });
});

test("lost exit retains the checkpoint and a newer view and sequence fence delayed saves", async () => {
  const f = await setup();
  const old = await f.begin();
  expect(await f.save(old, 1)).toBe("saved");
  jest.setSystemTime(9000);
  const current = await f.begin();
  expect(await f.get()).toMatchObject({
    message_id: f.first,
    changed_at: 1000,
  });
  expect(await f.save(old, 90, f.second)).toBe("stale");
  expect(await f.save(current, 2, f.second)).toBe("saved");
  expect(await f.save(current, 1)).toBe("stale");
  expect(await f.save(current, 2)).toBe("stale");
  jest.setSystemTime(12000);
  expect(await f.save(current, 3, f.second)).toBe("unchanged");
  expect(await f.get()).toMatchObject({
    message_id: f.second,
    changed_at: 9000,
  });
  expect(await f.rows()).toHaveLength(1);
});

test("validates offsets and visible transcript membership and falls back for deleted messages", async () => {
  const f = await setup();
  const view = await f.begin();
  expect(await f.save(view, 1, f.foreign)).toBe("invalid");
  expect(await f.save(view, 1, f.first, -0.1)).toBe("invalid");
  expect(await f.save(view, 1, f.first, 1.1)).toBe("invalid");
  expect(await f.save(view, 1, f.first, Number.NaN)).toBe("invalid");
  expect(await f.get()).toBeNull();
  expect(await f.save(view, 1, f.first, 1)).toBe("saved");
  await f.t.run(({ db }) => db.delete(f.first));
  expect(await f.get()).toBeNull();
  expect(await f.save(view, 2)).toBe("invalid");
});

test("each reader sees only their own anchor and losing access revokes reads and writes", async () => {
  const f = await setup();
  const guest = asUser(f.t, f.guest);
  const other = asUser(f.t, f.other);
  const ownerView = await f.begin();
  const guestView = await f.begin(guest);
  expect(await f.save(ownerView, 1)).toBe("saved");
  expect(await f.save(guestView, 1, f.second, 0, guest)).toBe("saved");
  expect(await f.get()).toMatchObject({
    user_id: f.owner,
    message_id: f.first,
  });
  expect(await f.get(guest)).toMatchObject({
    user_id: f.guest,
    message_id: f.second,
  });
  expect(await f.get(other)).toBeNull();
  expect(await f.t.query(anchors.get, f.args)).toBeNull();
  await f.t.run(({ db }) =>
    db.patch(f.conversation, { share_token: "rotated" }),
  );
  expect(await f.get(guest)).toBeNull();
  expect(await f.begin(guest)).toBeNull();
  expect(await f.save(guestView, 2, f.first, 0, guest)).toBe("unavailable");
});

test("account merge keeps the newest valid anchor on the destination and fences old views", async () => {
  const f = await setup();
  const t = f.t;
  await t.run(async ({ db }) => {
    const add = (
      conversation_id: Id<"conversations">,
      user_id: Id<"users">,
      message_id: Id<"messages">,
      changed_at: number,
    ) =>
      db.insert("conversation_read_anchors", {
        conversation_id,
        user_id,
        anchor: { message_id, changed_at, offset: 0.5 },
        view_id: "old-tab",
        sequence: 1,
      });
    await add(f.conversation, f.owner, f.first, 20);
    await add(f.conversation, f.other, f.second, 10);
    await add(f.elsewhere, f.owner, f.first, 30);
    await add(f.elsewhere, f.other, f.foreign, 4);
  });
  const result = await t.mutation(internal.admin_mergeUser.mergeDuplicateUser, {
    from_user_id: f.owner,
    to_user_id: f.other,
    dry_run: false,
    delete_source: true,
  });
  expect(result.source_deleted).toBe(true);
  expect(await f.rows()).toMatchObject([
    { user_id: f.other, anchor: { message_id: f.first, changed_at: 20 } },
    { user_id: f.other, anchor: { message_id: f.foreign, changed_at: 4 } },
  ]);
  expect(await f.save("old-tab", 2, f.second, 0, asUser(t, f.other))).toBe(
    "stale",
  );
});

test("ordinary session delete purges the anchors of every reader", async () => {
  const f = await setup();
  await f.save(await f.begin(), 1);
  const guest = asUser(f.t, f.guest);
  await f.save(await f.begin(guest), 1, f.second, 0, guest);
  expect(await f.rows()).toHaveLength(2);
  await f.reader.mutation(api.sessionDelete.deleteSession, f.args);
  await f.t.finishAllScheduledFunctions(() => jest.runAllTimers());
  expect(await f.rows()).toEqual([]);
});

test("account delete removes the viewer's anchors in other sessions", async () => {
  const f = await setup();
  await f.save(await f.begin(), 1);
  const guest = asUser(f.t, f.guest);
  await f.save(await f.begin(guest), 1, f.second, 0, guest);
  await f.t.mutation(internal.accountDelete.purgeAccount, { user_id: f.guest });
  expect(await f.rows()).toMatchObject([{ user_id: f.owner }]);
  expect(await f.get()).toMatchObject({ message_id: f.first });
});

test("a summary-only teammate cannot read, begin or save an anchor", async () => {
  const f = await setup();
  await f.t.run(async ({ db }) => {
    const rows = fixtureRows(db, "summary only");
    const team_id = await rows.team();
    await rows.membership(f.owner, team_id);
    await rows.membership(f.other, team_id);
    await db.patch(f.conversation, {
      team_id,
      is_private: false,
      team_visibility: "summary",
    });
    await db.insert("conversation_read_anchors", {
      ...f.args,
      user_id: f.other,
      view_id: "earlier-view",
      sequence: 1,
      anchor: { message_id: f.first, changed_at: 20, offset: 0.5 },
    });
  });
  const teammate = asUser(f.t, f.other);
  const before = await f.rows();
  expect(await f.get(teammate)).toBeNull();
  expect(await f.begin(teammate)).toBeNull();
  expect(await f.save("earlier-view", 2, f.second, 0.5, teammate)).toBe(
    "unavailable",
  );
  expect(
    await teammate.mutation(api.dispatch.dispatch, {
      action: "beginSavedReadingAnchor",
      args: [f.conversation],
    }),
  ).toBeNull();
  expect(
    await teammate.mutation(api.dispatch.dispatch, {
      action: "saveSavedReadingAnchor",
      args: [
        {
          ...f.args,
          view_id: "earlier-view",
          sequence: 2,
          message_id: f.second,
          offset: 0.5,
        },
      ],
    }),
  ).toBe("unavailable");
  expect(await f.rows()).toEqual(before);
});

test("dispatch claims a view and saves through the same fence", async () => {
  const f = await setup();
  const dispatch = (action: string, args: unknown[]) =>
    f.reader.mutation(api.dispatch.dispatch, { action, args });
  const view_id = await dispatch("beginSavedReadingAnchor", [f.conversation]);
  expect(view_id).toBeString();
  expect(
    await dispatch("saveSavedReadingAnchor", [
      {
        ...f.args,
        view_id,
        sequence: 1,
        message_id: f.first,
        offset: 0.4,
      },
    ]),
  ).toBe("saved");
  expect(
    await dispatch("saveSavedReadingAnchor", [
      {
        ...f.args,
        view_id,
        sequence: 1,
        message_id: f.second,
        offset: 0,
      },
    ]),
  ).toBe("stale");
  expect(await f.get()).toMatchObject({ message_id: f.first, offset: 0.4 });
});

test("merge transfers an anchor without a destination row and removes denied rows", async () => {
  const f = await setup();
  await f.save(await f.begin(), 1);
  await f.t.run(async ({ db }) => {
    const rows = fixtureRows(db, "denied destination");
    const stranger = await rows.user();
    const conversation_id = await rows.conversation(stranger);
    const message_id = await rows.message(conversation_id);
    for (const user_id of [f.owner, f.other]) {
      await db.insert("conversation_read_anchors", {
        conversation_id,
        user_id,
        anchor: { message_id, changed_at: 50, offset: 0.5 },
      });
    }
  });
  const retained = (await f.rows()).find(
    (row) => row.conversation_id === f.conversation,
  )!;
  await f.t.mutation(internal.admin_mergeUser.mergeDuplicateUser, {
    from_user_id: f.owner,
    to_user_id: f.other,
    dry_run: false,
    delete_source: true,
  });
  expect(await f.rows()).toEqual([
    {
      _id: retained._id,
      _creationTime: retained._creationTime,
      ...f.args,
      user_id: f.other,
      anchor: retained.anchor,
    },
  ]);
});
