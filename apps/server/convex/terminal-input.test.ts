import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { PANE_MAX_PENDING_INPUT_BYTES } from "@codecast/daemon/terminalStream";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { api, internal } from "./_generated/api";
import { asUser } from "../test-helpers/database.testkit";
import {
  deviceId,
  target,
  terminalWatchFixture,
} from "../test-helpers/terminal-watch.testkit";

const typing = api.terminalInput;
const flag = "CODECAST_TERMINAL_TYPING";
const previous = process.env[flag];

beforeEach(() => {
  process.env[flag] = "1";
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  if (previous === undefined) delete process.env[flag];
  else process.env[flag] = previous;
});

async function fixture() {
  const world = await terminalWatchFixture();
  const { t, owner, viewer, args, ids, start, token } = world;
  const { lease } = await start();
  const pane = { ...args, pane_instance: 1 };
  const machine = {
    ...args,
    api_token: token,
    device_id: deviceId,
    agent_started_at: 100,
  };
  const second = asUser(t, ids.secondViewer);
  await second.mutation(api.terminalWatch.watch, { ...lease, renew: false });
  const report = (
    pane_instance: number,
    observation: "started" | "ended" = "started",
  ) =>
    t.mutation(typing.cliReportPane, {
      ...machine,
      pane_instance,
      observation,
      watch_pane_instance: "pane-generation",
    });
  const grant = (user_id = ids.viewer, enabled = true) =>
    owner.mutation(typing.setTypingGrant, { ...args, user_id, enabled });
  const focus = (
    account = viewer,
    request_id = "initial",
    expected_token = 0,
    pane_instance = 1,
  ) =>
    account.mutation(typing.focus, {
      ...pane,
      pane_instance,
      request_id,
      expected_token,
    });
  const poll = (
    sequence?: number,
    acceptedToken: number | null = 1,
    pane_instance = 1,
  ) =>
    t.mutation(typing.cliPoll, {
      ...machine,
      pane_instance,
      ...(sequence === undefined
        ? {}
        : { ack: { sequence, token: acceptedToken } }),
    });
  const send = (
    account = viewer,
    leaseToken = 1,
    pane_instance = 1,
    data = "61",
  ) =>
    account.mutation(typing.send, {
      ...pane,
      pane_instance,
      token: leaseToken,
      data,
    });
  const grantAndFocus = async () => {
    expect(await grant()).toBe(true);
    expect(await focus()).toMatchObject({ status: "held", token: 1 });
    const response = await poll();
    if (response.status !== "ok") throw new Error("Expected a control message");
    const { control } = response;
    expect(control).toMatchObject({ token: 1, pane_instance: 1 });
    return control;
  };
  return {
    ...world,
    lease,
    second,
    pane,
    machine,
    report,
    grant,
    focus,
    poll,
    send,
    grantAndFocus,
  };
}

test("typing is off by default and leaves existing watch and own-device input available", async () => {
  delete process.env[flag];
  const f = await fixture();
  expect(await f.report(1)).toMatchObject({ status: "disabled" });
  expect(await f.grant()).toBe(false);
  expect(await f.focus()).toMatchObject({ status: "disabled" });
  expect(await f.send()).toMatchObject({ status: "stale" });
  expect(await f.t.run(({ db }) => db.query("claims").collect())).toEqual([]);
  const legacy = { ...f.args, device_id: deviceId, target };
  await f.owner.mutation(api.terminalStream.watchPane, legacy);
  await f.t.mutation(api.terminalStream.cliPushFrame, {
    api_token: f.token,
    device_id: deviceId,
    target,
  });
  expect(
    await f.owner.mutation(api.terminalStream.sendPaneInput, {
      ...legacy,
      data: "61",
    }),
  ).toEqual({ ok: true });
});

