import { serverTest } from "./database.testkit";
import { fixtureRows } from "./rows.testkit";

let worldCounter = 0;

export async function setupSenderGrantWorld() {
  worldCounter += 1;
  const t = serverTest();
  const seed = `sender-grant-${worldCounter}`;
  const ids = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, seed);
    const team = await rows.team();
    const otherTeam = await rows.team();
    const owner = await rows.user({ name: "Owner" });
    const secondaryOwner = await rows.user({ name: "Secondary Owner" });
    const teammate = await rows.user({ name: "Teammate" });
    const hostMember = await rows.user({ name: "Host Member" });
    const visitor = await rows.user({ name: "Visitor" });
    const teamBot = await rows.user({
      name: "Team Bot",
      is_bot: true,
      team_id: team,
    });
    const personalBot = await rows.user({
      name: "Personal Bot",
      is_bot: true,
    });

    await rows.membership(owner, team, { visibility: "full" });
    await rows.membership(secondaryOwner, team, { visibility: "full" });
    await rows.membership(teammate, team, { visibility: "full" });
    await rows.membership(hostMember, team, { visibility: "full" });
    await rows.membership(teamBot, team, { visibility: "full" });

    const personalDeviceId = "laptop-owner";
    await rows.device(owner, {
      device_id: personalDeviceId,
      label: "Owner MacBook",
      platform: "darwin",
      is_remote: false,
    });

    const remoteDeviceId = "remote-owner";
    await rows.device(owner, {
      device_id: remoteDeviceId,
      label: "Remote Host",
      platform: "linux",
      is_remote: true,
    });

    const cloudHostDeviceId = "cloud-host-owner";
    await rows.device(owner, {
      device_id: cloudHostDeviceId,
      label: "Cloud Host",
      platform: "linux",
      is_remote: false,
      cloud_host: {
        managed_by: personalDeviceId,
        instance_id: "i-123456",
        provider: "aws",
        state: "running",
        images: [],
        logins_held: [],
        at: 1,
      },
    });

    const teamAdminDeviceId = "team-admin-box";
    await rows.device(owner, {
      device_id: teamAdminDeviceId,
      label: "Team Admin Box",
      platform: "linux",
      is_remote: true,
    });

    const teamMemberDeviceId = "team-member-box";
    await rows.device(hostMember, {
      device_id: teamMemberDeviceId,
      label: "Team Member Box",
      platform: "linux",
      is_remote: true,
    });

    const hostId = await db.insert("team_hosts", {
      team_id: otherTeam,
      name: "Shared Linux Box",
      host_key: "a".repeat(48),
      admin_user_id: owner,
      admin_device_id: teamAdminDeviceId,
      admin_linux_user: "owner",
      platform: "linux",
      created_at: 1,
    });
    await db.insert("team_host_members", {
      host_id: hostId,
      user_id: hostMember,
      linux_user: "member",
      device_id: teamMemberDeviceId,
      status: "ready",
      requested_at: 1,
      ready_at: 1,
    });

    const botDeviceId = "bot-box";
    await rows.device(teamBot, {
      device_id: botDeviceId,
      label: "Bot Box",
      platform: "linux",
      is_remote: true,
    });

    const castDeviceId = "cast-ready-box";
    await db.insert("cast_machines", {
      user_id: owner,
      device_id: castDeviceId,
      region: "us-west-2",
      status: "ready",
      held_conversation_ids: [],
      launch_attempts: 1,
      created_at: 1,
      updated_at: 1,
    });

    const personalConv = await rows.conversation(owner, {
      team_id: team,
      owner_user_id: secondaryOwner,
      is_private: false,
      short_id: "jxpers1",
      owner_device_id: personalDeviceId,
      share_token: "share-tok-1",
    });

    const remoteConv = await rows.conversation(owner, {
      team_id: team,
      is_private: false,
      short_id: "jxrem01",
      owner_device_id: remoteDeviceId,
    });

    const cloudHostConv = await rows.conversation(owner, {
      team_id: team,
      is_private: false,
      short_id: "jxcld01",
      owner_device_id: cloudHostDeviceId,
    });

    const teamAdminConv = await rows.conversation(owner, {
      team_id: team,
      is_private: false,
      short_id: "jxadm01",
      owner_device_id: teamAdminDeviceId,
    });

    const teamMemberConv = await rows.conversation(hostMember, {
      team_id: team,
      is_private: false,
      short_id: "jxmem01",
      owner_device_id: teamMemberDeviceId,
    });

    const teamBotConv = await rows.conversation(teamBot, {
      team_id: team,
      is_private: false,
      short_id: "jxbot01",
      owner_device_id: botDeviceId,
    });

    const personalBotConv = await rows.conversation(personalBot, {
      team_id: team,
      is_private: false,
      short_id: "jxpbot1",
    });

    const hostedConv = await rows.conversation(owner, {
      team_id: team,
      is_private: false,
      agent_type: "codecast",
      short_id: "jxhost1",
    });

    const castReadyConv = await rows.conversation(owner, {
      team_id: team,
      is_private: false,
      agent_type: "pi",
      short_id: "jxcst01",
      owner_device_id: castDeviceId,
    });

    const teammateConv = await rows.conversation(teammate, {
      is_private: true,
      short_id: "jxmate1",
    });

    await db.insert("session_owners", {
      conversation_id: personalConv,
      user_id: secondaryOwner,
      added_by: owner,
      added_at: 1,
    });

    await db.insert("share_redemptions", {
      conversation_id: personalConv,
      user_id: visitor,
      token: "share-tok-1",
      created_at: 1,
    });

    return {
      team,
      otherTeam,
      owner,
      secondaryOwner,
      teammate,
      hostMember,
      visitor,
      teamBot,
      personalBot,
      personalDeviceId,
      teamAdminDeviceId,
      teamMemberDeviceId,
      botDeviceId,
      personalConv,
      remoteConv,
      cloudHostConv,
      teamAdminConv,
      teamMemberConv,
      teamBotConv,
      personalBotConv,
      hostedConv,
      castReadyConv,
      teammateConv,
    };
  });

  return { t, ...ids };
}
