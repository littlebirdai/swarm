import { expect, test } from "bun:test";
import { serverTest } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { api } from "./_generated/api";

async function fixture() {
  const t = serverTest({ documentsRead: 350, bytesRead: 3 * 1024 * 1024 });
  const device = "claim-scan-device";
  const apiToken = "claim-destination-" + crypto.randomUUID();
  const previousToken = "claim-source-" + crypto.randomUUID();
  const { previous, next, team } = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "device claim accounts");
    const previous = await rows.user();
    const next = await rows.user();
    const team = await rows.team();
    await rows.membership(previous, team);
    await rows.membership(next, team);
    await rows.token(previous, previousToken);
    await rows.token(next, apiToken);
    await rows.device(next, { device_id: device, last_seen: Date.now() });
    return { previous, next, team };
  });
  const claim = () =>
    t.mutation(api.devices.claimDeviceAccount, {
      api_token: apiToken,
      previous_api_token: previousToken,
      previous_user_id: previous,
      device_id: device,
    });
  return { t, device, previous, next, team, claim };
}

test("account claim reaches movable sessions after 599 private rows within 350 reads per call", async () => {
  const f = await fixture();
  const { privateFirst, privateLast, movable, other } = await f.t.run(
    async ({ db }) => {
      const rows = fixtureRows(db, "device claim sparse page");
      const privateRow = () =>
        rows.conversation(f.previous, {
          owner_device_id: f.device,
          team_id: f.team,
          is_private: true,
        });
      const privateFirst = await privateRow();
      for (let i = 1; i < 598; i++) await privateRow();
      const privateLast = await privateRow();
      const movable = [];
      for (let i = 0; i < 2; i++) {
        movable.push(
          await rows.conversation(f.previous, {
            owner_device_id: f.device,
            team_id: f.team,
            is_private: false,
          }),
        );
      }
      const other = await rows.conversation(f.previous, {
        owner_device_id: "other-device",
        team_id: f.team,
        is_private: false,
      });
      return { privateFirst, privateLast, movable, other };
    },
  );
  for (let skipped = 100; skipped <= 500; skipped += 100) {
    expect(await f.claim()).toEqual({ moved: 0, more: true, skipped });
  }
  expect(await f.claim()).toEqual({ moved: 1, more: true, skipped: 599 });
  expect(await f.claim()).toEqual({ moved: 1, more: false, skipped: 599 });
  await f.t.run(async ({ db }) => {
    for (const row of [privateFirst, privateLast, other])
      expect(await db.get(row)).toMatchObject({ user_id: f.previous });
    for (const row of movable)
      expect(await db.get(row)).toMatchObject({
        user_id: f.next,
        author_user_id: f.previous,
      });
    expect(await db.query("system_config").collect()).toHaveLength(0);
  });
});

test("large private rows cut the scan page short without losing its place", async () => {
  const f = await fixture();
  const movable = await f.t.run(async ({ db }) => {
    const rows = fixtureRows(db, "device claim large rows");
    const last_message_preview = "x".repeat(400_000);
    for (let i = 0; i < 8; i++) {
      await rows.conversation(f.previous, {
        owner_device_id: f.device,
        team_id: f.team,
        is_private: true,
        last_message_preview,
      });
    }
    return rows.conversation(f.previous, {
      owner_device_id: f.device,
      team_id: f.team,
      is_private: false,
    });
  });
  expect(await f.claim()).toMatchObject({ moved: 0, more: true });
  expect(await f.claim()).toEqual({ moved: 1, more: false, skipped: 8 });
  expect(await f.t.run(({ db }) => db.get(movable))).toMatchObject({
    user_id: f.next,
  });
});

test("a new source heartbeat restarts an interrupted account claim", async () => {
  const f = await fixture();
  const { first, sourceDevice } = await f.t.run(async ({ db }) => {
    const rows = fixtureRows(db, "device claim returns online");
    const sourceDevice = await rows.device(f.previous, {
      device_id: f.device,
      last_seen: Date.now() - 7_200_000,
    });
    const privateRow = () =>
      rows.conversation(f.previous, {
        owner_device_id: f.device,
        team_id: f.team,
        is_private: true,
      });
    const first = await privateRow();
    for (let i = 0; i < 100; i++) await privateRow();
    return { first, sourceDevice };
  });
  expect(await f.claim()).toEqual({ moved: 0, more: true, skipped: 100 });
  await f.t.run(async ({ db }) => {
    await db.patch(sourceDevice, { last_seen: Date.now() });
    await db.patch(first, { is_private: false });
  });
  expect(await f.claim()).toEqual({ moved: 0, more: false, pending: true });
  await f.t.run(({ db }) =>
    db.patch(sourceDevice, { last_seen: Date.now() - 3_600_000 }),
  );
  expect(await f.claim()).toEqual({ moved: 1, more: true, skipped: 99 });
  expect(await f.claim()).toEqual({ moved: 0, more: false, skipped: 100 });
  expect(await f.t.run(({ db }) => db.get(first))).toMatchObject({
    user_id: f.next,
  });
});
