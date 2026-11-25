import { expect, spyOn, test } from "bun:test";
import {
  DEVICE_BOUND_TOKEN_PREFIX,
  presentToken,
} from "@platform/auth/tokenFormat";
import { endMembership } from "./lib/teamMembershipEnd";
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
  ).toHaveLength(1);
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
    revision: expect.any(Number),
    stale_in_ms: expect.any(Number),
    expires_in_ms: expect.any(Number),
  });
  expect(
    await owner.mutation(watch.cliPush, {
      ...push,
      api_token: "missing-token",
    }),
  ).toEqual({ stop: true });
  expect(
    await t.mutation(watch.cliPush, { ...push, device_id: "other-device" }),
  ).toEqual({ stop: true });
  expect(
    await t.mutation(watch.cliPush, { ...push, stream_id: "stale-stream" }),
  ).toEqual({ stop: true });
  expect(await t.mutation(watch.cliPush, push)).toEqual({ stop: false });
  expect(await owner.query(watch.watchers, args)).toEqual([
    {
      user_id: ids.viewer,
      name: "Viewer",
      expires_at: expect.any(Number),
      remaining_ms: expect.any(Number),
    },
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
    "owner left the team",
    ({ t, ids }) => t.run(({ db }) => db.delete(ids.ownerMembership)),
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
  expect(
    (await owner.query(watch.watchers, args)).map((row) => row.expires_at),
  ).toEqual(first.map((row) => row.expires_at));
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
  ).toHaveLength(2);
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
  ).toHaveLength(23);
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

test("a publisher needs a token bound to the exact runner device", async () => {
  const { t, ids, owner, start } = await terminalWatchFixture();
  const { push } = await start();
  const wrongDevice = "other-device";
  const unbound = "synthetic legacy terminal token";
  const otherSecret = DEVICE_BOUND_TOKEN_PREFIX + "synthetic-other-runner";
  await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "terminal publisher");
    const id = await rows.token(ids.owner, otherSecret);
    await db.patch(id, { device_id: wrongDevice });
    await rows.token(ids.owner, unbound);
  });
  expect(
    await owner.mutation(watch.cliPush, { ...push, api_token: "missing" }),
  ).toEqual({ stop: true });
  expect(
    await t.mutation(watch.cliPush, { ...push, api_token: unbound }),
  ).toEqual({ stop: true });
  expect(
    await t.mutation(watch.cliPush, {
      ...push,
      api_token: presentToken(otherSecret, wrongDevice),
      device_id: wrongDevice,
    }),
  ).toEqual({ stop: true });
  const lastUsed = () =>
    t.run(async ({ db }) =>
      (await db.query("api_tokens").collect()).map((row) => row.last_used_at),
    );
  await t.run(async ({ db }) => {
    for (const token of await db.query("api_tokens").collect())
      await db.patch(token._id, { last_used_at: 0 });
  });
  const before = await lastUsed();
  expect(await t.mutation(watch.cliPush, push)).toEqual({ stop: false });
  expect(await lastUsed()).toEqual(before);
  await owner.mutation(api.terminalStream.watchPane, {
    device_id: deviceId,
    target,
  });
  expect(
    await owner.mutation(api.terminalStream.cliPushFrame, {
      device_id: deviceId,
      target,
      api_token: "missing",
      frame,
    }),
  ).toMatchObject({ stop: true });
  expect(
    await t.mutation(api.terminalStream.cliPushFrame, {
      device_id: deviceId,
      target,
      api_token: unbound,
      frame,
    }),
  ).toMatchObject({ stop: true });
});

