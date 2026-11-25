import { expect, spyOn, test } from "bun:test";
import { api, internal } from "./_generated/api";
import { asUser } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import {
  deviceId,
  frame,
  target,
  terminalWatchFixture,
} from "../test-helpers/terminal-watch.testkit";

const watch = api.terminalWatch;

test("only the machine owner can turn on watching for one session", async () => {
  const { args, t, owner, viewer, enable, ids } = await terminalWatchFixture();
  expect(await owner.query(watch.status, args)).toEqual({
    role: "owner",
    enabled: false,
    available: true,
  });
  expect(await viewer.query(watch.status, args)).toBeNull();
  expect(
    await viewer.mutation(watch.setSharing, { ...args, enabled: true }),
  ).toBe(false);
  const lease = await enable();
  expect(await owner.query(watch.screen, lease)).toBeNull();
  expect(await viewer.query(watch.screen, lease)).toBeNull();
  expect(await t.query(watch.status, args)).toBeNull();
  for (const account of [t, asUser(t, ids.outsider)]) {
    expect(await account.query(watch.screen, lease)).toBeNull();
    expect(await account.query(watch.status, args)).toBeNull();
  }
  expect(
    await asUser(t, ids.outsider).mutation(watch.watch, {
      ...lease,
      renew: false,
    }),
  ).toBe(false);
  expect(
    await t.run(({ db }) => db.query("daemon_commands").collect()),
  ).toEqual([]);
});

test("summary-only teammates cannot watch a shared terminal", async () => {
  const { t, viewer, args, start } = await terminalWatchFixture();
  const { lease } = await start();
  await t.run(({ db }) =>
    db.patch(args.conversation_id, { team_visibility: "summary" }),
  );
  expect(await viewer.query(watch.screen, lease)).toBeNull();
  expect(await viewer.mutation(watch.watch, { ...lease, renew: true })).toBe(
    false,
  );
});

test("the viewer gets only the screen and cannot reach the interactive relay", async () => {
  const { t, args, ids, viewer, owner, start } = await terminalWatchFixture();
  const { lease, push } = await start();
  const relay = { ...args, device_id: deviceId, target };
  expect(
    await owner.mutation(api.terminalStream.watchPane, {
      ...relay,
      interactive: true,
    }),
  ).toMatchObject({ ok: true });
  expect(
    await owner.mutation(api.terminalStream.cliPushFrame, {
      api_token: push.api_token,
      device_id: deviceId,
      target,
      frame: "owner-only screen",
    }),
  ).toMatchObject({ stop: false });
  expect(
    await owner.mutation(api.terminalStream.cliPushClipboard, {
      api_token: push.api_token,
      device_id: deviceId,
      target,
      text: "owner-only clipboard",
    }),
  ).toEqual({ ok: true });
  expect(
    await owner.query(api.terminalStream.getPaneClipboard, relay),
  ).toMatchObject({ clipboard: "owner-only clipboard" });
  expect(
    await owner.mutation(api.terminalStream.sendPaneInput, {
      ...relay,
      data: "61",
    }),
  ).toEqual({ ok: true });

  expect(await viewer.query(api.terminalStream.getPane, relay)).toBeNull();
  expect(
    await viewer.query(api.terminalStream.getPaneClipboard, relay),
  ).toBeNull();
  expect(
    await viewer.mutation(api.terminalStream.watchPane, {
      ...relay,
      interactive: true,
    }),
  ).toMatchObject({ ok: false });
  expect(
    await viewer.mutation(api.terminalStream.sendPaneInput, {
      ...relay,
      data: "61",
    }),
  ).toMatchObject({ ok: false });
  expect(await viewer.query(watch.watchers, args)).toEqual([]);
  expect(await viewer.query(watch.screen, lease)).toEqual({
    text: frame,
    seen_at: expect.any(Number),
    expires_at: expect.any(Number),
  });
  expect(
    await viewer.mutation(watch.cliPush, { ...push, frame: "viewer payload" }),
  ).toEqual({ stop: true });
  expect(
    await t.mutation(watch.cliPush, { ...push, device_id: "other-device" }),
  ).toEqual({ stop: true });
  expect(
    await t.mutation(watch.cliPush, { ...push, stream_id: "stale-stream" }),
  ).toEqual({ stop: true });
  expect(await t.mutation(watch.cliPush, push)).toEqual({ stop: false });
  expect(await owner.query(watch.watchers, args)).toEqual([
    { user_id: ids.viewer, name: "Viewer", expires_at: expect.any(Number) },
  ]);
  expect(
    await t.run(
      async ({ db }) =>
        (await db.query("terminal_frames").first())?.pending_input,
    ),
  ).toBe("61");
});

