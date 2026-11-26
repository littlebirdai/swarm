import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import {
  DEVICE_BOUND_TOKEN_PREFIX,
  presentToken,
} from "@platform/auth/tokenFormat";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { terminalTypingFixture } from "../test-helpers/terminal-typing.testkit";
import { deviceId } from "../test-helpers/terminal-watch.testkit";
import { api, internal } from "./_generated/api";

const flag = "CODECAST_TERMINAL_TYPING";
const previous = process.env[flag];
const typing = api.terminalInput;

beforeEach(() => {
  process.env[flag] = "1";
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
  if (previous === undefined) delete process.env[flag];
  else process.env[flag] = previous;
});

type Fixture = Awaited<ReturnType<typeof terminalTypingFixture>>;
const claim = (f: Fixture) => f.t.run(({ db }) => db.query("claims").unique());

test("idle polls with an unchanged acknowledgement keep the device fence live", async () => {
  const f = await terminalTypingFixture();
  await f.report(1);
  const poll = await f.poll();
  if (poll.status !== "ok") throw new Error("Expected a control frame");
  const seq = poll.control.sequence;
  expect(poll.control.token).toBeNull();
  expect(await f.poll(seq, null)).toEqual(poll);
  const firstDeadline = (await claim(f))?.terminal?.live_until;
  for (let i = 0; i < 2; i++) {
    jest.advanceTimersByTime(20_000);
    expect(await f.poll(seq, null)).toEqual(poll);
  }
  expect((await claim(f))?.terminal?.live_until).toBe(firstDeadline! + 40_000);
  expect(await f.owner.query(typing.status, f.args)).toMatchObject({
    busy: false,
  });
  jest.advanceTimersByTime(30_000);
  expect(await f.owner.query(typing.status, f.args)).toBeNull();
});

test("reporting the same expired pane clears the holder and unsent input", async () => {
  const f = await terminalTypingFixture();
  await f.report(1);
  const control = await f.grantAndFocus();
  await f.poll(control.sequence);
  expect(await f.send()).toEqual({ status: "accepted" });
  jest.setSystemTime(Date.now() + 31_000);
  expect((await claim(f))?.holder).toBe(f.ids.viewer);
  expect((await claim(f))?.terminal?.pending_input).toBe("61");
  expect(await f.report(1, "started")).toMatchObject({ status: "ok" });
  const reopened = await claim(f);
  expect(reopened?.holder).toBeUndefined();
  expect(reopened?.lease_until).toBe(0);
  expect(reopened?.terminal?.pending_input).toBeUndefined();
  expect(reopened?.terminal?.sequence).toBeGreaterThan(control.sequence);
  expect(await f.poll()).not.toHaveProperty("input");
});

test("a non-owner bound to an identical device ID cannot extend the pane fence", async () => {
  const f = await terminalTypingFixture();
  const secret = DEVICE_BOUND_TOKEN_PREFIX + "terminal-non-owner";
  await f.t.run(async ({ db }) => {
    const rows = fixtureRows(db, "terminal non-owner bound token");
    await rows.device(f.ids.viewer, { device_id: deviceId });
    const token = await rows.token(f.ids.viewer, secret);
    await db.patch(token, { device_id: deviceId });
  });
  await f.report(1);
  const deadline = (await claim(f))?.terminal?.live_until;
  jest.advanceTimersByTime(10_000);
  const foreign = {
    ...f.machine,
    pane_instance: 1,
    api_token: presentToken(secret, deviceId),
  };
  expect(
    await f.t.mutation(typing.cliReportPane, {
      ...foreign,
      observation: "started",
      watch_pane_instance: "pane-generation",
    }),
  ).toEqual({ status: "stale" });
  expect(await f.t.mutation(typing.cliPoll, foreign)).toEqual({
    status: "stale",
  });
  expect((await claim(f))?.terminal?.live_until).toBe(deadline);
});

test("a bound watch generation cannot change within a pane instance", async () => {
  const f = await terminalTypingFixture();
  await f.report(1);
  const before = await claim(f);
  jest.advanceTimersByTime(10_000);
  const report = {
    ...f.machine,
    observation: "started" as const,
    watch_pane_instance: "different-generation",
  };
  expect(
    await f.t.mutation(typing.cliReportPane, { ...report, pane_instance: 1 }),
  ).toEqual({ status: "stale" });
  expect(await claim(f)).toEqual(before);
  expect(
    await f.t.mutation(typing.cliReportPane, { ...report, pane_instance: 2 }),
  ).toMatchObject({ status: "ok", last_pane_instance: 2 });
  expect((await claim(f))?.terminal?.watch_pane_instance).toBe(
    "different-generation",
  );
});