test("the owner binds the pane before any viewer can join, and a different first frame ends sharing", async () => {
  const { t, owner, viewer, token, args } = await terminalWatchFixture();
  expect(
    await owner.mutation(watch.setSharing, { ...args, enabled: true }),
  ).toBe(true);
  const pending = await t.run(({ db }) =>
    db.query("terminal_watch_shares").first(),
  );
  const share = pending!._id;
  const lease = { ...args, share };
  expect(await viewer.query(watch.status, args)).toBeNull();
  expect(await viewer.mutation(watch.watch, { ...lease, renew: false })).toBe(
    false,
  );
  const run = { api_token: token, device_id: deviceId, share };
  expect(
    await t.mutation(watch.cliBind, { ...run, pane_instance: "original" }),
  ).toBe(true);
  expect(
    await t.mutation(watch.cliBind, { ...run, pane_instance: "different" }),
  ).toBe(false);
  expect(await viewer.mutation(watch.watch, { ...lease, renew: false })).toBe(
    true,
  );
  const screen = await t.run(({ db }) =>
    db.query("terminal_watch_screens").first(),
  );
  expect(
    await t.mutation(watch.cliPush, {
      ...run,
      stream_id: screen!.stream_id,
      pane_instance: "different",
      frame,
    }),
  ).toEqual({ stop: true });
  expect(await viewer.query(watch.screen, lease)).toBeNull();
});

test("the first metrics stamp preserves the binding, but ambiguous managed sessions deny it", async () => {
  const { t, ids, viewer, start } = await terminalWatchFixture();
  await t.run(({ db }) =>
    db.patch(ids.session, { agent_started_at: undefined }),
  );
  const { lease } = await start();
  await t.run(({ db }) => db.patch(ids.session, { agent_started_at: 100 }));
  expect(await viewer.query(watch.screen, lease)).toMatchObject({
    text: frame,
  });
  await t.run(({ db }) =>
    fixtureRows(db, "duplicate terminal pane").session(ids.owner, {
      conversation_id: ids.conversation_id,
      tmux_session: target,
    }),
  );
  expect(await viewer.query(watch.screen, lease)).toBeNull();
});

test("a private visibility override revokes a screen even when the public bit stays set", async () => {
  const { t, ids, viewer, start } = await terminalWatchFixture();
  const { lease } = await start();
  await t.run(({ db }) =>
    db.patch(ids.conversation_id, {
      is_private: false,
      team_visibility: "private",
    }),
  );
  expect(await viewer.query(watch.screen, lease)).toBeNull();
});

test("a block survives a new grant and the owner can unblock the viewer in one write", async () => {
  const { t, owner, viewer, args, ids, start, enable } =
    await terminalWatchFixture();
  const { push } = await start();
  await owner.mutation(watch.stopViewer, { ...args, viewer: ids.viewer });
  expect(
    await t.run(({ db }) => db.query("terminal_watch_screens").collect()),
  ).toEqual([]);
  expect(await t.mutation(watch.cliPush, push)).toEqual({ stop: true });
  await owner.mutation(watch.setSharing, { ...args, enabled: false });
  const next = await enable();
  expect(await viewer.mutation(watch.watch, { ...next, renew: false })).toBe(
    false,
  );
  expect(await owner.query(watch.blockedViewers, args)).toEqual([
    { user_id: ids.viewer, name: "Viewer" },
  ]);
  expect(
    await owner.mutation(watch.unblockViewer, { ...args, viewer: ids.viewer }),
  ).toBe(true);
  expect(await viewer.mutation(watch.watch, { ...next, renew: false })).toBe(
    true,
  );
});

test("explicit leave deletes the last screen and stops its publisher", async () => {
  const { t, viewer, start } = await terminalWatchFixture();
  const { lease, push } = await start();
  expect(await viewer.mutation(watch.leave, lease)).toBe(true);
  expect(
    await t.run(({ db }) => db.query("terminal_watch_screens").collect()),
  ).toEqual([]);
  expect(await viewer.query(watch.screen, lease)).toBeNull();
  expect(await t.mutation(watch.cliPush, push)).toEqual({ stop: true });
});