test("stopping one viewer leaves others watching and blocks the stopped viewer rejoining", async () => {
  const { t, owner, viewer, args, ids, start } = await terminalWatchFixture();
  const { lease } = await start();
  const second = asUser(t, ids.secondViewer);
  expect(await second.mutation(watch.watch, { ...lease, renew: false })).toBe(
    true,
  );
  expect(
    await viewer.mutation(watch.stopViewer, {
      ...args,
      viewer: ids.secondViewer,
    }),
  ).toBe(false);
  expect(
    await owner.mutation(watch.stopViewer, { ...args, viewer: ids.viewer }),
  ).toBe(true);
  expect(await viewer.query(watch.screen, lease)).toBeNull();
  expect(await viewer.mutation(watch.watch, { ...lease, renew: false })).toBe(
    false,
  );
  expect(await second.query(watch.screen, lease)).toMatchObject({
    text: frame,
  });
  expect(
    (await owner.query(watch.watchers, args)).map((row) => row.user_id),
  ).toEqual([ids.secondViewer]);
});

test("turning sharing off stops every viewer and the old grant cannot renew", async () => {
  const { t, owner, viewer, args, ids, start, enable } =
    await terminalWatchFixture();
  const { lease, push } = await start();
  const second = asUser(t, ids.secondViewer);
  expect(await second.mutation(watch.watch, { ...lease, renew: false })).toBe(
    true,
  );
  expect(
    await owner.mutation(watch.setSharing, { ...args, enabled: false }),
  ).toBe(true);
  expect(await viewer.query(watch.screen, lease)).toBeNull();
  expect(await second.query(watch.screen, lease)).toBeNull();
  expect(await t.mutation(watch.cliPush, push)).toEqual({ stop: true });
  expect(await owner.query(watch.watchers, args)).toEqual([]);
  expect((await enable()).share).not.toBe(lease.share);
  expect(await viewer.mutation(watch.watch, { ...lease, renew: true })).toBe(
    false,
  );
});

type Fixture = Awaited<ReturnType<typeof terminalWatchFixture>>;
const accessChanges: [string, (fixture: Fixture) => Promise<unknown>][] = [
  [
    "viewer left the team",
    ({ t, ids }) => t.run(({ db }) => db.delete(ids.membership)),
  ],
  [
    "session became private",
    ({ t, ids }) =>
      t.run(({ db }) => db.patch(ids.conversation_id, { is_private: true })),
  ],
  [
    "machine owner changed",
    ({ t, ids }) =>
      t.run(({ db }) => db.patch(ids.device, { user_id: ids.secondViewer })),
  ],
  [
    "session moved to another machine",
    ({ t, ids }) =>
      t.run(({ db }) =>
        db.patch(ids.conversation_id, { owner_device_id: "other-device" }),
      ),
  ],
  [
    "session moved to another team",
    ({ t, ids }) =>
      t.run(({ db }) =>
        db.patch(ids.conversation_id, { team_id: ids.otherTeam }),
      ),
  ],
  [
    "pane target changed",
    ({ t, ids }) =>
      t.run(({ db }) =>
        db.patch(ids.session, { tmux_session: "cc-different" }),
      ),
  ],
  [
    "pane process restarted",
    ({ t, ids }) =>
      t.run(({ db }) => db.patch(ids.session, { agent_started_at: 101 })),
  ],
];
test.each(accessChanges)(
  "%s revokes the screen and the next renewal",
  async (_label, change) => {
    const fixture = await terminalWatchFixture();
    const { args, viewer, owner, start } = fixture;
    const { lease } = await start();
    await change(fixture);
    expect(await viewer.query(watch.screen, lease)).toBeNull();
    expect(await viewer.query(watch.status, args)).toBeNull();
    expect(await viewer.mutation(watch.watch, { ...lease, renew: true })).toBe(
      false,
    );
    expect(await owner.query(watch.watchers, args)).toEqual([]);
  },
);

test("the daemon reporting a replaced pane revokes the grant without publishing its screen", async () => {
  const { t, owner, viewer, args, start } = await terminalWatchFixture();
  const { lease, push } = await start();
  expect(
    await t.mutation(watch.cliPush, {
      ...push,
      pane_instance: "different",
      frame: "replacement screen",
    }),
  ).toEqual({ stop: true });
  expect(await viewer.query(watch.screen, lease)).toBeNull();
  expect(await owner.query(watch.status, args)).toMatchObject({
    enabled: false,
  });
});

test("presence writes at most once per renewal window and expired viewers are pruned", async () => {
  const { t, viewer, owner, args, start } = await terminalWatchFixture();
  const { lease } = await start();
  const first = await owner.query(watch.watchers, args);
  await viewer.mutation(watch.watch, { ...lease, renew: true });
  expect(await owner.query(watch.watchers, args)).toEqual(first);
  const clock = spyOn(Date, "now").mockReturnValue(first[0]!.expires_at + 1);
  try {
    expect(await viewer.query(watch.screen, lease)).toBeNull();
    expect(await viewer.mutation(watch.watch, { ...lease, renew: true })).toBe(
      false,
    );
    expect(await owner.query(watch.watchers, args)).toEqual([]);
    await t.mutation(internal.terminalWatch.pruneExpired, {});
    expect(
      await t.run(({ db }) => db.query("terminal_watch_viewers").collect()),
    ).toEqual([]);
  } finally {
    clock.mockRestore();
  }
});

