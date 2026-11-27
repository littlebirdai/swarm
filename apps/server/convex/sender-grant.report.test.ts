import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { patchEnv } from "@codecast/test-helpers/patchEnv";
import { api } from "./_generated/api";
import * as collabModule from "./collab";
import { SENDER_GRANT_REPORT_FLAG } from "./lib/sender-grant.rules";
import { reportSenderGrantIfNeeded } from "./lib/senderGrantReport";
import { enqueuePendingMessage } from "./pendingMessages";
import {
  asUser,
  countDatabaseReads,
  scheduledJobs,
} from "../test-helpers/database.testkit";
import { setupSenderGrantWorld } from "../test-helpers/senderGrant.testkit";

setDefaultTimeout(60_000);

describe("sender grant report mode behavior", () => {
  test("does not read collab_grants or add write mutations and flag off incurs zero reads", async () => {
    const restore = patchEnv({ [SENDER_GRANT_REPORT_FLAG]: undefined });
    try {
      const w = await setupSenderGrantWorld();
      expect((collabModule as any).grantSenderAccess).toBeUndefined();
      expect((collabModule as any).revokeSenderAccess).toBeUndefined();

      await w.t.run(async ({ db }) => {
        const conv = await db.get(w.personalConv);
        const counted = countDatabaseReads(db);
        await reportSenderGrantIfNeeded(
          { db: counted.db, scheduler: { runAfter: async () => {} } },
          conv,
          w.teammate,
          { human: true },
        );
        expect(counted.reads).toEqual([]);
      });
    } finally {
      restore();
    }
  });

  test("records teammate, secondary non-runner owner, agent, and unknown_machine while skipping runner, hosted, team, link visitor, and approved suggestions", async () => {
    const restore = patchEnv({ [SENDER_GRANT_REPORT_FLAG]: "1" });
    try {
      const w = await setupSenderGrantWorld();

      await w.t.run(async ({ db }) => {
        await db.insert("collab_grants", {
          conversation_id: w.personalConv,
          grantee_user_id: w.teammate,
          owner_user_id: w.owner,
          status: "granted",
          created_at: 1,
          updated_at: 1,
        });
      });

      const matePersonal = await asUser(w.t, w.teammate).mutation(
        api.pendingMessages.sendMessageV2,
        {
          command_id: "cmd-mate-personal",
          client_id: "cmd-mate-personal",
          conversation_id: w.personalConv,
          content: "secret body teammate",
        },
      );
      expect(matePersonal.status).toBe("acknowledged");

      const secondaryOwnerSend = await asUser(w.t, w.secondaryOwner).mutation(
        api.pendingMessages.sendMessageV2,
        {
          command_id: "cmd-secondary-owner",
          client_id: "cmd-secondary-owner",
          conversation_id: w.personalConv,
          content: "secret body secondary owner",
        },
      );
      expect(secondaryOwnerSend.status).toBe("acknowledged");

      const agentPersonal = await asUser(w.t, w.teammate).mutation(
        api.pendingMessages.sendSessionMessage,
        {
          to: "jxpers1",
          from: "jxmate1",
          body: "secret body agent",
        },
      );
      expect(agentPersonal.message_id).toBeTruthy();

      const mateTeamAdmin = await asUser(w.t, w.teammate).mutation(
        api.pendingMessages.sendMessageV2,
        {
          command_id: "cmd-team-admin",
          client_id: "cmd-team-admin",
          conversation_id: w.teamAdminConv,
          content: "team admin box",
        },
      );
      expect(mateTeamAdmin.status).toBe("acknowledged");

      const mateTeamMember = await asUser(w.t, w.teammate).mutation(
        api.pendingMessages.sendMessageV2,
        {
          command_id: "cmd-team-member",
          client_id: "cmd-team-member",
          conversation_id: w.teamMemberConv,
          content: "team member box",
        },
      );
      expect(mateTeamMember.status).toBe("acknowledged");

      const mateTeamBot = await asUser(w.t, w.teammate).mutation(
        api.pendingMessages.sendMessageV2,
        {
          command_id: "cmd-team-bot",
          client_id: "cmd-team-bot",
          conversation_id: w.teamBotConv,
          content: "team bot box",
        },
      );
      expect(mateTeamBot.status).toBe("acknowledged");

      const mateCloudHost = await asUser(w.t, w.teammate).mutation(
        api.pendingMessages.sendMessageV2,
        {
          command_id: "cmd-cloud-host",
          client_id: "cmd-cloud-host",
          conversation_id: w.cloudHostConv,
          content: "cloud host",
        },
      );
      expect(mateCloudHost.status).toBe("acknowledged");

      const mateCastReady = await asUser(w.t, w.teammate).mutation(
        api.pendingMessages.sendMessageV2,
        {
          command_id: "cmd-cast-ready",
          client_id: "cmd-cast-ready",
          conversation_id: w.castReadyConv,
          content: "cast machine",
        },
      );
      expect(mateCastReady.status).toBe("acknowledged");

      const runnerSend = await asUser(w.t, w.owner).mutation(
        api.pendingMessages.sendMessageV2,
        {
          command_id: "cmd-runner",
          client_id: "cmd-runner",
          conversation_id: w.personalConv,
          content: "runner own send",
        },
      );
      expect(runnerSend.status).toBe("acknowledged");

      const hostedBlocked = await asUser(w.t, w.teammate).mutation(
        api.pendingMessages.sendMessageV2,
        {
          command_id: "cmd-hosted-blocked",
          client_id: "cmd-hosted-blocked",
          conversation_id: w.hostedConv,
          content: "hosted blocked",
        },
      );
      expect(hostedBlocked.status).toBe("rejected");

      const visitorBlocked = await asUser(w.t, w.visitor).mutation(
        api.pendingMessages.sendMessageV2,
        {
          command_id: "cmd-visitor-blocked",
          client_id: "cmd-visitor-blocked",
          conversation_id: w.personalConv,
          content: "visitor blocked",
        },
      );
      expect(visitorBlocked.status).toBe("rejected");

      await w.t.run(async ({ db }) => {
        await db.insert("collab_grants", {
          conversation_id: w.personalConv,
          grantee_user_id: w.visitor,
          owner_user_id: w.owner,
          status: "granted",
          created_at: 1,
          updated_at: 1,
        });
      });

      const visitorGranted = await asUser(w.t, w.visitor).mutation(
        api.pendingMessages.sendMessageV2,
        {
          command_id: "cmd-visitor-granted",
          client_id: "cmd-visitor-granted",
          conversation_id: w.personalConv,
          content: "visitor granted",
        },
      );
      expect(visitorGranted.status).toBe("acknowledged");

      const suggestionId = await w.t.run(async ({ db }) =>
        db.insert("guest_suggestions", {
          conversation_id: w.personalConv,
          author_user_id: w.teammate,
          guest_name: "Teammate",
          owner_user_id: w.owner,
          body: "approved teammate suggestion",
          status: "pending",
          created_at: 1,
        }),
      );
      const approved = await asUser(w.t, w.owner).mutation(
        api.dispatch.dispatch,
        {
          action: "sendGuestSuggestion",
          args: [String(suggestionId)],
        },
      );
      expect(approved.status).toBe("sent");

      await w.t.run(async ({ db }) => {
        const unknownMigrationId = await db.insert("session_migrations", {
          user_id: w.owner,
          batch_id: "mg-unknown",
          conversation_id: w.teamAdminConv,
          direction: "to_local",
          to_device_id: "unknown-dest",
          executor_device_id: w.personalDeviceId,
          status: "transferring",
          position: 0,
          attempt: 1,
          created_at: 1,
          updated_at: 1,
        });
        await db.patch(w.teamAdminConv, {
          migration: {
            batch_id: "mg-unknown",
            migration_id: unknownMigrationId,
            to_device_id: "unknown-dest",
            started_at: 1,
          },
        });
      });
      const unknownMoveSend = await asUser(w.t, w.teammate).mutation(
        api.pendingMessages.sendMessageV2,
        {
          command_id: "cmd-unknown-move",
          client_id: "cmd-unknown-move",
          conversation_id: w.teamAdminConv,
          content: "during unknown move",
        },
      );
      expect(unknownMoveSend.status).toBe("acknowledged");

      await w.t.run(async ({ db }) => {
        await db.patch(w.teamBotConv, {
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
        await db.insert("execution_bindings", {
          conversation_id: w.teamBotConv,
          epoch: 1,
          state: "ready",
          protocol_version: 1,
          owner_user_id: w.teamBot,
          owner_device_id: w.botDeviceId,
          daemon_boot_id: "boot-1",
          requested_agent: "claude",
          transport: "tmux",
          project_path: "/tmp/proj",
          configuration_revision: 1,
          required_capabilities: [
            "single-flight-binding",
            "delivery-permit-v1",
          ],
          created_at: 1,
          updated_at: 1,
        });
      });
      const fencedPersonalMoveSend = await asUser(w.t, w.teammate).mutation(
        api.pendingMessages.sendMessageV2,
        {
          command_id: "cmd-fenced-personal-move",
          client_id: "cmd-fenced-personal-move",
          conversation_id: w.teamBotConv,
          content: "fenced move toward personal laptop",
        },
      );
      expect(fencedPersonalMoveSend.status).toBe("acknowledged");

      const jobs = (await scheduledJobs(w.t))
        .filter((j) => j.name === "analytics:capture")
        .map((j) => j.args[0]);

      expect(jobs).toEqual([
        {
          event: "sender_grant_report",
          distinctId: String(w.teammate),
          properties: {
            conversation_id: String(w.personalConv),
            sender_kind: "teammate",
            reason: "personal_machine_no_grant",
          },
        },
        {
          event: "sender_grant_report",
          distinctId: String(w.secondaryOwner),
          properties: {
            conversation_id: String(w.personalConv),
            sender_kind: "teammate",
            reason: "personal_machine_no_grant",
          },
        },
        {
          event: "sender_grant_report",
          distinctId: String(w.teammate),
          properties: {
            conversation_id: String(w.personalConv),
            sender_kind: "agent",
            reason: "personal_machine_no_grant",
          },
        },
        {
          event: "sender_grant_report",
          distinctId: String(w.teammate),
          properties: {
            conversation_id: String(w.teamAdminConv),
            sender_kind: "teammate",
            reason: "unknown_machine",
          },
        },
        {
          event: "sender_grant_report",
          distinctId: String(w.teammate),
          properties: {
            conversation_id: String(w.teamBotConv),
            sender_kind: "teammate",
            reason: "personal_machine_no_grant",
          },
        },
      ]);

      const serialized = JSON.stringify(jobs);
      expect(serialized).not.toContain("secret body");
      expect(serialized).not.toContain("approved teammate suggestion");
    } finally {
      restore();
    }
  });

  test("send still succeeds and writes pending row when report lookup throws", async () => {
    const restore = patchEnv({ [SENDER_GRANT_REPORT_FLAG]: "1" });
    try {
      const w = await setupSenderGrantWorld();
      const messageId = await w.t.run(async ({ db }) => {
        const conv = await db.get(w.personalConv);
        const throwingDb: any = {
          ...db,
          get: async (...args: [any]) => db.get(...args),
          insert: (...args: [any, any]) => db.insert(...args),
          patch: (...args: [any, any]) => db.patch(...args),
          query: (table: string) => {
            if (table === "team_host_members") {
              throw new Error("simulated team host lookup failure");
            }
            return db.query(table);
          },
        };
        return enqueuePendingMessage(
          { db: throwingDb, scheduler: { runAfter: async () => {} } },
          conv,
          w.teammate,
          { content: "must still enqueue", human: true },
        );
      });

      expect(messageId).toBeTruthy();
      const pending = await w.t.run(({ db }) => db.get(messageId));
      expect(pending).toMatchObject({
        conversation_id: w.personalConv,
        from_user_id: w.teammate,
        content: "must still enqueue",
        status: "pending",
      });
      const jobs = (await scheduledJobs(w.t)).filter(
        (j) => j.name === "analytics:capture",
      );
      expect(jobs).toHaveLength(0);
    } finally {
      restore();
    }
  });

  test("measures read counts for each report path", async () => {
    const restore = patchEnv({ [SENDER_GRANT_REPORT_FLAG]: "1" });
    try {
      const w = await setupSenderGrantWorld();
      const counts = await w.t.run(async ({ db }) => {
        const measure = async (
          convId: any,
          senderId: any,
          fields: Record<string, any> = { human: true },
        ) => {
          const conv = await db.get(convId);
          const counted = countDatabaseReads(db);
          await reportSenderGrantIfNeeded(
            { db: counted.db, scheduler: { runAfter: async () => {} } },
            conv,
            senderId,
            fields,
          );
          return counted.reads;
        };

        return {
          runner: await measure(w.personalConv, w.owner),
          hostedAgentType: await measure(w.hostedConv, w.teammate),
          approvedSuggestion: await measure(w.personalConv, w.teammate, {
            human: true,
            skip_sender_grant_report: true,
          }),
          teamBot: await measure(w.teamBotConv, w.teammate),
          teamHostMember: await measure(w.teamMemberConv, w.teammate),
          teamHostAdmin: await measure(w.teamAdminConv, w.teammate),
          castReady: await measure(w.castReadyConv, w.teammate),
          cloudHost: await measure(w.cloudHostConv, w.teammate),
          personalTeammate: await measure(w.personalConv, w.teammate),
          personalAgent: await measure(w.personalConv, w.teammate, {
            from_conversation_id: w.teammateConv,
            human: false,
          }),
          linkVisitor: await measure(w.personalConv, w.visitor),
        };
      });

      expect(counts.runner).toEqual([]);
      expect(counts.hostedAgentType).toEqual([]);
      expect(counts.approvedSuggestion).toEqual([]);
      expect(counts.teamBot).toEqual(["get"]);
      expect(counts.teamHostMember).toEqual(["get", "team_host_members"]);
      expect(counts.teamHostAdmin).toEqual([
        "get",
        "team_host_members",
        "team_hosts",
      ]);
      expect(counts.castReady).toEqual([
        "get",
        "team_host_members",
        "team_hosts",
        "cast_machines",
      ]);
      expect(counts.cloudHost).toEqual([
        "get",
        "team_host_members",
        "team_hosts",
        "cast_machines",
        "devices",
      ]);
      expect(counts.personalTeammate).toEqual([
        "get",
        "team_host_members",
        "team_hosts",
        "cast_machines",
        "devices",
        "session_owners",
        "team_memberships",
        "team_memberships",
        "get",
      ]);
      expect(counts.personalAgent).toEqual([
        "get",
        "team_host_members",
        "team_hosts",
        "cast_machines",
        "devices",
        "session_owners",
        "team_memberships",
        "team_memberships",
      ]);
      expect(counts.linkVisitor).toEqual([
        "get",
        "team_host_members",
        "team_hosts",
        "cast_machines",
        "devices",
        "session_owners",
        "team_memberships",
        "conversation_read_grants",
        "share_redemptions",
      ]);
    } finally {
      restore();
    }
  });

  test("flag off and flag on produce identical send outcomes across every sender and machine case", async () => {
    const runScenario = async (flag: string | undefined) => {
      const restore = patchEnv({ [SENDER_GRANT_REPORT_FLAG]: flag });
      try {
        const w = await setupSenderGrantWorld();
        const matePersonal = await asUser(w.t, w.teammate).mutation(
          api.pendingMessages.sendMessageV2,
          {
            command_id: "parity-mate-personal",
            client_id: "parity-mate-personal",
            conversation_id: w.personalConv,
            content: "msg 1",
          },
        );
        const secondaryOwner = await asUser(w.t, w.secondaryOwner).mutation(
          api.pendingMessages.sendMessageV2,
          {
            command_id: "parity-secondary-owner",
            client_id: "parity-secondary-owner",
            conversation_id: w.personalConv,
            content: "msg 2",
          },
        );
        const mateCast = await asUser(w.t, w.teammate).mutation(
          api.pendingMessages.sendMessageV2,
          {
            command_id: "parity-mate-cast",
            client_id: "parity-mate-cast",
            conversation_id: w.castReadyConv,
            content: "msg 3",
          },
        );
        const visitorBlocked = await asUser(w.t, w.visitor).mutation(
          api.pendingMessages.sendMessageV2,
          {
            command_id: "parity-visitor-blocked",
            client_id: "parity-visitor-blocked",
            conversation_id: w.personalConv,
            content: "msg 4",
          },
        );
        const agentPersonal = await asUser(w.t, w.teammate).mutation(
          api.pendingMessages.sendSessionMessage,
          {
            to: "jxpers1",
            from: "jxmate1",
            body: "msg 5",
          },
        );
        const jobs = await scheduledJobs(w.t);
        return {
          matePersonal: matePersonal.status,
          secondaryOwner: secondaryOwner.status,
          mateCast: mateCast.status,
          visitorBlocked: visitorBlocked.status,
          visitorBlockedCode: (visitorBlocked as any).rejection?.code,
          agentCrossUser: agentPersonal.cross_user,
          agentHasMessage: Boolean(agentPersonal.message_id),
          reportCount: jobs.filter((j) => j.name === "analytics:capture")
            .length,
        };
      } finally {
        restore();
      }
    };

    const off = await runScenario(undefined);
    const on = await runScenario("1");

    expect(on.matePersonal).toBe(off.matePersonal);
    expect(on.secondaryOwner).toBe(off.secondaryOwner);
    expect(on.mateCast).toBe(off.mateCast);
    expect(on.visitorBlocked).toBe(off.visitorBlocked);
    expect(on.visitorBlockedCode).toBe(off.visitorBlockedCode);
    expect(on.agentCrossUser).toBe(off.agentCrossUser);
    expect(on.agentHasMessage).toBe(off.agentHasMessage);
    expect(off.reportCount).toBe(0);
    expect(on.reportCount).toBe(3);
  });
});
