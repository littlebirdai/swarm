import { presentToken } from "@platform/auth/tokenFormat";
import { expect, test } from "bun:test";
import { asUser } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { setupRunLease } from "../test-helpers/run-lease.testkit";
import { api, internal } from "./_generated/api";

async function replay(
  f: Awaited<ReturnType<typeof setupRunLease>>,
  clientId = "delivery",
) {
  return asUser(f.t, f.owner).mutation(api.pendingMessages.sendMessageV2, {
    conversation_id: f.conversation,
    command_id: clientId,
    client_id: clientId,
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

async function forgetReceipt(
  f: Awaited<ReturnType<typeof setupRunLease>>,
  clientId: string,
) {
  await f.t.run(async ({ db }) => {
    const receipt = await db
      .query("local_command_receipts")
      .withIndex("by_principal_command", (q) =>
        q.eq("principal_id", f.owner).eq("command_id", clientId),
      )
      .unique();
    if (!receipt) throw new Error("Expected a send receipt");
    await db.delete(receipt._id);
  });
}

test.each(["preparing", "aborting"] as const)(
  "exact replays match on the source and retargeted successor during %s",
  async (phase) => {
    const f = await setupRunLease();
    const move = await recordMove(f);
    await move.prepare();
    expect(await replay(f)).toMatchObject({ status: "acknowledged" });
    await forgetReceipt(f, "delivery");

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

test.each(["preparing", "aborting"] as const)(
  "abort restores a staged send cancelled during %s so its replay matches",
  async (phase) => {
    const f = await setupRunLease();
    const clientId = "cancelled-staged-send";
    const cancel = (id: string) =>
      asUser(f.t, f.owner).mutation(api.dispatch.dispatch, {
        action: "cancelPendingMessage",
        args: [f.conversation, { clientId: id }],
      });
    expect(await replay(f, clientId)).toMatchObject({ status: "acknowledged" });
    expect(await cancel("delivery")).toBe("cancelled");

    const move = await recordMove(f);
    await move.prepare();
    const retarget = (bearer: string) =>
      f.t.mutation(internal.edgeRunLease.retargetMove, {
        ...move.address,
        bearer,
      });
    expect(await retarget(move.bearer)).toEqual({ moved: 1, done: true });
    const abort = () =>
      f.t.mutation(internal.edgeRunLease.abortMove, {
        ...move.address,
        bearer: f.bearer,
      });
    if (phase === "aborting") expect(await abort()).toEqual({ done: false });
    expect(await cancel(clientId)).toBe("cancelled");
    if (phase === "preparing") expect(await abort()).toEqual({ done: false });

    const read = () =>
      f.t.run(({ db }) => db.query("pending_messages").collect());
    const staged = await read();
    expect(staged).toMatchObject([
      { client_id: "delivery", execution_epoch: 1, owner_user_id: f.owner },
      {
        client_id: clientId,
        execution_epoch: 2,
        owner_user_id: move.destination,
        delivery_status: "cancelled-by-supersession",
        status: "cancelled",
      },
    ]);
    const restored = await retarget(f.bearer);
    await forgetReceipt(f, clientId);
    expect(await replay(f, clientId)).toMatchObject({ status: "acknowledged" });
    expect(restored).toEqual({ moved: 1, done: true });
    expect(await read()).toEqual(
      staged.map((row) => ({
        ...row,
        execution_epoch: 1,
        owner_user_id: f.owner,
      })),
    );
    expect(
      await f.t.run(({ db }) => db.query("execution_bindings").collect()),
    ).toMatchObject([{ epoch: 1 }]);
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
    abandoned: undefined,
  },
  {
    name: "terminal row from a failed start with a stray handle",
    state: "start-failed-before-effect",
    status: "delivered",
    handle: "stray-handle",
    abandoned: undefined,
  },
  {
    name: "terminal row from a handleless quarantine",
    state: "quarantined",
    status: "delivered",
    handle: undefined,
    abandoned: undefined,
  },
  {
    name: "terminal row from a quarantined abandoned move",
    state: "quarantined",
    status: "delivered",
    handle: "abandoned-handle",
    abandoned: true,
  },
] as const)(
  "a $name does not authorize a historical owner",
  async ({ state, status, handle, abandoned }) => {
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
        abandoned_move: abandoned,
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
