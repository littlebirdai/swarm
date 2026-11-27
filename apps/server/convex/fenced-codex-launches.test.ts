import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { OWNED_CODEX_CHECKPOINT_PREFIX } from "@codecast/agent-clients/executionBinding";
import {
  parseCommandsNextResponse,
  STEER_BATON_CAPABILITY,
} from "@codecast/edge-contract";
import { asUser } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import {
  boot,
  machine,
  setupRunLease,
} from "../test-helpers/run-lease.testkit";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { EXECUTION_PROTOCOL_CAPABILITIES } from "./executionBindings";

const enrollment = "CODECAST_FENCED_NEW_SESSIONS_V1";
const flags = [
  enrollment,
  "CODECAST_FENCED_EXECUTION_V1",
  "CODECAST_EDGE_DELIVERY_V1",
  "SWARM_TURN_BATON",
];
const previous = flags.map((flag) => process.env[flag]);
beforeEach(() => {
  jest.useFakeTimers();
  for (const flag of flags) process.env[flag] = "1";
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  flags.forEach((flag, index) => {
    if (previous[index] === undefined) delete process.env[flag];
    else process.env[flag] = previous[index];
  });
});

const project_path = "/fixture";
const paths = [
  "quick",
  "task",
  "role",
  "CLI spawn",
  "composer first send",
  "start with prompt",
] as const;

async function fixture(path: (typeof paths)[number]) {
  const f = await setupRunLease();
  const role_id = await f.t.run(async ({ db }) => {
    const rows = fixtureRows(db, "local launch routes");
    await rows.device(f.owner, {
      device_id: machine,
      last_seen: Date.now(),
      local_project_roots: [project_path],
    });
    await rows.task(f.owner, {
      short_id: "ct-launch",
      workspace: `user:${f.owner}`,
      title: "Launch task",
      project_path,
    });
    return await rows.role(f.owner, { short_id: "or-launch" });
  });
  const register = (daemon_boot_id: string) =>
    f.t.mutation(api.executionBindings.registerExecutionDaemonBoot, {
      owner_device_id: machine,
      daemon_boot_id,
      owned_codex_new_sessions: true,
      api_token: f.bearer,
    });
  await register(boot);
  const viewer = asUser(f.t, f.owner);
  let conversation: Id<"conversations">;
  switch (path) {
    case "quick":
      conversation = await viewer.mutation(
        api.conversations.createQuickSession,
        { agent_type: "codex", project_path },
      );
      break;
    case "task":
      conversation = (
        await viewer.mutation(api.tasks.assignToAgent, {
          agent_type: "codex",
          short_id: "ct-launch",
        })
      ).conversationId;
      break;
    case "role":
      conversation = (
        await viewer.mutation(api.orgRoles.provision, {
          role_id,
          agent_type: "codex",
          project_path,
        })
      ).conversation_id;
      break;
    case "CLI spawn":
      conversation = (
        await f.t.mutation(api.spawn.createSessionFromCli, {
          api_token: f.bearer,
          agent_type: "codex",
          project_path,
          prompt: "Start work",
        })
      ).conversation_id;
      break;
    case "composer first send":
      conversation = (await viewer.mutation(api.dispatch.dispatch, {
        action: "createSession",
        args: [
          { agent_type: "codex", project_path, session_id: "local-first-send" },
        ],
      })) as Id<"conversations">;
      break;
    case "start with prompt":
      conversation = (
        await viewer.mutation(api.users.startSession, {
          agent_type: "codex",
          project_path,
          prompt: "Start work",
        })
      ).conversation_id;
      break;
  }
  return { ...f, viewer, conversation, register };
}