test("one typist wins a simultaneous focus; a read grant alone cannot type", async () => {
  const f = await fixture();
  expect(await f.report(1)).toMatchObject({ status: "ok" });
  expect(await f.focus()).toMatchObject({ status: "forbidden" });
  expect(
    await f.viewer.mutation(typing.setTypingGrant, {
      ...f.args,
      user_id: f.ids.viewer,
      enabled: true,
    }),
  ).toBe(false);
  expect(await f.grant(f.ids.outsider)).toBe(false);
  expect(await f.grant()).toBe(true);
  expect(await f.grant(f.ids.secondViewer)).toBe(true);
  const result = await Promise.all([
    f.focus(f.viewer, "first"),
    f.focus(f.second, "second"),
  ]);
  expect(result.map(({ status }) => status).sort()).toEqual([
    "held",
    "stale_request",
  ]);
  const loser = result[0].status === "held" ? f.second : f.viewer;
  expect(await f.focus(loser, "sees-current-token", 1)).toMatchObject({
    status: "busy",
  });
  const rows = await f.t.run(({ db }) => db.query("claims").collect());
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    kind: "terminal",
    token: 1,
    pane_instance: 1,
  });
});

test("only the current holder, pane and token can submit; ready input drains once", async () => {
  const f = await fixture();
  await f.report(1);
  const control = await f.grantAndFocus();
  expect(await f.send()).toMatchObject({ status: "not_ready" });
  expect(await f.poll(control.sequence - 1)).toMatchObject({ status: "stale" });
  expect(await f.poll(control.sequence, 99)).toMatchObject({ status: "stale" });
  const ready = await f.poll(control.sequence);
  expect(ready).toMatchObject({ status: "ok", control });
  expect(await f.viewer.query(typing.status, f.args)).toMatchObject({
    ready: true,
    token: 1,
  });
  expect(await f.send(f.owner)).toMatchObject({ status: "stale" });
  expect(await f.send(f.viewer, 99)).toMatchObject({ status: "stale" });
  expect(await f.send(f.viewer, 1, 2)).toMatchObject({ status: "stale" });
  expect(await f.send(f.viewer, 1, 1, "gg")).toMatchObject({
    status: "invalid_input",
  });
  expect(await f.send()).toEqual({ status: "accepted" });
  expect(await f.send(f.viewer, 1, 1, "62")).toEqual({ status: "accepted" });
  expect(await f.poll()).toMatchObject({
    input: { pane_instance: 1, token: 1, data: "6162" },
  });
  expect(await f.poll()).not.toHaveProperty("input");
});

test("a pane restart invalidates the claim and queued keys, even if an old start arrives", async () => {
  const f = await fixture();
  await f.report(1);
  const control = await f.grantAndFocus();
  await f.poll(control.sequence);
  expect(await f.send()).toEqual({ status: "accepted" });
  expect(await f.report(2)).toMatchObject({ status: "ok" });
  expect(await f.report(1)).toMatchObject({ status: "stale" });
  expect(await f.report(1, "ended")).toMatchObject({ status: "stale" });
  expect(await f.send()).toMatchObject({ status: "stale" });
  expect(await f.poll(undefined, null, 2)).toMatchObject({
    control: { pane_instance: 2, token: null },
  });
  expect(await f.poll(undefined, null, 2)).not.toHaveProperty("input");
  expect(await f.focus(f.owner, "new-pane", 1, 2)).toMatchObject({
    status: "held",
    token: 2,
  });
  expect(await f.report(2, "ended")).toMatchObject({ status: "ok" });
  expect(await f.report(2)).toMatchObject({ status: "stale" });
  expect(await f.send(f.owner, 2, 2)).toMatchObject({ status: "stale" });
});

test("revoking a grant purges queued keys before the machine acknowledges it", async () => {
  const f = await fixture();
  await f.report(1);
  const control = await f.grantAndFocus();
  await f.poll(control.sequence);
  expect(await f.send()).toEqual({ status: "accepted" });
  expect(await f.grant(f.ids.viewer, false)).toBe(true);
  const stoppedClaim = await f.t.run(({ db }) => db.query("claims").unique());
  expect(stoppedClaim?.terminal?.pending_input).toBeUndefined();
  expect(await f.send()).toMatchObject({ status: "stale" });
  expect(await f.focus(f.viewer, "again", 1)).toMatchObject({
    status: "forbidden",
  });
  expect(await f.poll(control.sequence)).toMatchObject({ status: "stale" });
  const stopped = await f.poll();
  if (stopped.status !== "ok") throw new Error("Expected the revoke control");
  expect(stopped.control.token).toBeNull();
  expect(stopped.control.sequence).toBeGreaterThan(control.sequence);
  expect(stopped).not.toHaveProperty("input");
  expect(await f.poll(stopped.control.sequence, null)).toMatchObject({
    status: "ok",
  });
  expect(await f.send()).toMatchObject({ status: "stale" });
});

