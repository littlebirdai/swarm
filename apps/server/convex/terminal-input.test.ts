import { afterEach, beforeEach, expect, jest, test } from "bun:test";
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
