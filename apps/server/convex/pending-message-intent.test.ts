import { presentToken } from "@platform/auth/tokenFormat";
import { expect, test } from "bun:test";
import { asUser } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { setupRunLease } from "../test-helpers/run-lease.testkit";
import { api, internal } from "./_generated/api";

async function replay(f: Awaited<ReturnType<typeof setupRunLease>>) {
  return asUser(f.t, f.owner).mutation(api.pendingMessages.sendMessageV2, {
    conversation_id: f.conversation,
    command_id: "delivery",
    client_id: "delivery",
    content: "queued",
  });
}

test.each(["legacy without an owner", "fenced with an unrelated owner"])(
  "a non-moving conversation rejects a %s pending intent",
  async (kind) => {
    const f = await setupRunLease();
    const before = await f.t.run(async ({ db }) => {
      if (kind === "legacy without an owner") {
        await db.patch(f.message, {
          owner_user_id: undefined,
          execution_epoch: undefined,
          delivery_protocol_version: undefined,
          conversation_sequence: undefined,
          delivery_status: undefined,
          delivery_id: undefined,
        });
      } else {
        const rows = fixtureRows(db, "unrelated replay owner");
        await db.patch(f.message, { owner_user_id: await rows.user() });
      }
      return db.get(f.message);
    });
    expect(await replay(f)).toMatchObject({
      status: "rejected",
      rejection: { code: "CLIENT_ID_REUSED" },
    });
    expect(
      await f.t.run(({ db }) => db.query("pending_messages").collect()),
    ).toEqual([before]);
  },
);

async function recordMove(f: Awaited<ReturnType<typeof setupRunLease>>) {
  const device = "replay-destination";
  const secret = "replay-destination-token";
  const daemon_boot_id = "replay-destination-boot";
  const destination = await f.t.run(async ({ db }) => {
    const rows = fixtureRows(db, "replay move destination");
    const user = await rows.user();
    const token = await rows.token(user, secret);
    await db.patch(token, { device_id: device });
    return user;
  });
  const bearer = presentToken(secret, device);
  await f.t.mutation(api.executionBindings.registerExecutionDaemonBoot, {
    api_token: bearer,
    owner_device_id: device,
    daemon_boot_id,
  });
  await f.t.mutation(internal.edgeRunLease.recordMove, {
    conversation_id: f.conversation,
    destination_device_id: device,
    destination_runner_id: destination,
    expected_source_epoch: 1,
  });
  const move = (await f.t.run(({ db }) => db.get(f.head)))?.device_move;
  if (!move?.move_id) throw new Error("Expected a move record");
  const address = {
    conversation_id: f.conversation,
    move_id: move.move_id,
  };
  const prepare = () =>
    f.t.mutation(internal.edgeRunLease.prepareMove, {
      ...address,
      bearer,
      daemon_boot_id,
    });
  return { destination, bearer, address, prepare };
}

async function expectReplayRejected(
  f: Awaited<ReturnType<typeof setupRunLease>>,
) {
  const queued = () =>
    f.t.run(({ db }) => db.query("pending_messages").collect());
  const before = await queued();
  expect(await replay(f)).toMatchObject({
    status: "rejected",
    rejection: { code: "CLIENT_ID_REUSED" },
  });
  expect(await queued()).toEqual(before);
}

test.each(["preparing", "aborting"] as const)(
  "exact replays match on the source and retargeted successor during %s",
  async (phase) => {
    const f = await setupRunLease();
    const move = await recordMove(f);
    await move.prepare();
    expect(await replay(f)).toMatchObject({ status: "acknowledged" });
    await f.t.run(async ({ db }) => {
      const receipt = await db
        .query("local_command_receipts")
        .withIndex("by_principal_command", (q) =>
          q.eq("principal_id", f.owner).eq("command_id", "delivery"),
        )
        .unique();
      if (!receipt) throw new Error("Expected a source replay receipt");
      await db.delete(receipt._id);
    });

    expect(
      await f.t.mutation(internal.edgeRunLease.retargetMove, {
        ...move.address,
        bearer: move.bearer,
      }),
    ).toEqual({ moved: 1, done: true });
    if (phase === "aborting") {
      expect(
        await f.t.mutation(internal.edgeRunLease.abortMove, {
          ...move.address,
          bearer: f.bearer,
        }),
      ).toEqual({ done: false });
    }
    const before = await f.t.run(({ db }) => db.get(f.message));
    expect(before).toMatchObject({
      owner_user_id: move.destination,
      execution_epoch: 2,
    });
    expect(await replay(f)).toMatchObject({ status: "acknowledged" });
    expect(
      await f.t.run(({ db }) => db.query("pending_messages").collect()),
    ).toEqual([before]);
  },
);

test.each(["recorded", "preparing"] as const)(
  "the destination cannot authorize a forged source-epoch owner during a %s move",
  async (phase) => {
    const f = await setupRunLease();
    const move = await recordMove(f);
    if (phase === "preparing") await move.prepare();
    await f.t.run(({ db }) =>
      db.patch(f.message, {
        owner_user_id: move.destination,
      }),
    );
    await expectReplayRejected(f);
  },
);

test.each([
  {
    name: "nonterminal row after a round trip",
    state: "stopped",
    status: "pending",
    handle: "prior-handle",
  },
  {
    name: "terminal row from a failed start with a stray handle",
    state: "start-failed-before-effect",
    status: "delivered",
    handle: "stray-handle",
  },
  {
    name: "terminal row from a handleless quarantine",
    state: "quarantined",
    status: "delivered",
    handle: undefined,
  },
] as const)(
  "a $name does not authorize a historical owner",
  async ({ state, status, handle }) => {
    const f = await setupRunLease();
    await f.t.run(async ({ db }) => {
      const rows = fixtureRows(db, "historical replay owner");
      const priorRunner = await rows.user();
      const sourceBinding = await db.get(f.binding);
      if (!sourceBinding) throw new Error("Expected a source binding");
      const { _id, _creationTime, ...binding } = sourceBinding;
      await db.patch(f.binding, { state: "stopped" });
      await db.insert("execution_bindings", {
        ...binding,
        epoch: 2,
        owner_user_id: priorRunner,
        owner_device_id: "prior-device",
        state,
        handle,
      });
      await db.insert("execution_bindings", { ...binding, epoch: 3 });
      await db.patch(f.head, { current_epoch: 3, admission_epoch: 3 });
      await db.patch(f.message, {
        owner_user_id: priorRunner,
        execution_epoch: 2,
        status,
        delivery_status: status,
      });
    });
    await expectReplayRejected(f);
  },
);