test.each(paths)(
  "%s starts fenced and preserves its attempt and prompt replay after reconnect",
  async (path) => {
    const f = await fixture(path);
    const read = () =>
      f.t.run(async ({ db }) => ({
        row: await db.get(f.conversation),
        commands: await db.query("daemon_commands").collect(),
        pending: await db
          .query("pending_messages")
          .withIndex("by_conversation_id", (q) =>
            q.eq("conversation_id", f.conversation),
          )
          .collect(),
      }));
    const created = await read();
    expect(created.row).toMatchObject({
      execution_protocol_state: "fenced",
      owner_device_id: machine,
    });
    expect(created.commands).toEqual([]);
    if (path === "quick" || path === "composer first send") {
      const send = {
        conversation_id: f.conversation,
        command_id: "composer",
        client_id: "composer",
        content: "Begin",
      };
      const first = await f.viewer.mutation(
        api.pendingMessages.sendMessageV2,
        send,
      );
      expect(
        await f.viewer.mutation(api.pendingMessages.sendMessageV2, send),
      ).toEqual(first);
    }
    const [first, ...rest] = (await read()).pending;
    expect(rest).toEqual([]);
    expect(first).toMatchObject({
      conversation_sequence: 1,
      execution_epoch: 1,
      delivery_status: "pending",
    });
    expect(first!.delivery_id).toBe(first!.client_id);

    const capabilities = [
      ...EXECUTION_PROTOCOL_CAPABILITIES,
      STEER_BATON_CAPABILITY,
    ];
    const context = {
      conversation_id: f.conversation,
      api_token: f.bearer,
      owner_device_id: machine,
      epoch: 1,
      protocol_version: 1,
    };
    const claimStart = (daemon_boot_id: string) =>
      f.t.mutation(api.executionBindings.claimExecutionStart, {
        ...context,
        configuration_revision: 1,
        required_capabilities: capabilities,
        daemon_boot_id,
        proposed_operation_id: "launch",
      });
    expect(await claimStart(boot)).toMatchObject({ state: "claimed" });
    expect(
      await f.t.mutation(api.executionBindings.publishReadyBinding, {
        ...context,
        daemon_boot_id: boot,
        capabilities,
        operation_id: "launch",
        requested_agent: "codex",
        actual_agent: "codex",
        transport: "app-server",
        runtime_id: "thread",
        handle: OWNED_CODEX_CHECKPOINT_PREFIX + '{"threadId":"thread"}',
        applied_configuration_revision: 1,
      }),
    ).toMatchObject({ accepted: true });

    const claim = async (bootId: string) => {
      const lease = await f.t.mutation(internal.edgeRunLease.claim, {
        bearer: f.bearer,
        conversation_id: f.conversation,
        machine,
        boot: bootId,
        claim_id: bootId,
      });
      if (lease.status !== "granted") throw Error(JSON.stringify(lease));
      return {
        v: 1 as const,
        bearer: f.bearer,
        session: f.conversation,
        run: 1,
        fencing_token: lease.fencing_token,
      };
    };
    const firstLease = await claim(boot);
    const permit = await f.t.mutation(internal.edgeDelivery.next, firstLease);
    if (permit.status !== "permit") throw Error(JSON.stringify(permit));
    const delivery = {
      ...firstLease,
      attempt_id: permit.attempt_id,
      delivery_id: permit.delivery_id,
      seq: permit.seq,
      intent: permit.intent,
      sender: permit.sender,
    };
    expect(
      await f.t.mutation(internal.edgeDelivery.start, delivery),
    ).toMatchObject({ status: "started" });
    expect(
      await f.t.mutation(internal.edgeDelivery.settle, {
        ...delivery,
        outcome: "in_doubt",
      }),
    ).toMatchObject({ status: "recorded" });
    await f.viewer.mutation(api.users.resumeSession, {
      conversation_id: f.conversation,
    });
    expect((await read()).commands).toEqual([]);
    expect((await read()).pending[0]?.delivery_status).toBe("ambiguous");

    expect(
      await f.t.mutation(internal.edgeRunLease.release, {
        bearer: f.bearer,
        conversation_id: f.conversation,
        run: 1,
        fencing_token: firstLease.fencing_token,
      }),
    ).toMatchObject({ status: "released" });
    const nextBoot = "replacement";
    await f.register(nextBoot);
    expect(await claimStart(nextBoot)).toMatchObject({
      state: "ready",
      binding: { runtimeId: "thread" },
    });
    const work = await f.t.query(api.executionBindings.listExecutionWork, {
      owner_device_id: machine,
      api_token: f.bearer,
      protocol_version: 1,
      daemon_boot_id: nextBoot,
      capabilities: [...EXECUTION_PROTOCOL_CAPABILITIES],
      owned_codex_new_sessions: true,
    });
    expect(work).toContainEqual(
      expect.objectContaining({
        conversationId: f.conversation,
        resumeGeneration: 1,
      }),
    );
    const lease = await claim(nextBoot);
    expect(await f.t.mutation(internal.edgeDelivery.next, lease)).toMatchObject(
      {
        status: "permit",
        attempt_id: permit.attempt_id,
        delivery_id: permit.delivery_id,
        state: "started",
      },
    );
    await expect(
      f.t.mutation(internal.edgeDelivery.settle, {
        ...delivery,
        fencing_token: lease.fencing_token,
        outcome: "applied",
      }),
    ).rejects.toThrow("resolution_evidence_required");

    const event = {
      v: 1,
      session: f.conversation,
      run: 1,
      source: "provider",
      turn: "turn",
      at: Date.now(),
    };
    expect(
      await f.t.mutation(internal.edgeRunLease.append, {
        bearer: f.bearer,
        conversation_id: f.conversation,
        run: 1,
        fencing_token: lease.fencing_token,
        events_json: JSON.stringify([
          { ...event, seq: 1, kind: "turn.started", body: {} },
          {
            ...event,
            seq: 2,
            kind: "prompt.opened",
            body: { prompt_id: "permission", kind: "permission" },
          },
        ]),
      }),
    ).toMatchObject({ status: "appended" });
    const target = {
      conversation_id: f.conversation,
      run: 1,
      turn_id: "turn",
      prompt_id: "permission",
    };
    const address = await f.viewer.query(
      api.permissions.getPromptAddress,
      target,
    );
    if (!address) throw Error("Expected a prompt address");
    const command_id = await f.viewer.mutation(api.permissions.answerPrompt, {
      ...address,
      answer: { behavior: "allow" },
    });
    const post = async (operation: string, input: object) => {
      const response = await f.t.fetch(`/edge/v1/${operation}`, {
        method: "POST",
        headers: { authorization: `Bearer ${f.bearer}` },
        body: JSON.stringify(input),
      });
      return await response.json();
    };
    const machineScope = { v: 1, machine, boot: nextBoot };
    const response = parseCommandsNextResponse(
      await post("commands.next", machineScope),
    );
    if (!response.ok || response.value.status !== "command")
      throw Error(JSON.stringify(response));
    expect(response.value.command_id).toBe(command_id);
    const disposition = {
      ...machineScope,
      command_id,
      claim: response.value.claim,
      outcome: "completed",
      output: null,
    };
    expect(await post("commands.result", disposition)).toMatchObject({
      status: "recorded",
    });
    expect(await post("commands.result", disposition)).toMatchObject({
      status: "duplicate",
    });
    expect(await post("commands.next", machineScope)).toMatchObject({
      status: "empty",
    });
  },
);