test.each([
  "owner account",
  "viewer account",
  "blocked viewer account",
  "owner membership",
  "team",
] as const)("terminal rows are purged after %s removal", async (which) => {
  const { t, owner, ids, start } = await terminalWatchFixture();
  const { lease } = await start();
  const second = asUser(t, ids.secondViewer);
  await second.mutation(watch.watch, { ...lease, renew: false });
  await owner.mutation(watch.stopViewer, {
    conversation_id: ids.conversation_id,
    viewer: ids.secondViewer,
  });
  if (which === "team") {
    const team = await t.run(({ db }) => db.get(ids.team));
    await owner.mutation(api.teams.deleteTeam, {
      team_id: ids.team,
      confirm_name: team!.name,
    });
    await t.mutation(internal.terminalWatch.purgeTeamRows, {
      team_id: ids.team,
    });
  } else if (which === "owner membership") {
    await t.run((ctx) => endMembership(ctx, ids.owner, ids.team));
  } else {
    await t.mutation(internal.accountDelete.purgeAccount, {
      user_id:
        which === "owner account"
          ? ids.owner
          : which === "blocked viewer account"
            ? ids.secondViewer
            : ids.viewer,
    });
    if (which === "owner account")
      await t.mutation(internal.sessionDelete.purgeConversationRows, {
        conversation_id: ids.conversation_id,
      });
  }
  const contents = await t.run(async ({ db }) => ({
    shares: await db.query("terminal_watch_shares").collect(),
    screens: await db.query("terminal_watch_screens").collect(),
    viewers: await db.query("terminal_watch_viewers").collect(),
    blocks: await db.query("terminal_watch_blocks").collect(),
  }));
  const stillWatched = which === "blocked viewer account";
  expect(contents.screens).toHaveLength(stillWatched ? 1 : 0);
  expect(contents.viewers).toHaveLength(stillWatched ? 1 : 0);
  expect(contents.shares).toHaveLength(
    which === "viewer account" || stillWatched ? 1 : 0,
  );
  expect(contents.blocks).toHaveLength(
    which === "viewer account" || which === "owner membership" ? 1 : 0,
  );
});

test("a regulated delete counts all terminal rows from a live grant", async () => {
  const { t, owner, ids, start } = await terminalWatchFixture();
  const { lease } = await start();
  await t.run(({ db }) =>
    db.patch(ids.team, { policy: { regulated_data: true } }),
  );
  await asUser(t, ids.secondViewer).mutation(watch.watch, {
    ...lease,
    renew: false,
  });
  await owner.mutation(watch.stopViewer, {
    conversation_id: ids.conversation_id,
    viewer: ids.secondViewer,
  });
  await owner.mutation(api.sessionDelete.deleteSession, {
    conversation_id: ids.conversation_id,
  });
  const deletion = await t.run(({ db }) => db.query("data_deletions").first());
  expect(
    await t.mutation(internal.regulatedDeletion.runDeletion, {
      deletion_id: deletion!._id,
      gen: deletion!.gen,
    }),
  ).toEqual({ done: true });
  expect(
    await t.run(async ({ db }) => (await db.get(deletion!._id))?.counts),
  ).toMatchObject({
    terminal_watch_shares: 1,
    terminal_watch_viewers: 1,
    terminal_watch_screens: 1,
    terminal_watch_blocks: 1,
  });
});

test("expired legacy revoked presence is purged without deleting the block", async () => {
  const { t, owner, ids, args, start } = await terminalWatchFixture();
  const { lease } = await start();
  await owner.mutation(watch.stopViewer, { ...args, viewer: ids.viewer });
  await t.run(({ db }) =>
    db.insert("terminal_watch_viewers", {
      share: lease.share,
      user_id: ids.viewer,
      revoked: true,
      expires_at: Date.now() - 1,
    }),
  );
  await t.mutation(internal.terminalWatch.pruneExpired, {});
  expect(
    await t.run(({ db }) => db.query("terminal_watch_viewers").collect()),
  ).toEqual([]);
  expect(await owner.query(watch.blockedViewers, args)).toHaveLength(1);
});
