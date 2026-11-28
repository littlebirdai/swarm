import { expect, test } from "bun:test";
import { OWNED_CODEX_CHECKPOINT_PREFIX } from "@codecast/agent-clients/executionBinding";
import { STEER_BATON_CAPABILITY } from "@codecast/edge-contract";
import { presentToken } from "@platform/auth/tokenFormat";
import { asUser } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import {
  boot,
  machine,
  setupRunLease,
} from "../test-helpers/run-lease.testkit";
import { api, internal } from "./_generated/api";
import { EXECUTION_PROTOCOL_CAPABILITIES } from "./executionBindings";

test("a device-bound boot negotiates and publishes the owned Codex steer capability", async () => {
  const f = await setupRunLease();
  const conversation_id = await f.t.run(({ db }) =>
    fixtureRows(db, "new owned Codex session").conversation(f.owner, {
      agent_type: "codex",
    }),
  );
  const required_capabilities = [
    ...EXECUTION_PROTOCOL_CAPABILITIES,
    STEER_BATON_CAPABILITY,
  ];
  const device = { owner_device_id: machine, daemon_boot_id: boot };
  const register = (api_token: string, owned_codex_new_sessions?: boolean) =>
    f.t.mutation(api.executionBindings.registerExecutionDaemonBoot, {
      ...device,
      api_token,
      owned_codex_new_sessions,
    });
  const initialize = () =>
    f.t.mutation(api.executionBindings.initializeFencedExecution, {
      conversation_id,
      api_token: f.bearer,
      target: {
        ...device,
        project_path: "/fixture",
        requested_agent: "codex",
        transport: "app-server",
        configuration_revision: 1,
        protocol_version: 1,
        required_capabilities,
      },
    });
  await register(f.unbound, true);
  await expect(initialize()).rejects.toThrow(
    "the daemon boot did not offer owned Codex sessions",
  );
  await register(f.bearer, true);
  expect(await initialize()).toEqual({ state: "fenced", epoch: 1 });
  const list = (
    owned_codex_new_sessions?: boolean,
    capabilities: typeof required_capabilities = [
      ...EXECUTION_PROTOCOL_CAPABILITIES,
    ],
  ) =>
    f.t.query(api.executionBindings.listExecutionWork, {
      ...device,
      api_token: f.bearer,
      protocol_version: 1,
      capabilities,
      owned_codex_new_sessions,
    });
  expect(await list()).not.toContainEqual(
    expect.objectContaining({ conversationId: conversation_id }),
  );
  expect(await list(true)).toContainEqual(
    expect.objectContaining({
      conversationId: conversation_id,
      bindings: [
        expect.objectContaining({
          request: expect.objectContaining({
            requiredCapabilities: expect.arrayContaining(required_capabilities),
          }),
        }),
      ],
    }),
  );
  expect(await list(true, required_capabilities)).toEqual(await list(true));
  const fence = {
    ...device,
    api_token: f.bearer,
    conversation_id,
    epoch: 1,
    protocol_version: 1,
  };
  await expect(
    f.t.mutation(api.executionBindings.claimExecutionStart, {
      ...fence,
      configuration_revision: 1,
      required_capabilities,
      proposed_operation_id: "operation",
    }),
  ).resolves.toMatchObject({ state: "claimed" });
  const ready = (handle: string, capabilities = required_capabilities) =>
    f.t.mutation(api.executionBindings.publishReadyBinding, {
      ...fence,
      capabilities,
      handle,
      requested_agent: "codex",
      actual_agent: "codex",
      transport: "app-server",
      runtime_id: "runtime",
      operation_id: "operation",
      applied_configuration_revision: 1,
    });
  await expect(ready("legacy-handle")).resolves.toEqual({
    accepted: false,
    reason: "steer-runtime-mismatch",
  });
  const handle =
    OWNED_CODEX_CHECKPOINT_PREFIX +
    JSON.stringify({
      threadId: "runtime",
      sandbox: "read-only",
      approvalPolicy: "on-request",
    });
  await expect(
    ready(handle, [...EXECUTION_PROTOCOL_CAPABILITIES]),
  ).resolves.toEqual({
    accepted: false,
    reason: "compare-and-set-lost",
  });
  await expect(ready(handle)).resolves.toMatchObject({
    accepted: true,
    binding: { capabilities: expect.arrayContaining(required_capabilities) },
  });
  const lease = await f.t.mutation(internal.edgeRunLease.claim, {
    conversation_id,
    bearer: f.bearer,
    machine,
    boot,
    claim_id: "new-run",
  });
  if (lease.status !== "granted") throw Error("Expected run lease");
  const latest = async () =>
    (await list(true)).find(
      (item: { conversationId: string }) =>
        item.conversationId === conversation_id,
    );
  const append = async (seq: number, event: object) => {
    const scope = { session: conversation_id, run: 1 };
    const response = await f.t.fetch("/edge/v1/events.append", {
      method: "POST",
      headers: { authorization: `Bearer ${f.bearer}` },
      body: JSON.stringify({
        v: 1,
        batches: [
          {
            ...scope,
            fencing_token: lease.fencing_token,
            events: [
              {
                ...scope,
                v: 1,
                seq,
                at: Date.now(),
                turn: "turn",
                source: "provider",
                ...event,
              },
            ],
          },
        ],
      }),
    });
    expect(await response.json()).toMatchObject({
      results: [{ status: "appended", through_seq: seq }],
    });
  };
  expect(await latest()).toMatchObject({
    nextDeliverySequence: 1,
    openTurn: null,
  });
  await append(1, { kind: "turn.started", body: {} });
  expect(await latest()).toMatchObject({
    nextDeliverySequence: 1,
    openTurn: "turn",
  });
  await append(2, { kind: "turn.ended", body: { reason: "completed" } });
  expect(await latest()).toMatchObject({
    nextDeliverySequence: 1,
    openTurn: null,
  });
});

