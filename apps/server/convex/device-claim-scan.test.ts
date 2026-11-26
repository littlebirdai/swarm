import { expect, jest, test } from "bun:test";
import { serverTest } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { api } from "./_generated/api";

async function fixture(
  limits: Parameters<typeof serverTest>[0] = {
    documentsRead: 350,
    bytesRead: 3 * 1024 * 1024,
  },
) {
  const t = serverTest(limits);
  const device = "claim-scan-device";
  const apiToken = "claim-destination-" + crypto.randomUUID();
  const previousToken = "claim-source-" + crypto.randomUUID();
  const { previous, next, team, destination, membership } = await t.run(
    async ({ db }) => {
      const rows = fixtureRows(db, "device claim accounts");
      const previous = await rows.user();
      const next = await rows.user();
      const team = await rows.team();
      await rows.membership(previous, team);
      const membership = await rows.membership(next, team);
      await rows.token(previous, previousToken);
      await rows.token(next, apiToken);
      const destination = await rows.device(next, {
        device_id: device,
        last_seen: Date.now(),
      });
      return { previous, next, team, destination, membership };
    },
  );
  const claim = (token = apiToken) =>
    t.mutation(api.devices.claimDeviceAccount, {
      api_token: token,
      previous_api_token: previousToken,
      previous_user_id: previous,
      device_id: device,
    });
  return {
    t,
    device,
    previous,
    next,
    team,
    claim,
    destination,
    membership,
    apiToken,
  };
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
  for (let skipped = 2; skipped <= 8; skipped += 2)
    expect(await f.claim()).toEqual({ moved: 0, more: true, skipped });
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

test.each([
  { count: 100, bytes: 22_000 },
  { count: 6, bytes: 400_000 },
  { count: 3, bytes: 900_000 },
])(
  "claim moves $count sessions of $bytes bytes under default transaction limits",
  async ({ count, bytes }) => {
    const f = await fixture({});
    const movable = await f.t.run(async ({ db }) => {
      const rows = fixtureRows(db, "device claim large movable sessions");
      const ids = [];
      for (let i = 0; i < count; i++) {
        ids.push(
          await rows.conversation(f.previous, {
            owner_device_id: f.device,
            team_id: f.team,
            is_private: false,
            last_message_preview: "x".repeat(bytes),
          }),
        );
      }
      return ids;
    });
    let moved = 0;
    let more = true;
    for (let page = 0; page <= count; page++) {
      const result = await f.claim();
      moved += result.moved;
      more = result.more;
      if (!more) break;
    }
    expect(more).toBe(false);
    expect(moved).toBe(count);
    await f.t.run(async ({ db }) => {
      for (const id of movable)
        expect((await db.get(id))?.user_id).toBe(f.next);
      expect(await db.query("system_config").collect()).toHaveLength(0);
    });
  },
);

async function startPrivateScan(f: Awaited<ReturnType<typeof fixture>>) {
  const first = await f.t.run(async ({ db }) => {
    const rows = fixtureRows(db, "device claim checkpoint rows");
    const makeRow = () =>
      rows.conversation(f.previous, {
        owner_device_id: f.device,
        team_id: f.team,
        is_private: true,
      });
    const first = await makeRow();
    for (let i = 0; i < 100; i++) await makeRow();
    return first;
  });
  expect(await f.claim()).toEqual({ moved: 0, more: true, skipped: 100 });
  return first;
}

test("an expired checkpoint lets the claim revisit a newly movable session", async () => {
  const f = await fixture();
  const first = await startPrivateScan(f);
  await f.t.run(async ({ db }) => {
    const checkpoint = await db.query("system_config").unique();
    if (!checkpoint) throw new Error("Expected the claim checkpoint");
    await db.patch(checkpoint._id, { updated_at: Date.now() - 15 * 60 * 1000 });
    await db.patch(first, { is_private: false });
  });
  expect(await f.claim()).toEqual({ moved: 1, more: true, skipped: 99 });
  expect(await f.claim()).toEqual({ moved: 0, more: false, skipped: 100 });
  expect((await f.t.run(({ db }) => db.get(first)))?.user_id).toBe(f.next);
});

test.each(["team", "device"] as const)(
  "terminal %s refusal clears the claim checkpoint",
  async (refusal) => {
    const f = await fixture();
    const first = await startPrivateScan(f);
    await f.t.run(async ({ db }) => {
      if (refusal === "team") await db.delete(f.membership);
      else await db.patch(f.destination, { last_seen: 0 });
      await db.patch(first, { is_private: false });
    });
    expect(await f.claim()).toEqual({
      moved: 0,
      more: false,
      error:
        refusal === "team"
          ? "the two accounts do not share a team"
          : "this device is not online on the new account",
    });
    expect(
      await f.t.run(({ db }) => db.query("system_config").collect()),
    ).toHaveLength(0);
    await f.t.run(async ({ db }) => {
      if (refusal === "team")
        await fixtureRows(db, "restore device claim membership").membership(
          f.next,
          f.team,
        );
      else await db.patch(f.destination, { last_seen: Date.now() });
    });
    expect(await f.claim()).toEqual({ moved: 1, more: true, skipped: 99 });
    expect(await f.claim()).toEqual({ moved: 0, more: false, skipped: 100 });
  },
);

test("accounts with the same device ID keep separate claim cursors", async () => {
  const f = await fixture();
  await startPrivateScan(f);
  const otherToken = "other-destination-" + crypto.randomUUID();
  await f.t.run(async ({ db }) => {
    const rows = fixtureRows(db, "second account sharing device string");
    const other = await rows.user();
    await rows.membership(other, f.team);
    await rows.token(other, otherToken);
    await rows.device(other, { device_id: f.device, last_seen: Date.now() });
  });
  expect(await f.claim(otherToken)).toEqual({
    moved: 0,
    more: true,
    skipped: 100,
  });
  expect(await f.claim()).toEqual({ moved: 0, more: false, skipped: 101 });
  expect(await f.claim(otherToken)).toEqual({
    moved: 0,
    more: false,
    skipped: 101,
  });
});

test("device removal deletes its checkpoints in bounded batches", async () => {
  jest.useFakeTimers();
  try {
    const f = await fixture();
    await startPrivateScan(f);
    await f.t.run(async ({ db }) => {
      await db.patch(f.destination, { last_seen: 0 });
      const checkpoint = await db.query("system_config").unique();
      if (!checkpoint) throw new Error("Expected the claim checkpoint");
      for (let i = 0; i < 16; i++) {
        await db.insert("system_config", {
          key: checkpoint.key + i,
          value: checkpoint.value,
          updated_at: checkpoint.updated_at,
        });
      }
      await db.insert("system_config", {
        key: "other-key",
        value: "keep",
        updated_at: 0,
      });
    });
    expect(
      await f.t.mutation(api.devices.removeDevices, {
        api_token: f.apiToken,
        device_ids: [f.device],
      }),
    ).toEqual({ removed: [f.device], skipped: [] });
    const keys = () =>
      f.t.run(async ({ db }) =>
        (await db.query("system_config").collect()).map((row) => row.key),
      );
    expect(await keys()).toHaveLength(2);
    await f.t.finishAllScheduledFunctions(() => jest.runAllTimers());
    expect(await keys()).toEqual(["other-key"]);
  } finally {
    jest.useRealTimers();
  }
});