test("a stopped token stays stopped across release and delayed focus retries", async () => {
  const f = await fixture();
  await f.report(1);
  const old = await f.grantAndFocus();
  expect(
    await f.viewer.mutation(typing.release, { ...f.pane, token: 1 }),
  ).toMatchObject({ status: "cleared" });
  expect(await f.focus()).toMatchObject({ status: "inactive_request" });
  expect(await f.focus(f.viewer, "refocus", 1)).toMatchObject({
    status: "held",
    token: 2,
  });
  expect(await f.poll(old.sequence)).toMatchObject({ status: "stale" });
  expect(await f.send()).toMatchObject({ status: "stale" });
  expect(
    await f.viewer.mutation(typing.release, { ...f.pane, token: 1 }),
  ).toMatchObject({ status: "stale" });
  expect(
    await f.owner.mutation(typing.revoke, { ...f.pane, token: 2 }),
  ).toMatchObject({ status: "cleared" });
  expect(await f.focus(f.viewer, "refocus", 1)).toMatchObject({
    status: "inactive_request",
  });
});

test("the lost-connection deadline clears keys and a late renewal cannot revive it", async () => {
  const f = await fixture();
  await f.report(1);
  const control = await f.grantAndFocus();
  await f.poll(control.sequence);
  await f.send();
  jest.advanceTimersByTime(7_000);
  expect(
    await f.viewer.mutation(typing.renew, { ...f.pane, token: 1 }),
  ).toMatchObject({ status: "held" });
  jest.advanceTimersByTime(13_000);
  await f.t.finishInProgressScheduledFunctions();
  expect(await f.send()).toEqual({ status: "accepted" });
  jest.advanceTimersByTime(7_000);
  await f.t.finishInProgressScheduledFunctions();
  const expiredClaim = await f.t.run(({ db }) => db.query("claims").unique());
  expect(expiredClaim?.holder).toBeUndefined();
  expect(expiredClaim?.terminal?.pending_input).toBeUndefined();
  expect(await f.send()).toMatchObject({ status: "stale" });
  expect(
    await f.viewer.mutation(typing.renew, { ...f.pane, token: 1 }),
  ).toMatchObject({ status: "stale" });
  expect(await f.poll()).toMatchObject({ control: { token: null } });
  expect(await f.poll()).not.toHaveProperty("input");
  expect(await f.focus(f.owner, "after-timeout", 1)).toMatchObject({
    status: "held",
    token: 2,
  });
});

test("legacy aliases cannot bypass a lease, even if an owner queued legacy input first", async () => {
  const f = await fixture();
  const alias = { device_id: deviceId, target: "%1" };
  const push = { ...alias, api_token: f.token };
  expect(
    await f.owner.mutation(api.terminalStream.watchPane, alias),
  ).toMatchObject({ ok: true });
  await f.t.mutation(api.terminalStream.cliPushFrame, push);
  expect(
    await f.owner.mutation(api.terminalStream.sendPaneInput, {
      ...alias,
      data: "61",
    }),
  ).toEqual({ ok: true });
  await f.report(1);
  expect(
    await f.owner.mutation(api.terminalStream.sendPaneInput, {
      ...alias,
      data: "62",
    }),
  ).toMatchObject({ ok: false, reason: "stale" });
  expect(
    await f.t.mutation(api.terminalStream.cliPushFrame, push),
  ).not.toHaveProperty("input");
});

test("only the bound machine for the current process can report a pane or collect keys", async () => {
  const f = await fixture();
  await f.report(1);
  const control = await f.grantAndFocus();
  await f.poll(control.sequence);
  await f.send();
  expect(
    await f.t.mutation(typing.cliPoll, {
      ...f.machine,
      device_id: "other-device",
      pane_instance: 1,
    }),
  ).toMatchObject({ status: "stale" });
  await f.t.run(({ db }) => db.patch(f.ids.session, { agent_started_at: 200 }));
  expect(await f.send()).toMatchObject({ status: "stale" });
  expect(await f.poll()).toMatchObject({ status: "stale" });
  expect(await f.report(2)).toMatchObject({ status: "stale" });
  expect(
    await f.t.mutation(typing.cliReportPane, {
      ...f.machine,
      agent_started_at: 200,
      pane_instance: 2,
      observation: "started",
    }),
  ).toMatchObject({ status: "ok" });
  expect(
    await f.t.mutation(typing.cliPoll, {
      ...f.machine,
      agent_started_at: 200,
      pane_instance: 2,
    }),
  ).not.toHaveProperty("input");
});