const budgets = { documentsRead: 350, documentsWritten: 225 };
const grants = (f: Fixture) =>
  f.t.run(({ db }) => db.query("terminal_typing_grants").collect());

async function seedGrantBatch(f: Fixture) {
  for (let page = 0; page < 5; page++) {
    await f.t.run(async ({ db }) => {
      const rows = fixtureRows(db, `terminal typing cleanup page ${page}`);
      for (let i = 0; i < (page === 4 ? 49 : 50); i++) {
        const conversation_id = await rows.conversation(f.ids.owner, {
          team_id: f.ids.team,
        });
        await db.insert("terminal_typing_grants", {
          conversation_id,
          user_id: f.ids.viewer,
          owner_id: f.ids.owner,
          team_id: f.ids.team,
          device: f.ids.device,
          membership: f.ids.membership,
          owner_membership: f.ids.ownerMembership,
          granted_at: Date.now(),
        });
      }
    });
  }
  await f.report(1);
  const control = await f.grantAndFocus();
  await f.poll(control.sequence);
  expect(await f.send()).toEqual({ status: "accepted" });
  expect(await grants(f)).toHaveLength(250);
}

test.each(["owner", "viewer"] as const)(
  "departing %s grants are fenced immediately and purged in bounded pages",
  async (departing) => {
    const f = await terminalTypingFixture(budgets);
    await seedGrantBatch(f);
    await f.t.run(async ({ db }) => {
      const second = await db
        .query("team_memberships")
        .withIndex("by_user_team", (q) =>
          q.eq("user_id", f.ids.secondViewer).eq("team_id", f.ids.team),
        )
        .unique();
      await db.patch(second!._id, { role: "admin" });
    });
    await f.second.mutation(api.teams.removeFromTeam, {
      team_id: f.ids.team,
      user_id: f.ids[departing],
    });
    const pin = departing === "owner" ? "owner_membership" : "membership";
    const remaining = await grants(f);
    expect(remaining).toHaveLength(150);
    expect(
      remaining.find((row) => row.conversation_id === f.ids.conversation_id)?.[
        pin
      ],
    ).toBe(departing === "owner" ? f.ids.ownerMembership : f.ids.membership);

    const newMembership = await f.t.run(({ db }) =>
      fixtureRows(db, "terminal member rejoins before purge").membership(
        f.ids[departing],
        f.ids.team,
        { visibility: "full" },
      ),
    );
    const lease = departing === "owner" ? await f.enable() : f.lease;
    expect(
      await f.viewer.mutation(api.terminalWatch.watch, {
        ...lease,
        renew: false,
      }),
    ).toBe(true);
    expect(await f.focus(f.viewer, "rejoined-before-cleanup", 1)).toEqual({
      status: "forbidden",
    });
    expect(await f.grant()).toBe(true);
    expect((await claim(f))?.holder).toBeUndefined();
    expect((await claim(f))?.terminal?.pending_input).toBeUndefined();
    await f.t.finishAllScheduledFunctions(() => jest.runAllTimers());
    expect(await grants(f)).toMatchObject([
      { conversation_id: f.ids.conversation_id, [pin]: newMembership },
    ]);
  },
);

test("retiring a team defers 250 typing grants to the bounded team purge", async () => {
  const f = await terminalTypingFixture(budgets);
  await seedGrantBatch(f);
  const team = await f.t.run(({ db }) => db.get(f.ids.team));
  expect(
    await f.owner.mutation(api.teams.deleteTeam, {
      team_id: f.ids.team,
      confirm_name: team!.name,
    }),
  ).toMatchObject({ deleted: true });
  expect(await grants(f)).toHaveLength(250);
  await f.t.mutation(internal.terminalWatch.purgeTeamRows, {
    team_id: f.ids.team,
  });
  expect(await grants(f)).toHaveLength(150);
  await f.t.finishAllScheduledFunctions(() => jest.runAllTimers());
  expect(await grants(f)).toEqual([]);
  expect((await claim(f))?.holder).toBeUndefined();
  expect((await claim(f))?.terminal?.pending_input).toBeUndefined();
});

test("grants issued without an owner membership pin require a fresh grant", async () => {
  const f = await terminalTypingFixture();
  await f.report(1);
  expect(await f.grant()).toBe(true);
  const [old] = await grants(f);
  await f.t.run(({ db }) => db.patch(old._id, { owner_membership: undefined }));
  expect(await f.focus()).toEqual({ status: "forbidden" });
  expect(await f.grant()).toBe(true);
  expect(await f.focus()).toMatchObject({ status: "held", token: 1 });
  expect(await grants(f)).toMatchObject([
    { owner_membership: f.ids.ownerMembership },
  ]);
});