test("legacy quiescence activation requires the current boot to offer owned Codex", async () => {
  const f = await setupRunLease();
  const conversation_id = await f.t.run(({ db }) =>
    fixtureRows(db, "legacy Codex session").conversation(f.owner, {
      agent_type: "codex",
      owner_device_id: machine,
    }),
  );
  const api_token = f.bearer;
  const terminated_legacy_daemon_boot_id = "old-boot";
  await f.t.mutation(api.executionBindings.beginLegacyQuiescence, {
    conversation_id,
    owner_device_id: machine,
    legacy_daemon_boot_id: terminated_legacy_daemon_boot_id,
    protocol_version: 1,
    api_token,
  });
  const activate = () =>
    f.t.mutation(api.executionBindings.activateAfterLegacyQuiescence, {
      conversation_id,
      api_token,
      terminated_legacy_daemon_boot_id,
      runtime_disposition: "stopped",
      termination_evidence: "supervisor observed exit",
      target: {
        owner_device_id: machine,
        daemon_boot_id: boot,
        project_path: "/fixture",
        requested_agent: "codex",
        transport: "app-server",
        configuration_revision: 1,
        protocol_version: 1,
        required_capabilities: [
          ...EXECUTION_PROTOCOL_CAPABILITIES,
          STEER_BATON_CAPABILITY,
        ],
      },
    });
  const register = (
    daemon_boot_id: string,
    owned_codex_new_sessions: boolean,
  ) =>
    f.t.mutation(api.executionBindings.registerExecutionDaemonBoot, {
      owner_device_id: machine,
      daemon_boot_id,
      api_token,
      owned_codex_new_sessions,
    });
  await register(boot, false);
  await expect(activate()).rejects.toThrow(
    "the daemon boot did not offer owned Codex sessions",
  );
  await register("different-boot", true);
  await expect(activate()).rejects.toThrow(
    "the daemon boot did not offer owned Codex sessions",
  );
  await register(boot, true);
  await expect(activate()).resolves.toEqual({
    state: "fenced",
    epoch: 1,
    migratedMessages: 0,
  });
});