test("a new read connection cannot revive the old typing lease", async () => {
  const f = await fixture();
  await f.report(1);
  const control = await f.grantAndFocus();
  await f.poll(control.sequence);
  await f.send();
  await f.viewer.mutation(api.terminalWatch.leave, f.lease);
  expect(
    await f.viewer.mutation(api.terminalWatch.watch, {
      ...f.lease,
      renew: false,
    }),
  ).toBe(true);
  expect(await f.send()).toEqual({ status: "stale" });
  expect(await f.poll()).not.toHaveProperty("input");
  expect(await f.focus(f.viewer, "new-connection", 1)).toMatchObject({
    status: "held",
    token: 2,
  });
});

test("session deletion removes grants as well as the typing claim", async () => {
  const f = await fixture();
  await f.report(1);
  await f.grantAndFocus();
  expect(
    await f.owner.mutation(api.sessionDelete.deleteSession, f.args),
  ).toEqual({
    deleted: 1,
  });
  await f.t.finishAllScheduledFunctions(() => jest.runAllTimers());
  expect(
    await f.t.run(({ db }) => db.query("terminal_typing_grants").collect()),
  ).toEqual([]);
  expect(await f.t.run(({ db }) => db.query("claims").collect())).toEqual([]);
});

test("team deletion removes grants stamped with that team even if the session moved", async () => {
  const f = await fixture();
  expect(await f.grant()).toBe(true);
  await f.t.run(async ({ db }) => {
    await db.patch(f.ids.team, {
      name: "Old terminal team",
      policy: { regulated_data: true },
    });
    await db.patch(f.ids.conversation_id, { team_id: f.ids.otherTeam });
  });
  await f.owner.mutation(api.regulatedDeletion.destroyTeam, {
    team_id: f.ids.team,
    confirm_name: "Old terminal team",
  });
  await f.t.finishAllScheduledFunctions(() => jest.runAllTimers());
  expect(
    await f.t.run(({ db }) => db.get(f.ids.conversation_id)),
  ).not.toBeNull();
  expect(
    await f.t.run(({ db }) => db.query("terminal_typing_grants").collect()),
  ).toEqual([]);
});

test("account deletion clears a grantee's buffered keys and retains the fence", async () => {
  const f = await fixture();
  await f.report(1);
  const control = await f.grantAndFocus();
  await f.poll(control.sequence);
  expect(await f.send()).toEqual({ status: "accepted" });
  await f.t.mutation(internal.accountDelete.purgeAccount, {
    user_id: f.ids.viewer,
  });
  expect(
    await f.t.run(({ db }) => db.query("terminal_typing_grants").collect()),
  ).toEqual([]);
  const claim = await f.t.run(({ db }) => db.query("claims").unique());
  expect(claim?.holder).toBeUndefined();
  expect(claim?.terminal?.pending_input).toBeUndefined();
  expect(claim?.token).toBe(1);
  expect(claim?.terminal?.sequence).toBeGreaterThan(control.sequence);
});

test("account deletion removes grants from a former machine owner", async () => {
  const f = await fixture();
  expect(await f.grant()).toBe(true);
  await f.t.run(({ db }) =>
    db.patch(f.ids.conversation_id, { user_id: f.ids.secondViewer }),
  );
  await f.t.mutation(internal.accountDelete.purgeAccount, {
    user_id: f.ids.owner,
  });
  await f.t.finishAllScheduledFunctions(() => jest.runAllTimers());
  expect(
    await f.t.run(({ db }) => db.get(f.ids.conversation_id)),
  ).not.toBeNull();
  expect(
    await f.t.run(({ db }) => db.query("terminal_typing_grants").collect()),
  ).toEqual([]);
});

