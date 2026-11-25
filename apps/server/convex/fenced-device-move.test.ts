import { expect, test } from "bun:test";
import {
  destination,
  moveFixture,
  projectPath,
  refusal,
  sessionId,
  source,
} from "../test-helpers/fenced-device-move.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { api, internal } from "./_generated/api";
import { parkOnCloudHost } from "./cloudPlacement";

type Fixture = Awaited<ReturnType<typeof moveFixture>>;
const cases: Array<[string, (f: Fixture) => Promise<unknown>]> = [
  [
    "moveSessionToDevice",
    ({ caller, conversation }) =>
      caller.mutation(api.devices.moveSessionToDevice, {
        conversation_id: conversation,
        owner_device_id: destination,
        project_path: projectPath,
      }),
  ],
  [
    "reassignToDevice",
    ({ caller, conversation }) =>
      caller.mutation(api.devices.reassignToDevice, {
        conversation_id: conversation,
        device_id: destination,
      }),
  ],
  [
    "reparentSessionToDevice",
    ({ caller, conversation }) =>
      caller.mutation(api.devices.reparentSessionToDevice, {
        session_id: conversation,
        device_id: destination,
        remote_url: "https://example.test/repo.git",
      }),
  ],
  [
    "claimConversation",
    ({ caller, conversation }) =>
      caller.mutation(api.devices.claimConversation, {
        conversation_id: conversation,
        device_id: destination,
      }),
  ],
  [
    "setConversationOwner",
    ({ caller, conversation }) =>
      caller.mutation(api.devices.setConversationOwner, {
        conversation_id: conversation,
        owner_device_id: destination,
      }),
  ],
  [
    "placeConversation",
    ({ caller, conversation }) =>
      caller.mutation(api.cloud.placeConversation, {
        conversation_id: conversation,
        device_id: destination,
        project_path: projectPath,
        start: false,
      }),
  ],
  [
    "claimSharedCheckout",
    ({ caller, conversation }) =>
      caller.mutation(api.cloud.claimSharedCheckout, {
        conversation_id: conversation,
        device_id: destination,
        project_path: projectPath,
      }),
  ],
  [
    "parkOnCloudHost",
    ({ t, user, conversation }) =>
      t.run(async (ctx) =>
        parkOnCloudHost(ctx, user, await ctx.db.get(conversation), destination),
      ),
  ],
];

test.each(cases)(
  "%s refuses fenced moves and still moves legacy rows",
  async (_name, move) => {
    const legacy = await moveFixture({ cloud_placement: "pending" });
    await move(legacy);
    expect(await legacy.read()).toMatchObject({
      owner_device_id: destination,
      user_id: legacy.user,
    });

    for (const state of ["fenced", "legacy-quiescing"] as const) {
      const fenced = await moveFixture({
        execution_protocol_state: state,
        cloud_placement: "pending",
      });
      const before = await fenced.read();
      await expect(move(fenced)).rejects.toThrow(refusal);
      expect(await fenced.read()).toEqual(before);
      expect(await fenced.commands()).toEqual([]);
    }
  },
);

test("moveToRemote refuses before it queues a file transfer", async () => {
  for (const state of [undefined, "fenced"] as const) {
    const f = await moveFixture({ execution_protocol_state: state });
    await f.t.run(async ({ db }) => {
      const device = await db
        .query("devices")
        .withIndex("by_user_device", (q) =>
          q.eq("user_id", f.user).eq("device_id", source),
        )
        .unique();
      await db.patch(device!._id, { last_seen: Date.now() });
    });
    const move = f.caller.mutation(api.devices.moveToRemote, {
      conversation_id: f.conversation,
      to_device_id: destination,
    });
    if (state) {
      await expect(move).rejects.toThrow(refusal);
      expect(await f.commands()).toEqual([]);
    } else {
      expect(await move).toMatchObject({ source, dest: destination });
      expect(await f.commands()).toMatchObject([
        { command: "move_to_device", target_device_id: source },
      ]);
    }
  }
});

test("claimConversationForStart refuses a fenced claim with a reason", async () => {
  for (const state of [undefined, "fenced"] as const) {
    const f = await moveFixture({ execution_protocol_state: state });
    const result = await f.caller.mutation(
      api.devices.claimConversationForStart,
      {
        conversation_id: f.conversation,
        device_id: destination,
      },
    );
    expect(result).toEqual(
      state ? { won: false, owner: source, reason: refusal } : { won: true },
    );
    expect((await f.read())?.owner_device_id).toBe(
      state ? source : destination,
    );
  }
});