test.each(paths)(
  "%s retains its legacy start with enrollment off",
  async (path) => {
    delete process.env[enrollment];
    const f = await fixture(path);
    const { conversation, commands } = await f.t.run(async ({ db }) => ({
      conversation: await db.get(f.conversation),
      commands: await db.query("daemon_commands").collect(),
    }));
    expect(conversation?.execution_protocol_state).toBeUndefined();
    expect(
      commands.filter((cmd) => cmd.command === "start_session"),
    ).toHaveLength(1);
  },
);

test("a merge-back report queues one fenced delivery to the parent across replay", async () => {
  const f = await fixture("quick");
  const worker = await f.t.run(({ db }) =>
    fixtureRows(db, "merge back worker").conversation(f.owner, {
      parent_conversation_id: f.conversation,
      merge_back: { state: "pending", at: Date.now() },
    }),
  );
  const report = () =>
    f.t.mutation(api.subagentFleet.reportMergeBack, {
      api_token: f.bearer,
      conversation_id: worker,
      state: "conflict",
      files: ["src/changed.ts"],
    });
  const messages = () =>
    f.t.run(({ db }) =>
      db
        .query("pending_messages")
        .withIndex("by_conversation_id", (q) =>
          q.eq("conversation_id", f.conversation),
        )
        .collect(),
    );

  await report();
  expect(await f.t.run(({ db }) => db.get(worker))).toMatchObject({
    merge_back: { state: "conflict", files: ["src/changed.ts"] },
  });
  const queued = await messages();
  expect(queued).toMatchObject([
    {
      from_conversation_id: worker,
      execution_epoch: 1,
      conversation_sequence: 1,
      delivery_status: "pending",
    },
  ]);
  expect(queued[0]?.content).toContain("src/changed.ts");
  expect(queued[0]?.client_id).toMatch(/^merge-back:/);
  expect(queued[0]?.delivery_id).toBe(queued[0]?.client_id);
  jest.setSystemTime(Date.now() + 1000);
  await report();
  expect(await messages()).toEqual(queued);

  await f.t.run(({ db }) =>
    db.patch(worker, { merge_back: { state: "pending", at: Date.now() } }),
  );
  await report();
  const next = await messages();
  expect(next).toHaveLength(2);
  expect(next[1]?.conversation_sequence).toBe(2);
  expect(next[1]?.delivery_id).not.toBe(queued[0]?.delivery_id);
});

test("adopting a fenced workspace anchor queues the role bootstrap", async () => {
  const f = await fixture("quick");
  const anchor = await f.t.run(async ({ db }) => {
    const bot = await fixtureRows(db, "fenced anchor identity").user({
      is_bot: true,
    });
    const id = await db.insert("anchors", {
      scope_type: "user",
      scope_user_id: f.owner,
      host_user_id: f.owner,
      bot_user_id: bot,
      conversation_id: f.conversation,
      status: "active",
      name: "Workspace anchor",
      created_at: Date.now(),
    });
    await db.patch(f.conversation, { anchor_id: id });
    return id;
  });

  await expect(
    f.viewer.mutation(api.orgRoles.provision, {
      role_id: "or-launch",
      adopt_conversation_id: f.conversation,
    }),
  ).resolves.toMatchObject({
    anchor_id: anchor,
    conversation_id: f.conversation,
    adopted: true,
  });
  const messages = await f.t.run(({ db }) =>
    db
      .query("pending_messages")
      .withIndex("by_conversation_id", (q) =>
        q.eq("conversation_id", f.conversation),
      )
      .collect(),
  );
  expect(messages).toMatchObject([
    {
      execution_epoch: 1,
      conversation_sequence: 1,
    },
  ]);
  expect(messages[0]?.client_id).toMatch(/^anchor-adopt:/);
  expect(messages[0]?.delivery_id).toBe(messages[0]?.client_id);
});