test.each(["owner", "viewer"] as const)(
  "account merge revokes grants involving the source %s",
  async (source) => {
    const f = await fixture();
    await f.report(1);
    const control = await f.grantAndFocus();
    await f.poll(control.sequence);
    expect(await f.send()).toEqual({ status: "accepted" });
    await f.t.mutation(internal.admin_mergeUser.mergeDuplicateUser, {
      from_user_id: f.ids[source],
      to_user_id: f.ids.secondViewer,
      dry_run: false,
    });
    expect(
      await f.t.run(({ db }) => db.query("terminal_typing_grants").collect()),
    ).toEqual([]);
    const claim = await f.t.run(({ db }) => db.query("claims").unique());
    expect(claim?.holder).toBeUndefined();
    expect(claim?.terminal?.pending_input).toBeUndefined();
  },
);

function legacyInput(
  f: Awaited<ReturnType<typeof fixture>>,
  owner = f.owner,
  token = f.token,
) {
  const pane = { device_id: deviceId, target: "%1" };
  return {
    watch: () => owner.mutation(api.terminalStream.watchPane, pane),
    push: () =>
      f.t.mutation(api.terminalStream.cliPushFrame, {
        ...pane,
        api_token: token,
      }),
    send: () =>
      owner.mutation(api.terminalStream.sendPaneInput, { ...pane, data: "61" }),
  };
}

test.each(["ended", "killed", "unregistered"] as const)(
  "a %s pane closes the fence and restores legacy input",
  async (reason) => {
    const f = await fixture();
    const legacy = legacyInput(f);
    await legacy.watch();
    await legacy.push();
    await f.report(1);
    const control = await f.grantAndFocus();
    await f.poll(control.sequence);
    expect(await f.send()).toEqual({ status: "accepted" });
    expect(await legacy.send()).toMatchObject({ reason: "stale" });
    if (reason === "ended") await f.report(1, "ended");
    else if (reason === "killed")
      await f.owner.mutation(api.conversations.killSession, f.args);
    else
      await f.owner.mutation(api.managedSessions.unregisterManagedSession, {
        session_id: "watch-session",
      });

    const claim = await f.t.run(({ db }) => db.query("claims").unique());
    expect(claim?.terminal?.open).toBe(false);
    expect(claim?.terminal?.grant).toBeUndefined();
    expect(claim?.terminal?.pending_input).toBeUndefined();
    expect(claim?.holder).toBeUndefined();
    expect(await f.send()).toEqual({ status: "stale" });
    await legacy.push();
    expect(await legacy.send()).toEqual({ ok: true });
    expect(await legacy.push()).toMatchObject({ input: "61" });
  },
);

test("report and poll extend the open fence, which expires without a daemon", async () => {
  const f = await fixture();
  const legacy = legacyInput(f);
  await legacy.watch();
  await f.report(1);
  jest.advanceTimersByTime(20_000);
  await f.report(1);
  jest.advanceTimersByTime(15_000);
  await legacy.push();
  expect(await legacy.send()).toMatchObject({ reason: "stale" });
  expect(await f.focus(f.owner)).toMatchObject({ status: "held" });
  const polled = await f.poll();
  if (polled.status !== "ok") throw new Error("Expected a poll");
  await f.poll(polled.control.sequence);
  expect(await f.send(f.owner)).toEqual({ status: "accepted" });
  jest.advanceTimersByTime(19_000);
  expect(
    await f.owner.mutation(typing.renew, { ...f.pane, token: 1 }),
  ).toMatchObject({ status: "held" });
  await legacy.push();
  expect(await legacy.send()).toMatchObject({ reason: "stale" });
  jest.advanceTimersByTime(11_000);
  expect(await f.owner.query(typing.status, f.args)).toBeNull();
  expect(await f.focus(f.owner)).toEqual({ status: "stale" });
  await legacy.push();
  expect(await legacy.send()).toEqual({ ok: true });
  expect(await legacy.push()).toMatchObject({ input: "61" });
  const reopened = await f.poll();
  expect(reopened).toMatchObject({ status: "ok", control: { token: null } });
  expect(reopened).not.toHaveProperty("input");
});