test("only the opted-in daemon boot can consume an owned Codex successor intent", async () => {
  const f = await setupRunLease();
  const required_capabilities = [
    ...EXECUTION_PROTOCOL_CAPABILITIES,
    STEER_BATON_CAPABILITY,
  ];
  await f.t.run(({ db }) =>
    db.patch(f.binding, {
      required_capabilities,
      capabilities: required_capabilities,
    }),
  );
  const request = {
    conversation_id: f.conversation,
    intent_id: "restart-owned-codex",
    expected_current_epoch: 1,
    policy: "drain-current" as const,
  };
  await asUser(f.t, f.owner).mutation(
    api.executionBindings.requestExecutionSuccessorIntent,
    { ...request, kind: "restart" },
  );
  const register = (
    daemon_boot_id: string,
    owned_codex_new_sessions: boolean,
  ) =>
    f.t.mutation(api.executionBindings.registerExecutionDaemonBoot, {
      api_token: f.bearer,
      owner_device_id: machine,
      daemon_boot_id,
      owned_codex_new_sessions,
    });
  const consume = () =>
    f.t.mutation(api.executionBindings.requestExecutionSuccessor, {
      ...request,
      api_token: f.bearer,
      target: {
        owner_device_id: machine,
        daemon_boot_id: boot,
        project_path: "/fixture",
        requested_agent: "codex",
        transport: "app-server",
        configuration_revision: 2,
        protocol_version: 1,
        required_capabilities,
      },
    });

  await register(boot, false);
  await expect(consume()).rejects.toThrow(
    "the daemon boot did not offer owned Codex sessions",
  );
  await register("different-boot", true);
  await expect(consume()).rejects.toThrow(
    "the daemon boot did not offer owned Codex sessions",
  );
  await f.t.run(async ({ db }) => {
    const head = await db.get(f.head);
    expect(head?.successor_intent?.status).toBe("pending");
    expect(head?.pending_epoch).toBeUndefined();
    expect(await db.query("execution_bindings").collect()).toHaveLength(1);
  });
  await register(boot, true);
  await expect(consume()).resolves.toMatchObject({ created: true, epoch: 2 });
  await expect(consume()).resolves.toMatchObject({ created: false, epoch: 2 });
});

test("preparing a device move requires the destination boot to offer owned Codex sessions", async () => {
  const f = await setupRunLease();
  const required_capabilities = [
    ...EXECUTION_PROTOCOL_CAPABILITIES,
    STEER_BATON_CAPABILITY,
  ];
  const destinationDevice = "move-destination";
  const destinationBoot = "destination-boot";
  const destinationSecret = "destination-token";
  await f.t.run(async ({ db }) => {
    await db.patch(f.binding, {
      required_capabilities,
      capabilities: required_capabilities,
    });
    const tokenId = await fixtureRows(db, "move destination").token(
      f.owner,
      destinationSecret,
    );
    await db.patch(tokenId, { device_id: destinationDevice });
  });
  const destinationBearer = presentToken(destinationSecret, destinationDevice);
  await f.t.mutation(internal.edgeRunLease.recordMove, {
    conversation_id: f.conversation,
    destination_device_id: destinationDevice,
    destination_runner_id: f.owner,
    expected_source_epoch: 1,
  });
  const recorded = await f.t.run(({ db }) => db.get(f.head));
  const move_id = recorded?.device_move?.move_id;
  if (!move_id) throw new Error("Expected a recorded move");
  const register = (owned_codex_new_sessions: boolean) =>
    f.t.mutation(api.executionBindings.registerExecutionDaemonBoot, {
      api_token: destinationBearer,
      owner_device_id: destinationDevice,
      daemon_boot_id: destinationBoot,
      owned_codex_new_sessions,
    });
  const prepare = () =>
    f.t.mutation(internal.edgeRunLease.prepareMove, {
      conversation_id: f.conversation,
      move_id,
      bearer: destinationBearer,
      daemon_boot_id: destinationBoot,
    });

  await register(false);
  await expect(prepare()).rejects.toThrow(
    "The destination daemon boot did not offer owned Codex sessions",
  );
  await f.t.run(async ({ db }) => {
    const head = await db.get(f.head);
    expect(head?.device_move?.phase).toBeUndefined();
    expect(head?.pending_epoch).toBeUndefined();
    expect(head?.admission_epoch).toBe(1);
    expect(await db.query("execution_bindings").collect()).toHaveLength(1);
  });

  await register(true);
  await expect(prepare()).resolves.toEqual({ epoch: 2 });
  await f.t.run(async ({ db }) => {
    const head = await db.get(f.head);
    expect(head?.device_move?.phase).toBe("preparing");
    expect(head?.pending_epoch).toBe(2);
    expect(head?.admission_epoch).toBe(2);
    expect(await db.query("execution_bindings").collect()).toHaveLength(2);
  });
});