test("a share cannot be used to watch another conversation and retries do not dispatch again", async () => {
  const { t, ids, viewer, owner, start } = await terminalWatchFixture();
  const { lease } = await start();
  const other = await t.run(({ db }) =>
    fixtureRows(db, "second terminal session").conversation(ids.owner, {
      team_id: ids.otherTeam,
      is_private: false,
      owner_device_id: "other-device",
    }),
  );
  expect(
    await viewer.query(watch.screen, { ...lease, conversation_id: other }),
  ).toBeNull();
  expect(
    await viewer.mutation(watch.watch, {
      ...lease,
      conversation_id: other,
      renew: false,
    }),
  ).toBe(false);
  expect(await viewer.mutation(watch.watch, { ...lease, renew: false })).toBe(
    true,
  );
  expect(
    await t.run(({ db }) => db.query("daemon_commands").collect()),
  ).toHaveLength(1);
  expect(
    await owner.mutation(api.terminalStream.watchPane, {
      device_id: "other-device",
      target,
    }),
  ).toMatchObject({ ok: true });
});

test("viewer rows are capped per grant and a stopped viewer cannot consume another row", async () => {
  const { t, ids, owner, viewer, args, start } = await terminalWatchFixture();
  const { lease } = await start();
  const more = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "many terminal viewers");
    const conversation = await db.get(ids.conversation_id);
    const accounts = [];
    for (let i = 0; i < 24; i++) {
      const account = await rows.user();
      await rows.membership(account, conversation!.team_id!);
      accounts.push(account);
    }
    return accounts;
  });
  for (const user of more.slice(0, 23)) {
    expect(
      await asUser(t, user).mutation(watch.watch, { ...lease, renew: false }),
    ).toBe(true);
  }
  expect(
    await asUser(t, more[23]!).mutation(watch.watch, {
      ...lease,
      renew: false,
    }),
  ).toBe(false);
  await owner.mutation(watch.stopViewer, { ...args, viewer: ids.viewer });
  expect(await viewer.mutation(watch.watch, { ...lease, renew: false })).toBe(
    false,
  );
  expect(
    await t.run(({ db }) => db.query("terminal_watch_viewers").collect()),
  ).toHaveLength(24);
});

test("when the last viewer loses access, the daemon stops and the snapshot is deleted", async () => {
  const { t, ids, start } = await terminalWatchFixture();
  const { push } = await start();
  await t.run(({ db }) => db.delete(ids.membership));
  expect(await t.mutation(watch.cliPush, push)).toEqual({ stop: true });
  expect(
    await t.run(({ db }) => db.query("terminal_watch_screens").collect()),
  ).toEqual([]);
});

test("a team agent machine keeps the existing relay for its session owner", async () => {
  const { t, ids, args, viewer } = await terminalWatchFixture();
  await t.run(async ({ db }) => {
    const session = await db.get(ids.conversation_id);
    await db.patch(ids.owner, { is_bot: true, team_id: session!.team_id });
    await db.patch(ids.conversation_id, { owner_user_id: ids.viewer });
  });
  expect(
    await viewer.mutation(watch.setSharing, { ...args, enabled: true }),
  ).toBe(false);
  expect(await viewer.query(watch.status, args)).toBeNull();
  expect(
    await viewer.mutation(api.terminalStream.watchPane, {
      ...args,
      device_id: deviceId,
      target,
    }),
  ).toMatchObject({ ok: true });
});

test("the daemon HTTP route returns only a stop flag and a silent stream expires", async () => {
  const { t, viewer, start } = await terminalWatchFixture();
  const { lease, push } = await start();
  const response = await t.fetch("/cli/terminal/team-frame", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(push),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ stop: false });
  const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 13_000);
  try {
    expect(await viewer.query(watch.screen, lease)).toMatchObject({
      text: null,
    });
    clock.mockReturnValue(Date.now() + 61_000);
    await t.mutation(internal.terminalWatch.pruneExpired, {});
    expect(
      await t.run(({ db }) => db.query("terminal_watch_screens").collect()),
    ).toEqual([]);
  } finally {
    clock.mockRestore();
  }
});

test("ordinary session purge deletes the share, screen, and viewer rows", async () => {
  const { t, args, start } = await terminalWatchFixture();
  await start();
  expect(
    await t.mutation(internal.sessionDelete.purgeConversationRows, args),
  ).toMatchObject({ done: true });
  await t.run(async ({ db }) => {
    expect(await db.query("terminal_watch_shares").collect()).toEqual([]);
    expect(await db.query("terminal_watch_screens").collect()).toEqual([]);
    expect(await db.query("terminal_watch_viewers").collect()).toEqual([]);
  });
});
