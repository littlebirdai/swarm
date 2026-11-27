import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { decideSenderGrant } from "./lib/sender-grant.rules";
import { resolveTargetMachineKind } from "./lib/senderGrantReport";
import { setupSenderGrantWorld } from "../test-helpers/senderGrant.testkit";

setDefaultTimeout(60_000);

describe("decideSenderGrant pure decision", () => {
  test("never requires a grant for the session owner", () => {
    expect(
      decideSenderGrant({
        machineKind: "personal",
        senderIsOwner: true,
        senderKind: "owner",
        hasGrant: false,
      }),
    ).toEqual({
      needsGrant: false,
      shouldReport: false,
      senderKind: "owner",
      reason: "owner",
    });
  });

  test("never requires a grant for a teammate on a team machine", () => {
    expect(
      decideSenderGrant({
        machineKind: "team",
        senderIsOwner: false,
        senderKind: "teammate",
        hasGrant: false,
      }),
    ).toEqual({
      needsGrant: false,
      shouldReport: false,
      senderKind: "teammate",
      reason: "team_machine",
    });
  });

  test("never requires a grant on a hosted machine", () => {
    expect(
      decideSenderGrant({
        machineKind: "hosted",
        senderIsOwner: false,
        senderKind: "teammate",
        hasGrant: false,
      }),
    ).toEqual({
      needsGrant: false,
      shouldReport: false,
      senderKind: "teammate",
      reason: "hosted_machine",
    });
  });

  test("requires a grant and reports for a teammate on a personal laptop without a grant", () => {
    expect(
      decideSenderGrant({
        machineKind: "personal",
        senderIsOwner: false,
        senderKind: "teammate",
        hasGrant: false,
      }),
    ).toEqual({
      needsGrant: true,
      shouldReport: true,
      senderKind: "teammate",
      reason: "personal_machine_no_grant",
    });
  });

  test("allows a teammate on a personal laptop with a grant", () => {
    expect(
      decideSenderGrant({
        machineKind: "personal",
        senderIsOwner: false,
        senderKind: "teammate",
        hasGrant: true,
      }),
    ).toEqual({
      needsGrant: false,
      shouldReport: false,
      senderKind: "teammate",
      reason: "grant_present",
    });
  });

  test("evaluates a link visitor with and without a grant and never reports them", () => {
    expect(
      decideSenderGrant({
        machineKind: "personal",
        senderIsOwner: false,
        senderKind: "link_visitor",
        hasGrant: false,
      }),
    ).toEqual({
      needsGrant: true,
      shouldReport: false,
      senderKind: "link_visitor",
      reason: "personal_machine_no_grant",
    });
    expect(
      decideSenderGrant({
        machineKind: "personal",
        senderIsOwner: false,
        senderKind: "link_visitor",
        hasGrant: true,
      }),
    ).toEqual({
      needsGrant: false,
      shouldReport: false,
      senderKind: "link_visitor",
      reason: "grant_present",
    });
  });

  test("evaluates an agent sender across personal, granted, team, owner, and unknown cases", () => {
    expect(
      decideSenderGrant({
        machineKind: "personal",
        senderIsOwner: false,
        senderKind: "agent",
        hasGrant: false,
      }),
    ).toEqual({
      needsGrant: true,
      shouldReport: true,
      senderKind: "agent",
      reason: "personal_machine_no_grant",
    });
    expect(
      decideSenderGrant({
        machineKind: "personal",
        senderIsOwner: false,
        senderKind: "agent",
        hasGrant: true,
      }),
    ).toEqual({
      needsGrant: false,
      shouldReport: false,
      senderKind: "agent",
      reason: "grant_present",
    });
    expect(
      decideSenderGrant({
        machineKind: "team",
        senderIsOwner: false,
        senderKind: "agent",
        hasGrant: false,
      }),
    ).toEqual({
      needsGrant: false,
      shouldReport: false,
      senderKind: "agent",
      reason: "team_machine",
    });
    expect(
      decideSenderGrant({
        machineKind: "personal",
        senderIsOwner: true,
        senderKind: "agent",
        hasGrant: false,
      }),
    ).toEqual({
      needsGrant: false,
      shouldReport: false,
      senderKind: "agent",
      reason: "owner",
    });
    expect(
      decideSenderGrant({
        machineKind: "unknown",
        senderIsOwner: false,
        senderKind: "agent",
        hasGrant: false,
      }),
    ).toEqual({
      needsGrant: false,
      shouldReport: true,
      senderKind: "agent",
      reason: "unknown_machine",
    });
  });
});

