// The loop freeze alert must fire once per incident, stay quiet through the
// rest of it, and fire again on the NEXT one. Four traps live in the decision:
// a machine already alerted on keeps beating the same hour total every 5
// minutes; an old daemon that stopped reporting leaves its last value frozen on
// the device row forever; a second real incident is often smaller than the
// first; and a machine can simply stay over the bar for weeks.
// The frozen value is handled by asking whether the number moved at all, so a
// value that never changes alerts at most once. A worse number waits out the
// short cooldown; a number that moved without beating the last peak waits out
// the long one, which is what keeps a chronically broken machine reporting
// instead of going silent after day one. And the handler clears the stamp once
// the machine has been under the bar past the cooldown, so the next incident is
// judged on its own without letting a machine hovering at the bar re-alert
// every other tick.
import { describe, expect, test } from "bun:test";
import { serverTest } from "../test-helpers/database.testkit";
import { fixtureRows, type NewRow } from "../test-helpers/rows.testkit";
import { internal } from "./_generated/api";
import {
  shouldNotifyDeviceFreeze,
  FREEZE_NOTIFY_COOLDOWN_MS,
  FREEZE_RENOTIFY_MS,
  LOOP_FREEZE_ALERT_MS,
} from "./daemonLogs";

const NOW = 1_700_000_000_000;

describe("shouldNotifyDeviceFreeze", () => {
  const base = { thresholdMs: LOOP_FREEZE_ALERT_MS, online: true, now: NOW };

  test("stays silent under the bar and with nothing reported", () => {
    expect(shouldNotifyDeviceFreeze({ ...base, hourMs: 60_000 })).toBe(false);
    expect(shouldNotifyDeviceFreeze({ ...base, hourMs: undefined })).toBe(
      false,
    );
    expect(shouldNotifyDeviceFreeze({ ...base, hourMs: 0 })).toBe(false);
  });

  test("notifies over the bar when the machine has never been alerted on", () => {
    expect(shouldNotifyDeviceFreeze({ ...base, hourMs: 215_000 })).toBe(true);
  });

  test("an offline machine never notifies", () => {
    expect(
      shouldNotifyDeviceFreeze({ ...base, hourMs: 215_000, online: false }),
    ).toBe(false);
  });

  test("the same hour total inside the cooldown is already covered", () => {
    const state = { last_notified_at: NOW - 60_000, last_hour_ms: 215_000 };
    expect(shouldNotifyDeviceFreeze({ ...base, hourMs: 215_000, state })).toBe(
      false,
    );
  });

  test("a worse hour past the cooldown announces itself again", () => {
    const state = {
      last_notified_at: NOW - FREEZE_NOTIFY_COOLDOWN_MS - 1,
      last_hour_ms: 215_000,
    };
    expect(shouldNotifyDeviceFreeze({ ...base, hourMs: 400_000, state })).toBe(
      true,
    );
    // A worse hour INSIDE the cooldown still waits.
    expect(
      shouldNotifyDeviceFreeze({
        ...base,
        hourMs: 400_000,
        state: { last_notified_at: NOW - 60_000, last_hour_ms: 215_000 },
      }),
    ).toBe(false);
  });

  test("an unchanged value past the cooldown stays silent forever", () => {
    // This is the case where a daemon stopped reporting and left the value
    // where it was. A number that never grows is never news again.
    const state = {
      last_notified_at: NOW - 10 * FREEZE_NOTIFY_COOLDOWN_MS,
      last_hour_ms: 215_000,
    };
    expect(shouldNotifyDeviceFreeze({ ...base, hourMs: 215_000, state })).toBe(
      false,
    );
  });

  // The founder's own laptop: over the bar every hour of every day, and rarely
  // beating its own worst hour. Comparing only against the peak silenced it
  // after the first alert for the life of the row, because a value between the
  // bar and the peak is neither worse nor low enough to clear the stamp.
  test("a machine that keeps breaching without a new peak re-alerts on the long interval", () => {
    const state = {
      last_notified_at: NOW - 3 * 24 * 60 * 60 * 1000,
      last_hour_ms: 400_000,
    };
    expect(shouldNotifyDeviceFreeze({ ...base, hourMs: 300_000, state })).toBe(
      true,
    );
    expect(shouldNotifyDeviceFreeze({ ...base, hourMs: 399_000, state })).toBe(
      true,
    );
    // Inside the long interval it waits, so a chronic machine is heard from
    // every few hours, not every cron tick.
    const recent = {
      last_notified_at: NOW - FREEZE_NOTIFY_COOLDOWN_MS - 1,
      last_hour_ms: 400_000,
    };
    expect(
      shouldNotifyDeviceFreeze({ ...base, hourMs: 300_000, state: recent }),
    ).toBe(false);
    expect(FREEZE_RENOTIFY_MS).toBeGreaterThan(FREEZE_NOTIFY_COOLDOWN_MS);
  });
});