test("registerManagedSession refuses a different device on a fenced row", async () => {
  for (const state of [undefined, "fenced"] as const) {
    const f = await moveFixture({ execution_protocol_state: state });
    const result = await f.caller.mutation(
      api.managedSessions.registerManagedSession,
      {
        session_id: sessionId,
        pid: 123,
        conversation_id: f.conversation,
        device_id: destination,
      },
    );
    expect((await f.read())?.owner_device_id).toBe(
      state ? source : destination,
    );
    const sessions = await f.t.run(({ db }) =>
      db.query("managed_sessions").collect(),
    );
    if (state) {
      expect(result).toEqual({
        notOwner: true,
        owner: source,
        reason: refusal,
      });
      expect(sessions).toEqual([]);
    } else {
      expect(sessions).toMatchObject([
        { conversation_id: f.conversation, pid: 123 },
      ]);
    }
  }
});

test("registerManagedSession keeps the fenced owner's heartbeat and leaves the conversation alone", async () => {
  const f = await moveFixture({
    execution_protocol_state: "fenced",
    session_error: "binding error",
  });
  const before = await f.read();
  await f.caller.mutation(api.managedSessions.registerManagedSession, {
    session_id: sessionId,
    pid: 123,
    conversation_id: f.conversation,
    device_id: source,
  });
  expect(await f.read()).toEqual(before);
  await f.t.run(async ({ db }) => {
    const managed = await db.query("managed_sessions").unique();
    expect(managed).toMatchObject({ user_id: f.user, pid: 123 });
    expect(await db.query("session_heartbeats").unique()).toMatchObject({
      managed_session_id: managed?._id,
    });
  });
});

test("cloud un-park keeps the fenced placement and its spawn", async () => {
  for (const state of [undefined, "fenced"] as const) {
    const f = await moveFixture({
      execution_protocol_state: state,
      cloud_placement: "pending",
      cloud_placement_token: "token",
    });
    await f.t.run(({ db }) =>
      db.insert("daemon_commands", {
        user_id: f.user,
        command: "cloud_spawn",
        args: JSON.stringify({ conversation_id: f.conversation }),
        created_at: Date.now(),
        target_device_id: source,
      }),
    );
    const before = await f.read();
    const priorCommands = await f.commands();
    const result = await f.caller.mutation(
      api.conversations.reconfigureSession,
      {
        conversation_id: f.conversation,
        target_device_id: destination,
      },
    );
    if (state) {
      expect(result).toEqual({ reconfigured: false, reason: refusal });
      expect(await f.read()).toEqual(before);
      expect(await f.commands()).toEqual(priorCommands);
    } else {
      expect((await f.read())?.owner_device_id).toBe(destination);
      expect((await f.read())?.cloud_placement_token).toBeUndefined();
      expect((await f.commands()).map(({ command }) => command)).toContain(
        "start_session",
      );
    }
  }
});

test("transcript ingest skips only the owner backfill on a fenced row", async () => {
  for (const state of [undefined, "fenced"] as const) {
    const f = await moveFixture({
      execution_protocol_state: state,
      owner_device_id: undefined,
    });
    await f.caller.mutation(api.conversations.createConversation, {
      user_id: f.user,
      session_id: sessionId,
      agent_type: "claude_code",
      owner_device_id: destination,
      agent_team_name: "test-team",
    });
    expect((await f.read())?.owner_device_id).toBe(
      state ? undefined : destination,
    );
    expect((await f.read())?.agent_team_name).toBe("test-team");
  }
});

test("claimDeviceAccount skips the fenced session and transfers its legacy neighbor", async () => {
  const f = await moveFixture({
    execution_protocol_state: "fenced",
    is_private: false,
  });
  const apiToken = "new-device-account-" + crypto.randomUUID();
  const previousToken = "previous-device-account-" + crypto.randomUUID();
  const { to, legacy } = await f.t.run(async ({ db }) => {
    const rows = fixtureRows(db, "device account transfer");
    const team = await rows.team();
    const to = await rows.user();
    await rows.token(to, apiToken);
    await rows.token(f.user, previousToken);
    await rows.membership(f.user, team);
    await rows.membership(to, team);
    await rows.device(to, { device_id: source, last_seen: Date.now() });
    await db.patch(f.conversation, { team_id: team });
    const legacy = await rows.conversation(f.user, {
      team_id: team,
      is_private: false,
      owner_device_id: source,
    });
    await rows.session(f.user, {
      conversation_id: f.conversation,
      session_id: sessionId,
    });
    return { to, legacy };
  });
  const before = await f.read();
  const result = await f.t.mutation(api.devices.claimDeviceAccount, {
    api_token: apiToken,
    previous_api_token: previousToken,
    previous_user_id: f.user,
    device_id: source,
  });
  expect(result).toEqual({ moved: 1, more: false, skipped: 1, error: refusal });
  expect(await f.read()).toEqual(before);
  await f.t.run(async ({ db }) => {
    expect(await db.get(legacy)).toMatchObject({
      user_id: to,
      author_user_id: f.user,
      owner_device_id: source,
    });
    expect(await db.query("managed_sessions").unique()).toMatchObject({
      user_id: f.user,
    });
  });
});