describe("resolveTargetMachineKind classification branches", () => {
  test("classifies hosted agent type, remote device, cloud_host, and cast_machines booting as hosted, while ignoring stale cast_env_machines", async () => {
    const w = await setupSenderGrantWorld();
    await w.t.run(async ({ db }) => {
      const hosted = await db.get(w.hostedConv);
      const remote = await db.get(w.remoteConv);
      const cloudHost = await db.get(w.cloudHostConv);
      const castReady = await db.get(w.castReadyConv);

      expect(await resolveTargetMachineKind({ db }, hosted!)).toBe("hosted");
      expect(await resolveTargetMachineKind({ db }, remote!)).toBe("hosted");
      expect(await resolveTargetMachineKind({ db }, cloudHost!)).toBe("hosted");
      expect(await resolveTargetMachineKind({ db }, castReady!)).toBe("hosted");

      const bootingUser = await db.insert("users", { name: "Booting" });
      const bootingConvId = await db.insert("conversations", {
        user_id: bootingUser,
        agent_type: "pi",
        session_id: "sess-booting",
        started_at: 1,
        updated_at: 1,
        message_count: 0,
        is_private: false,
        status: "active",
      });
      await db.insert("cast_machines", {
        user_id: bootingUser,
        region: "us-west-2",
        status: "booting",
        held_conversation_ids: [bootingConvId],
        launch_attempts: 1,
        created_at: 1,
        updated_at: 1,
      });
      const bootingConv = await db.get(bootingConvId);
      expect(await resolveTargetMachineKind({ db }, bootingConv!)).toBe(
        "hosted",
      );

      const envUser = await db.insert("users", { name: "EnvUser" });
      const envDeviceId = "env-personal-laptop";
      await db.insert("devices", {
        user_id: envUser,
        device_id: envDeviceId,
        label: "Personal Laptop",
        platform: "darwin",
        is_remote: false,
        last_seen: 1,
      });
      const envConvId = await db.insert("conversations", {
        user_id: envUser,
        agent_type: "claude_code",
        session_id: "sess-env",
        started_at: 1,
        updated_at: 1,
        message_count: 0,
        is_private: false,
        status: "active",
        owner_device_id: envDeviceId,
      });
      const envUnboundConvId = await db.insert("conversations", {
        user_id: envUser,
        agent_type: "claude_code",
        session_id: "sess-env-unbound",
        started_at: 1,
        updated_at: 1,
        message_count: 0,
        is_private: false,
        status: "active",
      });
      await db.insert("cast_env_machines", {
        user_id: envUser,
        region: "us-west-2",
        ssh_public_key: "ssh-ed25519 AAAA",
        created_at: 1,
        updated_at: 1,
      });
      const envConv = await db.get(envConvId);
      const envUnboundConv = await db.get(envUnboundConvId);
      expect(await resolveTargetMachineKind({ db }, envConv!)).toBe("personal");
      expect(await resolveTargetMachineKind({ db }, envUnboundConv!)).toBe(
        "personal",
      );
    });
  });

  test("classifies team bot with team_id, ready team_host_members only, and team_hosts admin device by device", async () => {
    const w = await setupSenderGrantWorld();
    await w.t.run(async ({ db }) => {
      const teamBot = await db.get(w.teamBotConv);
      const personalBot = await db.get(w.personalBotConv);
      const teamMember = await db.get(w.teamMemberConv);
      const teamAdmin = await db.get(w.teamAdminConv);

      expect(await resolveTargetMachineKind({ db }, teamBot!)).toBe("team");
      expect(await resolveTargetMachineKind({ db }, personalBot!)).toBe(
        "personal",
      );
      expect(await resolveTargetMachineKind({ db }, teamMember!)).toBe("team");
      expect(await resolveTargetMachineKind({ db }, teamAdmin!)).toBe("team");

      const localDeviceId = "member-local-box";
      await db.insert("devices", {
        user_id: w.hostMember,
        device_id: localDeviceId,
        label: "Member Local",
        platform: "linux",
        is_remote: false,
        last_seen: 1,
      });
      const host = await db.query("team_hosts").first();
      const nonReadyMemberId = await db.insert("team_host_members", {
        host_id: host!._id,
        user_id: w.hostMember,
        linux_user: "member2",
        device_id: localDeviceId,
        status: "joining",
        requested_at: 1,
      });
      const localMemberConvId = await db.insert("conversations", {
        user_id: w.hostMember,
        team_id: w.team,
        agent_type: "claude_code",
        session_id: "sess-local-member",
        started_at: 1,
        updated_at: 1,
        message_count: 0,
        is_private: false,
        status: "active",
        owner_device_id: localDeviceId,
      });
      const localMemberConv = await db.get(localMemberConvId);
      expect(await resolveTargetMachineKind({ db }, localMemberConv!)).toBe(
        "personal",
      );

      await db.patch(nonReadyMemberId, { status: "failed" });
      expect(await resolveTargetMachineKind({ db }, localMemberConv!)).toBe(
        "personal",
      );

      await db.patch(nonReadyMemberId, { status: "removing" });
      expect(await resolveTargetMachineKind({ db }, localMemberConv!)).toBe(
        "personal",
      );

      await db.patch(nonReadyMemberId, { status: "ready", ready_at: 2 });
      expect(await resolveTargetMachineKind({ db }, localMemberConv!)).toBe(
        "team",
      );
    });
  });

  test("classifies device moves against destination and reports unknown_machine when destination is missing", async () => {
    const w = await setupSenderGrantWorld();
    await w.t.run(async ({ db }) => {
      const migrationId = await db.insert("session_migrations", {
        user_id: w.teamBot,
        batch_id: "mg-1",
        conversation_id: w.teamBotConv,
        direction: "to_local",
        to_device_id: w.personalDeviceId,
        executor_device_id: w.personalDeviceId,
        status: "transferring",
        position: 0,
        attempt: 1,
        created_at: 1,
        updated_at: 1,
      });
      await db.patch(w.teamBotConv, {
        migration: {
          batch_id: "mg-1",
          migration_id: migrationId,
          to_device_id: w.personalDeviceId,
          started_at: 1,
        },
      });
      await db.insert("devices", {
        user_id: w.teamBot,
        device_id: w.personalDeviceId,
        label: "Personal Laptop",
        platform: "darwin",
        is_remote: false,
        last_seen: 1,
      });
      const bulkMoved = await db.get(w.teamBotConv);
      expect(await resolveTargetMachineKind({ db }, bulkMoved!)).toBe("team");

      const adminMigrationId = await db.insert("session_migrations", {
        user_id: w.owner,
        batch_id: "mg-2",
        conversation_id: w.teamAdminConv,
        direction: "to_local",
        to_device_id: w.personalDeviceId,
        executor_device_id: w.personalDeviceId,
        status: "transferring",
        position: 0,
        attempt: 1,
        created_at: 1,
        updated_at: 1,
      });
      await db.patch(w.teamAdminConv, {
        migration: {
          batch_id: "mg-2",
          migration_id: adminMigrationId,
          to_device_id: w.personalDeviceId,
          started_at: 1,
        },
      });
      const bulkMovedToPersonal = await db.get(w.teamAdminConv);
      expect(await resolveTargetMachineKind({ db }, bulkMovedToPersonal!)).toBe(
        "personal",
      );

      await db.patch(w.teamAdminConv, {
        migration: {
          batch_id: "mg-3",
          migration_id: adminMigrationId,
          to_device_id: "nonexistent-device",
          started_at: 1,
        },
      });
      const bulkUnknown = await db.get(w.teamAdminConv);
      expect(await resolveTargetMachineKind({ db }, bulkUnknown!)).toBe(
        "unknown",
      );

      await db.patch(w.teamBotConv, {
        migration: undefined,
        execution_protocol_state: "fenced",
      });
      await db.insert("conversation_execution_heads", {
        conversation_id: w.teamBotConv,
        owner_user_id: w.teamBot,
        protocol_state: "fenced",
        protocol_version: 1,
        current_epoch: 1,
        admission_epoch: 1,
        next_conversation_sequence: 1,
        next_nonterminal_sequence: 1,
        device_move: {
          source_epoch: 1,
          destination_device_id: w.personalDeviceId,
          destination_runner_id: w.owner,
          next_epoch: 2,
          settlement_deadline: 9999999,
        },
        created_at: 1,
        updated_at: 1,
      });
      const fencedToPersonal = await db.get(w.teamBotConv);
      expect(await resolveTargetMachineKind({ db }, fencedToPersonal!)).toBe(
        "personal",
      );

      const head = await db
        .query("conversation_execution_heads")
        .withIndex("by_conversation", (q) =>
          q.eq("conversation_id", w.teamBotConv),
        )
        .first();
      await db.patch(head!._id, {
        device_move: {
          source_epoch: 1,
          destination_device_id: "missing-dest",
          destination_runner_id: w.owner,
          next_epoch: 2,
          settlement_deadline: 9999999,
        },
      });
      expect(await resolveTargetMachineKind({ db }, fencedToPersonal!)).toBe(
        "unknown",
      );
    });
  });
});