async function setup(fields: Partial<NewRow<"devices">> = {}, muted = false) {
  const t = serverTest();
  const ids = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "daemon loop freeze");
    const user = await rows.user({
      last_heartbeat: Date.now(),
      notification_preferences: muted
        ? {
            team_session_start: true,
            mention: true,
            permission_request: true,
            machine_alerts: false,
          }
        : undefined,
    });
    const device = await rows.device(user, {
      label: "Ashots MacBook",
      last_seen: Date.now(),
      loop_freeze_1h_ms: 215_000,
      loop_freeze_max_ms: 42_000,
      loop_freeze_top: "walk@recursiveWatcher.ts:138 60%",
      ...fields,
    });
    return { user, device };
  });
  return {
    user: ids.user,
    check: () => t.mutation(internal.daemonLogs.checkDeviceLoopFreeze, {}),
    device: () => t.run(async ({ db }) => (await db.get(ids.device))!),
    patch: (fields: Partial<NewRow<"devices">>) =>
      t.run(({ db }) => db.patch(ids.device, fields)),
    notes: () => t.run(({ db }) => db.query("notifications").collect()),
  };
}

describe("checkDeviceLoopFreeze", () => {
  test("alerts once across concurrent ticks and persists the stamp", async () => {
    const { check, device, notes } = await setup();
    const results = await Promise.all([check(), check()]);
    expect(results.map((r) => r.notified).sort()).toEqual([0, 1]);
    expect((await device()).freeze_notify_state?.last_hour_ms).toBe(215_000);
    expect(await notes()).toHaveLength(1);
  });

  test("the notification names the machine, the hour, the worst freeze and the cause", async () => {
    const { check, notes, user } = await setup();
    await check();
    const [note] = await notes();
    expect(note.type).toBe("daemon_overloaded");
    expect(note.entity_type).toBe("device");
    expect(note.recipient_user_id).toBe(user);
    expect(note.actor_name).toBe("Ashots MacBook");
    expect(note.link).toBeUndefined();
    expect(note.message).toContain("215s in the last hour");
    expect(note.message).toContain("42s");
    expect(note.message).toContain("walk@recursiveWatcher.ts:138");
  });

  test("a machine that recovers alerts again on its next, smaller incident", async () => {
    const { check, device, notes, patch } = await setup();
    expect((await check()).notified).toBe(1);

    await patch({ loop_freeze_1h_ms: 60_000 });
    expect((await check()).notified).toBe(0);
    const stamp = (await device()).freeze_notify_state;
    expect(stamp).toBeDefined();

    await patch({
      freeze_notify_state: {
        ...stamp!,
        last_notified_at: Date.now() - FREEZE_NOTIFY_COOLDOWN_MS - 1,
      },
    });
    expect((await check()).notified).toBe(0);
    expect((await device()).freeze_notify_state).toBeUndefined();

    await patch({ loop_freeze_1h_ms: 150_000 });
    expect((await check()).notified).toBe(1);
    const delivered = await notes();
    expect(delivered).toHaveLength(2);
    expect(delivered[1].message).toContain("150s in the last hour");
  });

  test("a machine hovering at the bar is announced once, not every other tick", async () => {
    const { check, notes, patch } = await setup();
    expect((await check()).notified).toBe(1);

    for (const hour of [60_000, 215_000, 90_000, 230_000, 100_000, 215_000]) {
      await patch({ loop_freeze_1h_ms: hour });
      expect((await check()).notified).toBe(0);
    }
    expect(await notes()).toHaveLength(1);
  });

  test("a machine that stays over the bar for days keeps being reported", async () => {
    const { check, device, notes, patch } = await setup({
      loop_freeze_1h_ms: 400_000,
    });
    expect((await check()).notified).toBe(1);

    await patch({ loop_freeze_1h_ms: 300_000 });
    expect((await check()).notified).toBe(0);

    const stamp = (await device()).freeze_notify_state!;
    await patch({
      freeze_notify_state: {
        ...stamp,
        last_notified_at: Date.now() - FREEZE_RENOTIFY_MS - 1,
      },
    });
    expect((await check()).notified).toBe(1);
    expect((await device()).freeze_notify_state?.last_hour_ms).toBe(300_000);
    const delivered = await notes();
    expect(delivered).toHaveLength(2);
    expect(delivered[1].message).toContain("300s in the last hour");
  });

  test("a muted recipient is not counted as notified", async () => {
    const { check, notes } = await setup({}, true);
    expect((await check()).notified).toBe(0);
    expect(await notes()).toEqual([]);
  });

  test("a machine that is offline or under the bar is never alerted on", async () => {
    const quiet = await setup({ loop_freeze_1h_ms: 30_000 });
    expect((await quiet.check()).notified).toBe(0);

    const gone = await setup({ last_seen: Date.now() - 10 * 60_000 });
    expect((await gone.check()).notified).toBe(0);
  });
});