test("mergeDuplicateUser refuses to replace a fenced runner", async () => {
  for (const state of [undefined, "fenced"] as const) {
    const f = await moveFixture({ execution_protocol_state: state });
    const to = await f.t.run(({ db }) =>
      fixtureRows(db, "merge destination").user(),
    );
    const args = { from_user_id: f.user, to_user_id: to };
    await f.t.mutation(internal.admin_mergeUser.mergeDuplicateUser, {
      ...args,
      dry_run: true,
    });
    expect((await f.read())?.user_id).toBe(f.user);
    const merge = f.t.mutation(internal.admin_mergeUser.mergeDuplicateUser, {
      ...args,
      dry_run: false,
    });
    if (state) await expect(merge).rejects.toThrow(refusal);
    else await merge;
    expect((await f.read())?.user_id).toBe(state ? f.user : to);
  }
});

test("web dispatch reports the fenced un-park refusal", async () => {
  for (const state of [undefined, "fenced"] as const) {
    const f = await moveFixture({
      execution_protocol_state: state,
      cloud_placement: "pending",
    });
    const dispatch = f.caller.mutation(api.dispatch.dispatch, {
      action: "convCommand",
      args: [
        f.conversation,
        "reconfigureSession",
        { target_device_id: destination },
      ],
    });
    if (state) {
      await expect(dispatch).rejects.toMatchObject({ data: refusal });
      expect((await f.read())?.cloud_placement).toBe("pending");
      expect(await f.commands()).toEqual([]);
    } else {
      await dispatch;
      expect((await f.read())?.owner_device_id).toBe(destination);
    }
  }
});

test("migration planning skips fenced sessions before a transfer is queued", async () => {
  for (const state of [undefined, "fenced"] as const) {
    const f = await moveFixture({ execution_protocol_state: state });
    await f.t.run(async ({ db }) => {
      const devices = await db.query("devices").collect();
      for (const device of devices) {
        await db.patch(device._id, {
          is_remote: device.device_id === destination,
          last_seen: Date.now(),
        });
      }
    });
    const plan = await f.caller.mutation(api.sessionMigrations.createBatch, {
      conversation_ids: [f.conversation],
      to_device_id: destination,
    });
    if (state) {
      expect(plan.skipped).toMatchObject([
        { conversation_id: f.conversation, reason: refusal },
      ]);
      expect(plan.rows).toEqual([]);
      expect(await f.commands()).toEqual([]);
    } else {
      expect(plan.rows).toMatchObject([{ conversation_id: f.conversation }]);
      expect(await f.commands()).toMatchObject([
        { command: "migrate_sessions" },
      ]);
    }
  }
});

test("migration begin refuses a queued session that became fenced", async () => {
  const f = await moveFixture();
  await f.t.run(async ({ db }) => {
    const devices = await db.query("devices").collect();
    for (const device of devices) {
      await db.patch(device._id, {
        is_remote: device.device_id === destination,
        last_seen: Date.now(),
      });
    }
  });
  const plan = await f.caller.mutation(api.sessionMigrations.createBatch, {
    conversation_ids: [f.conversation],
    to_device_id: destination,
  });
  const migrationId = await f.t.run(async ({ db }) => {
    await db.patch(f.conversation, { execution_protocol_state: "fenced" });
    return db.normalizeId("session_migrations", plan.rows[0].migration_id)!;
  });
  const before = await f.read();
  await expect(
    f.caller.mutation(api.sessionMigrations.beginSession, {
      migration_id: migrationId,
      device_id: source,
    }),
  ).resolves.toEqual({ ok: false, reason: refusal });
  expect(await f.read()).toEqual(before);
  expect(await f.t.run(({ db }) => db.get(migrationId))).toMatchObject({
    status: "failed",
    error: refusal,
  });
});
