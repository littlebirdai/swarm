import {
  DEVICE_BOUND_TOKEN_PREFIX,
  presentToken,
} from "@platform/auth/tokenFormat";
import { expect } from "bun:test";
import { api } from "../convex/_generated/api";
import { asUser, serverTest } from "./database.testkit";
import { fixtureRows } from "./rows.testkit";

export const target = "cc-team-watch";
export const deviceId = "terminal-device";
export const frame = "redacted screen";
const secret = DEVICE_BOUND_TOKEN_PREFIX + "terminal-daemon-token";
const token = presentToken(secret, deviceId);

export async function terminalWatchFixture() {
  const t = serverTest();
  const ids = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "terminal-watch");
    const team = await rows.team();
    const otherTeam = await rows.team();
    const owner = await rows.user({ name: "Owner" });
    const viewer = await rows.user({ name: "Viewer" });
    const secondViewer = await rows.user({ name: "Second viewer" });
    const outsider = await rows.user({ name: "Outsider" });
    const ownerMembership = await rows.membership(owner, team, {
      visibility: "full",
      role: "admin",
    });
    const membership = await rows.membership(viewer, team);
    await rows.membership(secondViewer, team);
    await rows.membership(owner, otherTeam, { visibility: "full" });
    await rows.membership(viewer, otherTeam);
    await rows.membership(outsider, otherTeam);
    const ownerToken = await rows.token(owner, secret);
    await db.patch(ownerToken, { device_id: deviceId });
    const device = await rows.device(owner, { device_id: deviceId });
    const otherDevice = await rows.device(owner, { device_id: "other-device" });
    const conversation_id = await rows.conversation(owner, {
      session_id: "watch-session",
      owner_device_id: deviceId,
      team_id: team,
      is_private: false,
      share_token: "guest-link",
    });
    const session = await rows.session(owner, {
      session_id: "watch-session",
      conversation_id,
      tmux_session: target,
      agent_started_at: 100,
    });
    await db.insert("share_redemptions", {
      conversation_id,
      user_id: outsider,
      token: "guest-link",
      created_at: Date.now(),
    });
    return {
      conversation_id,
      device,
      otherDevice,
      membership,
      ownerMembership,
      team,
      otherTeam,
      owner,
      session,
      viewer,
      secondViewer,
      outsider,
    };
  });
  const args = { conversation_id: ids.conversation_id };
  const owner = asUser(t, ids.owner);
  const viewer = asUser(t, ids.viewer);
  const apiWatch = api.terminalWatch;

  async function enable() {
    expect(
      await owner.mutation(apiWatch.setSharing, { ...args, enabled: true }),
    ).toBe(true);
    const command = await t.run(({ db }) =>
      db.query("daemon_commands").order("desc").first(),
    );
    const bind = JSON.parse(command!.args!).team_watch;
    expect(bind).toMatchObject({ target, bind: true });
    expect(
      await t.mutation(apiWatch.cliBind, {
        api_token: token,
        device_id: deviceId,
        share: bind.share,
        pane_instance: "pane-generation",
      }),
    ).toBe(true);
    return {
      ...args,
      share:
        bind.share as import("../convex/_generated/dataModel").Id<"terminal_watch_shares">,
    };
  }

  async function start() {
    const lease = await enable();
    expect(
      await viewer.mutation(apiWatch.watch, { ...lease, renew: false }),
    ).toBe(true);
    const command = await t.run(({ db }) =>
      db.query("daemon_commands").order("desc").first(),
    );
    expect(command?.user_id).toBe(ids.owner);
    expect(command?.target_device_id).toBe(deviceId);
    expect(command?.command).toBe("stream_pane");
    const payload = JSON.parse(command!.args!).team_watch;
    expect(payload.target).toBe(target);
    expect(payload.share).toBe(lease.share);
    const push = {
      api_token: token,
      device_id: deviceId,
      share: lease.share,
      stream_id: payload.stream_id as string,
      pane_instance: "pane-generation",
      frame,
    };
    expect(await t.mutation(apiWatch.cliPush, push)).toEqual({ stop: false });
    expect(await viewer.query(apiWatch.screen, lease)).toMatchObject({
      text: frame,
    });
    return { lease, push };
  }

  return { t, args, ids, owner, viewer, enable, start, token };
}
