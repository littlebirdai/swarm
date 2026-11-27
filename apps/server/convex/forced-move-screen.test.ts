import { afterEach, beforeEach, expect, test } from "bun:test";
import { asUser } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { EXECUTION_PROTOCOL_CAPABILITIES } from "./executionBindings";
import { machine, setupRunLease } from "../test-helpers/run-lease.testkit";
import { api } from "./_generated/api";

const flag = "CODECAST_FORCED_DEVICE_MOVE_V1";
const previous = process.env[flag];

beforeEach(() => {
  process.env[flag] = "1";
});
afterEach(() => {
  if (previous === undefined) delete process.env[flag];
  else process.env[flag] = previous;
});

test("the running account sees eligible destinations and the recorded request through dispatch", async () => {
  const f = await setupRunLease();
  const teammate = await f.t.run(async ({ db }) => {
    const rows = fixtureRows(db, "forced move screen choices");
    const teammate = await rows.user();
    const team = await rows.team();
    await rows.membership(f.owner, team);
    await rows.membership(teammate, team);
    await rows.device(f.owner, {
      device_id: machine,
      label: "Laptop",
      last_seen: 10,
    });
    await rows.device(f.owner, { device_id: "studio", label: "Studio" });
    await rows.device(teammate, { device_id: "team-mac", label: "Team Mac" });
    await rows.device(teammate, {
      device_id: "private-mac",
      label: "Private Mac",
    });
    await db.insert("device_shares", {
      user_id: teammate,
      device_id: "team-mac",
      team_id: team,
      shared_at: 10,
    });
    return teammate;
  });
  const owner = asUser(f.t, f.owner);
  const target = { conversation_id: f.conversation };
  expect(
    await asUser(f.t, teammate).query(
      api.edgeRunLease.forcedMoveOptions,
      target,
    ),
  ).toEqual([]);
  expect(await owner.query(api.edgeRunLease.forcedMoveOptions, target)).toEqual(
    [
      {
        _id: f.conversation,
        epoch: 1,
        sourceLabel: "Laptop",
        offlineAfter: 120_010,
        requestedDestination: null,
        progress: null,
        failure: null,
        destinations: [
          { id: "studio", label: "Studio" },
          { id: "team-mac", label: "Team Mac" },
        ],
      },
    ],
  );
  const dispatch = (acknowledgement: boolean) =>
    owner.mutation(api.dispatch.dispatch, {
      action: "forceSessionMove",
      args: [
        "request",
        f.conversation,
        1,
        "team-mac",
        "Team Mac",
        acknowledgement,
      ],
    });
  await expect(dispatch(false)).rejects.toThrow("Expected `true`, got `false`");
  const moveId = await dispatch(true);
  expect(await f.t.run(({ db }) => db.get(f.head))).toMatchObject({
    device_move: {
      move_id: moveId,
      destination_device_id: "team-mac",
      destination_runner_id: teammate,
      forced: { by_user_id: f.owner },
    },
  });
  expect(
    await owner.query(api.edgeRunLease.forcedMoveOptions, target),
  ).toMatchObject([{ requestedDestination: "Team Mac", destinations: [] }]);
  delete process.env[flag];
  expect(await owner.query(api.edgeRunLease.forcedMoveOptions, target)).toEqual(
    [],
  );
});

test.each(["pending epoch", "pending successor"] as const)(
  "the move query returns no options with a %s and no move",
  async (transition) => {
    const f = await setupRunLease();
    const owner = asUser(f.t, f.owner);
    const args = { conversation_id: f.conversation };
    await f.t.run(async ({ db }) => {
      const rows = fixtureRows(db, "forced move transition");
      await rows.device(f.owner, { device_id: "studio", label: "Studio" });
    });
    expect(
      await owner.query(api.edgeRunLease.forcedMoveOptions, args),
    ).toMatchObject([{ destinations: [{ id: "studio", label: "Studio" }] }]);
    await f.t.run(({ db }) =>
      db.patch(
        f.head,
        transition === "pending epoch"
          ? { pending_epoch: 2 }
          : {
              successor_intent: {
                intent_id: "restart-intent",
                requested_by_user_id: f.owner,
                kind: "restart",
                expected_current_epoch: 1,
                policy: "cancel-unstarted",
                requested_agent: "codex",
                transport: "app-server",
                project_path: "/fixture",
                configuration_revision: 2,
                owner_device_id: machine,
                protocol_version: 1,
                required_capabilities: [...EXECUTION_PROTOCOL_CAPABILITIES],
                status: "pending",
                created_at: 10,
              },
            },
      ),
    );
    expect(await owner.query(api.edgeRunLease.forcedMoveOptions, args)).toEqual(
      [],
    );
  },
);

test("a previously force-fenced device is excluded from the move options", async () => {
  const f = await setupRunLease();
  await f.t.run(async ({ db }) => {
    const rows = fixtureRows(db, "forced move retired target");
    await rows.device(f.owner, { device_id: "studio", label: "Studio" });
    await rows.device(f.owner, { device_id: "retired", label: "Retired" });
    const { _id, _creationTime, ...binding } = (await db.get(f.binding))!;
    await db.insert("execution_bindings", {
      ...binding,
      owner_device_id: "retired",
      epoch: 0,
      state: "quarantined",
      forced_device_move: {
        move_id: "previous-move",
        by_user_id: f.owner,
        at: 10,
        destination_epoch: 1,
      },
    });
  });
  const args = { conversation_id: f.conversation };
  const owner = asUser(f.t, f.owner);
  expect(
    await owner.query(api.edgeRunLease.forcedMoveOptions, args),
  ).toMatchObject([{ destinations: [{ id: "studio", label: "Studio" }] }]);
  await expect(
    owner.mutation(api.edgeRunLease.forceMove, {
      ...args,
      expected_source_epoch: 1,
      destination_device_id: "retired",
      acknowledge_source_may_still_run: true,
    }),
  ).rejects.toThrow("This device was fenced");
});