test("a live fence does not affect another user's identical device ID", async () => {
  const f = await fixture();
  const secret = "terminal-test-legacy-viewer";
  await f.t.run(async ({ db }) => {
    const rows = fixtureRows(db, "terminal identical device");
    await rows.device(f.ids.viewer, { device_id: deviceId });
    await rows.token(f.ids.viewer, secret);
  });
  const ownerLegacy = legacyInput(f);
  const viewerLegacy = legacyInput(f, f.viewer, secret);
  await ownerLegacy.watch();
  await viewerLegacy.watch();
  await f.report(1);
  await ownerLegacy.push();
  await viewerLegacy.push();
  expect(await ownerLegacy.send()).toMatchObject({ reason: "stale" });
  expect(await viewerLegacy.send()).toEqual({ ok: true });
  expect(await viewerLegacy.push()).toMatchObject({ input: "61" });
  expect(await ownerLegacy.push()).not.toHaveProperty("input");
});

test("explicit team privacy denies new grants and disables existing typing access", async () => {
  const f = await fixture();
  await f.report(1);
  const control = await f.grantAndFocus();
  await f.poll(control.sequence);
  expect(await f.send()).toEqual({ status: "accepted" });
  await f.t.run(({ db }) =>
    db.patch(f.ids.conversation_id, {
      team_visibility: "private",
      is_private: false,
    }),
  );
  expect(await f.grant(f.ids.secondViewer)).toBe(false);
  expect(await f.viewer.query(typing.status, f.args)).toBeNull();
  expect(await f.owner.query(typing.status, f.args)).toMatchObject({
    busy: false,
    remainingMs: 0,
  });
  expect(await f.send()).toEqual({ status: "stale" });
  expect(await f.poll()).not.toHaveProperty("input");
  expect(await f.focus(f.viewer, "after-private", 1)).toEqual({
    status: "forbidden",
  });
});

async function promoteSecond(f: Awaited<ReturnType<typeof fixture>>) {
  await f.t.run(async ({ db }) => {
    const membership = await db
      .query("team_memberships")
      .withIndex("by_user_team", (q) =>
        q.eq("user_id", f.ids.secondViewer).eq("team_id", f.ids.team),
      )
      .unique();
    if (!membership) throw new Error("Expected a second member");
    await db.patch(membership._id, { role: "admin" });
  });
}

test.each(["owner", "viewer"] as const)(
  "a removed %s cannot restore an old grant by rejoining",
  async (departing) => {
    const f = await fixture();
    await f.report(1);
    const control = await f.grantAndFocus();
    await f.poll(control.sequence);
    expect(await f.send()).toEqual({ status: "accepted" });
    await promoteSecond(f);
    await f.second.mutation(api.teams.removeFromTeam, {
      team_id: f.ids.team,
      user_id: f.ids[departing],
    });
    await f.t.run(async ({ db }) => {
      expect(await db.query("terminal_typing_grants").collect()).toEqual([]);
      const claim = await db.query("claims").unique();
      expect(claim?.holder).toBeUndefined();
      expect(claim?.terminal?.pending_input).toBeUndefined();
      await fixtureRows(db, "terminal member rejoins").membership(
        f.ids[departing],
        f.ids.team,
        { visibility: "full" },
      );
    });
    const lease = departing === "owner" ? await f.enable() : f.lease;
    expect(
      await f.viewer.mutation(api.terminalWatch.watch, {
        ...lease,
        renew: false,
      }),
    ).toBe(true);
    expect(await f.focus(f.viewer, "rejoined", 1)).toEqual({
      status: "forbidden",
    });
  },
);

test("team watch purge drains orphan typing grants and their buffered input", async () => {
  const f = await fixture();
  await f.report(1);
  const control = await f.grantAndFocus();
  await f.poll(control.sequence);
  expect(await f.send()).toEqual({ status: "accepted" });
  await promoteSecond(f);
  await f.t.run(async ({ db }) => {
    await db.delete(f.ids.ownerMembership);
    await db.delete(f.ids.membership);
  });
  const team = await f.t.run(({ db }) => db.get(f.ids.team));
  if (!team) throw new Error("Expected a team");
  expect(
    await f.second.mutation(api.teams.deleteTeam, {
      team_id: f.ids.team,
      confirm_name: team.name,
    }),
  ).toMatchObject({ deleted: true });
  await f.t.mutation(internal.terminalWatch.purgeTeamRows, {
    team_id: f.ids.team,
  });
  await f.t.run(async ({ db }) => {
    expect(await db.query("terminal_typing_grants").collect()).toEqual([]);
    const claim = await db.query("claims").unique();
    expect(claim?.holder).toBeUndefined();
    expect(claim?.terminal?.pending_input).toBeUndefined();
  });
});

