import { expect, test } from "bun:test";
import {
  deviceId,
  enableTerminalWatchingForTests,
  terminalWatchFlag,
  terminalWatchFixture,
} from "../test-helpers/terminal-watch.testkit";
import { api } from "./_generated/api";

enableTerminalWatchingForTests();

const watch = api.terminalWatch;

test("team watches are unavailable by default and enabling a session queues no work", async () => {
  delete process.env[terminalWatchFlag];
  const { args, owner, viewer, t } = await terminalWatchFixture();
  expect(await owner.query(watch.status, args)).toBeNull();
  expect(await viewer.query(watch.status, args)).toBeNull();
  expect(
    await owner.mutation(watch.setSharing, { ...args, enabled: true }),
  ).toBe(false);
  expect(
    await t.run(async ({ db }) => ({
      shares: await db.query("terminal_watch_shares").collect(),
      commands: await db.query("daemon_commands").collect(),
    })),
  ).toEqual({ shares: [], commands: [] });
});

test("switching the flag off hides existing watches and stops machine frames", async () => {
  const { args, owner, viewer, t, start, enable, token } =
    await terminalWatchFixture();
  const { lease, push } = await start();
  delete process.env[terminalWatchFlag];
  expect(await owner.query(watch.watchers, args)).toEqual([]);
  expect(await viewer.query(watch.screen, lease)).toBeNull();
  expect(await viewer.mutation(watch.watch, { ...lease, renew: true })).toBe(
    false,
  );
  expect(await t.mutation(watch.cliPush, push)).toEqual({ stop: true });
  expect(
    await owner.mutation(watch.setSharing, { ...args, enabled: false }),
  ).toBe(true);
  process.env[terminalWatchFlag] = "1";
  expect(await viewer.query(watch.screen, lease)).toBeNull();
  const current = await enable();
  expect(
    await t.mutation(watch.cliBind, {
      api_token: token,
      device_id: deviceId,
      share: lease.share,
      pane_instance: "the revoked pane",
    }),
  ).toBe(false);
  expect(current.share).not.toBe(lease.share);
});
