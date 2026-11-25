import { expect, test } from "bun:test";
import { api, internal } from "./_generated/api";
import { terminalWatchFixture } from "../test-helpers/terminal-watch.testkit";

const watch = api.terminalWatch;

test("terminal blocks survive moving the session and deleting its original team", async () => {
  const { t, args, owner, viewer, ids, start, enable } =
    await terminalWatchFixture();
  await start();
  expect(
    await owner.mutation(watch.stopViewer, { ...args, viewer: ids.viewer }),
  ).toBe(true);
  await t.run(async ({ db }) => {
    await db.patch(ids.conversation_id, { team_id: ids.otherTeam });
    await db.patch(ids.team, { deleted_at: Date.now() });
  });
  await t.mutation(internal.terminalWatch.purgeTeamRows, { team_id: ids.team });
  const lease = await enable();
  expect(await viewer.mutation(watch.watch, { ...lease, renew: false })).toBe(
    false,
  );
  expect(
    await owner.mutation(watch.unblockViewer, { ...args, viewer: ids.viewer }),
  ).toBe(true);
  expect(await viewer.mutation(watch.watch, { ...lease, renew: false })).toBe(
    true,
  );
});

test("duplicate blocks deny the view and one unblock clears every row", async () => {
  const { t, args, ids, owner, viewer, start } = await terminalWatchFixture();
  const { lease } = await start();
  await t.run(async ({ db }) => {
    for (let i = 0; i < 2; i++)
      await db.insert("terminal_watch_blocks", {
        ...args,
        team_id: ids.team,
        user_id: ids.viewer,
      });
  });
  expect(await viewer.query(watch.status, args)).toBeNull();
  expect(await viewer.query(watch.screen, lease)).toBeNull();
  expect(await owner.query(watch.blockedViewers, args)).toHaveLength(1);
  expect(
    await owner.mutation(watch.unblockViewer, { ...args, viewer: ids.viewer }),
  ).toBe(true);
  expect(await viewer.mutation(watch.watch, { ...lease, renew: false })).toBe(
    true,
  );
  expect(await owner.query(watch.blockedViewers, args)).toEqual([]);
});

test.each(["team", "device", "expired bind"] as const)(
  "owner status turns off after a %s change",
  async (change) => {
    const { t, args, ids, owner, start } = await terminalWatchFixture();
    if (change === "expired bind") {
      expect(
        await owner.mutation(watch.setSharing, { ...args, enabled: true }),
      ).toBe(true);
      await t.run(async ({ db }) => {
        const row = await db.query("terminal_watch_shares").first();
        await db.patch(row!._id, { bind_expires_at: Date.now() - 1 });
      });
    } else {
      await start();
      await t.run(({ db }) =>
        db.patch(
          ids.conversation_id,
          change === "team"
            ? { team_id: ids.otherTeam }
            : { owner_device_id: "other-device" },
        ),
      );
    }
    expect(await owner.query(watch.status, args)).toMatchObject({
      role: "owner",
      enabled: false,
    });
  },
);

test("turning off cleans the full share even after more than one deletion page", async () => {
  const { t, args, owner, ids, start } = await terminalWatchFixture();
  const { lease } = await start();
  await t.run(async ({ db }) => {
    for (let i = 0; i < 105; i++)
      await db.insert("terminal_watch_viewers", {
        share: lease.share,
        user_id: ids.viewer,
        expires_at: 1,
        revoked: true,
      });
  });
  expect(
    await owner.mutation(watch.setSharing, { ...args, enabled: false }),
  ).toBe(true);
  expect(
    await t.run(({ db }) => db.query("terminal_watch_shares").collect()),
  ).toEqual([]);
  expect(
    await t.run(({ db }) => db.query("terminal_watch_screens").collect()),
  ).toEqual([]);
  expect(
    await t.run(({ db }) => db.query("terminal_watch_viewers").collect()),
  ).toEqual([]);
});

test("leave removes matching presence rows and preserves another viewer", async () => {
  const { t, ids, viewer, start } = await terminalWatchFixture();
  const { lease } = await start();
  await t.run(async ({ db }) => {
    for (const user_id of [ids.viewer, ids.secondViewer])
      await db.insert("terminal_watch_viewers", {
        share: lease.share,
        user_id,
        expires_at: Date.now() + 1000,
        revoked: false,
      });
  });
  expect(await viewer.mutation(watch.leave, lease)).toBe(true);
  expect(
    await t.run(async ({ db }) =>
      (await db.query("terminal_watch_viewers").collect()).map(
        (v) => v.user_id,
      ),
    ),
  ).toEqual([ids.secondViewer]);
});

test("permanently deleting the original team preserves a moved session block", async () => {
  const { t, args, owner, viewer, ids, start, enable } =
    await terminalWatchFixture();
  await start();
  await owner.mutation(watch.stopViewer, { ...args, viewer: ids.viewer });
  const team = await t.run(async ({ db }) => {
    await db.patch(ids.conversation_id, { team_id: ids.otherTeam });
    await db.patch(ids.team, { policy: { regulated_data: true } });
    return await db.get(ids.team);
  });
  const { deletion_id } = await owner.mutation(
    api.regulatedDeletion.destroyTeam,
    {
      team_id: ids.team,
      confirm_name: team!.name,
    },
  );
  const deletion = await t.run(({ db }) => db.get(deletion_id));
  expect(
    await t.mutation(internal.regulatedDeletion.runDeletion, {
      deletion_id,
      gen: deletion!.gen,
    }),
  ).toEqual({ done: true });
  const lease = await enable();
  expect(await viewer.mutation(watch.watch, { ...lease, renew: false })).toBe(
    false,
  );
});