test("a legacy grant pinned to an ended membership fails after an out-of-band rejoin", async () => {
  const f = await fixture();
  await f.report(1);
  expect(await f.grant()).toBe(true);
  await f.t.run(async ({ db }) => {
    await db.delete(f.ids.membership);
    await fixtureRows(db, "terminal stale grant").membership(
      f.ids.viewer,
      f.ids.team,
    );
  });
  expect(await f.focus()).toEqual({ status: "forbidden" });
});

test.each(["blocked", "expired", "revoked"] as const)(
  "%s watch presence cannot keep a typing lease busy or release buffered input",
  async (state) => {
    const f = await fixture();
    await f.report(1);
    const control = await f.grantAndFocus();
    await f.poll(control.sequence);
    expect(await f.send()).toEqual({ status: "accepted" });
    await f.t.run(async ({ db }) => {
      const presence = await db
        .query("terminal_watch_viewers")
        .withIndex("by_share_user", (q) =>
          q.eq("share", f.lease.share).eq("user_id", f.ids.viewer),
        )
        .unique();
      if (!presence) throw new Error("Expected live watch presence");
      if (state === "blocked")
        await db.insert("terminal_watch_blocks", {
          ...f.args,
          team_id: f.ids.team,
          user_id: f.ids.viewer,
        });
      else
        await db.patch(
          presence._id,
          state === "expired" ? { expires_at: Date.now() } : { revoked: true },
        );
    });
    expect(await f.viewer.query(typing.status, f.args)).toBeNull();
    expect(await f.owner.query(typing.status, f.args)).toMatchObject({
      busy: false,
      remainingMs: 0,
    });
    expect(await f.send()).toEqual({ status: "stale" });
    expect(await f.poll()).not.toHaveProperty("input");
  },
);

test("the backlog cap rejects keys without disturbing queued input", async () => {
  const f = await fixture();
  await f.report(1);
  const control = await f.grantAndFocus();
  await f.poll(control.sequence);
  const full = "61".repeat(PANE_MAX_PENDING_INPUT_BYTES);
  expect(await f.send(f.viewer, 1, 1, full)).toEqual({ status: "accepted" });
  expect(await f.send()).toEqual({ status: "backlog" });
  expect(await f.poll()).toMatchObject({ input: { data: full } });
  expect(await f.poll()).not.toHaveProperty("input");
});

test("merging an owner clears buffered keys and receipts without transferring them", async () => {
  const f = await fixture();
  await f.report(1);
  expect(await f.focus(f.owner)).toMatchObject({ status: "held", token: 1 });
  const polled = await f.poll();
  if (polled.status !== "ok") throw new Error("Expected the owner's lease");
  await f.poll(polled.control.sequence);
  expect(await f.send(f.owner)).toEqual({ status: "accepted" });
  const receipt = await f.t.run(({ db }) =>
    db.insert("claims", {
      ...f.args,
      kind: "steer",
      lease_until: Date.now() + 30_000,
      holder: f.ids.viewer,
      token: 3,
      request_id: "earlier-request",
      request_holder: f.ids.owner,
    }),
  );
  const result = await f.t.mutation(
    internal.admin_mergeUser.mergeDuplicateUser,
    {
      from_user_id: f.ids.owner,
      to_user_id: f.ids.secondViewer,
      dry_run: false,
      delete_source: true,
    },
  );
  expect(result).toMatchObject({ source_deleted: true });
  await f.t.run(async ({ db }) => {
    expect(await db.get(f.ids.owner)).toBeNull();
    const claim = await db
      .query("claims")
      .withIndex("by_conversation_kind", (q) =>
        q.eq("conversation_id", f.ids.conversation_id).eq("kind", "terminal"),
      )
      .unique();
    expect(claim?.holder).toBeUndefined();
    expect(claim?.request_holder).toBeUndefined();
    expect(claim?.request_id).toBeUndefined();
    expect(claim?.terminal?.pending_input).toBeUndefined();
    expect(claim?.token).toBe(1);
    const other = await db.get(receipt);
    expect(other?.holder).toBe(f.ids.viewer);
    expect(other?.request_holder).toBeUndefined();
    expect(other?.request_id).toBeUndefined();
  });
});
