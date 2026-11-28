import { afterEach, beforeEach, expect, test } from "bun:test";
import { OWNED_CODEX_CHECKPOINT_PREFIX } from "@codecast/agent-clients/executionBinding";
import { STEER_BATON_CAPABILITY } from "@codecast/edge-contract";
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

const previousBaton = process.env.SWARM_TURN_BATON;

beforeEach(() => {
  process.env.SWARM_TURN_BATON = "1";
});

afterEach(() => {
  if (previousBaton === undefined) delete process.env.SWARM_TURN_BATON;
  else process.env.SWARM_TURN_BATON = previousBaton;
});

const createArgs = {
  action: "createSession",
  args: [
    {
      agent_type: "codex",
      project_path: "/fixture",
      session_id: "composer-created-session",
      target_device_id: machine,
    },
  ],
};

async function launch(optedIn = true) {
  const f = await setupRunLease();
  const { sender, outsider, outsiderSender } = await f.t.run(async ({ db }) => {
    const rows = fixtureRows(db, "codex enrollment");
    await rows.device(f.owner, {
      device_id: machine,
      last_seen: Date.now(),
      local_project_roots: ["/fixture"],
    });
    const outsider = await rows.user();
    await rows.conversation(f.owner, { session_id: "different-session" });
    return {
      sender: await rows.conversation(f.owner, {
        session_id: "sending-session",
      }),
      outsider,
      outsiderSender: await rows.conversation(outsider),
    };
  });
  await f.t.mutation(api.executionBindings.registerExecutionDaemonBoot, {
    owner_device_id: machine,
    daemon_boot_id: boot,
    api_token: f.bearer,
    owned_codex_new_sessions: optedIn,
  });
  const signedIn = asUser(f.t, f.owner);
  const conversation = (await signedIn.mutation(
    api.dispatch.dispatch,
    createArgs,
  )) as Id<"conversations">;
  const inspect = () =>
    f.t.run(async ({ db }) => ({
      conversation: await db.get(conversation),
      head: await db
        .query("conversation_execution_heads")
        .withIndex("by_conversation", (q) =>
          q.eq("conversation_id", conversation),
        )
        .unique(),
      commands: await db.query("daemon_commands").collect(),
    }));
  const send = (
    client_id: string | undefined,
    from = "sending-session",
    queue = false,
  ) =>
    f.t.mutation(api.pendingMessages.sendSessionMessage, {
      to: conversation,
      from,
      body: "Check the result",
      client_id,
      api_token: f.bearer,
      ...(queue && { direct: true, queue: true }),
    });
  return {
    ...f,
    signedIn,
    conversation,
    inspect,
    send,
    sender,
    outsiderSender,
    outsider,
  };
}

async function openTurn(
  f: Awaited<ReturnType<typeof launch>>,
  withStarter = true,
) {
  const cap = [...EXECUTION_PROTOCOL_CAPABILITIES, STEER_BATON_CAPABILITY];
  const bindingFence = {
    conversation_id: f.conversation,
    owner_device_id: machine,
    daemon_boot_id: boot,
    epoch: 1,
    protocol_version: 1,
    api_token: f.bearer,
  };
  await expect(
    f.t.mutation(api.executionBindings.claimExecutionStart, {
      ...bindingFence,
      configuration_revision: 1,
      required_capabilities: cap,
      proposed_operation_id: "launch-operation",
    }),
  ).resolves.toMatchObject({ state: "claimed" });
  await expect(
    f.t.mutation(api.executionBindings.publishReadyBinding, {
      ...bindingFence,
      requested_agent: "codex",
      actual_agent: "codex",
      transport: "app-server",
      runtime_id: "thread",
      handle: OWNED_CODEX_CHECKPOINT_PREFIX + '{"threadId":"thread"}',
      operation_id: "launch-operation",
      applied_configuration_revision: 1,
      capabilities: cap,
    }),
  ).resolves.toMatchObject({ accepted: true });
  const lease = await f.t.mutation(internal.edgeRunLease.claim, {
    conversation_id: f.conversation,
    bearer: f.bearer,
    machine,
    boot,
    claim_id: "lease",
  });
  if (lease.status !== "granted") throw new Error("Expected run lease");
  const run = {
    v: 1 as const,
    session: f.conversation,
    run: 1,
    fencing_token: lease.fencing_token,
  };
  const edge = { ...run, bearer: f.bearer };
  const next = () => f.t.mutation(internal.edgeDelivery.next, edge);
  const begin = (permit: Awaited<ReturnType<typeof next>>) => {
    if (permit.status !== "permit") throw Error(JSON.stringify(permit));
    return {
      ...edge,
      attempt_id: permit.attempt_id,
      delivery_id: permit.delivery_id,
      seq: permit.seq,
      intent: permit.intent,
      sender: permit.sender,
    };
  };

  await f.signedIn.mutation(api.pendingMessages.sendMessageV2, {
    conversation_id: f.conversation,
    command_id: "initial",
    client_id: "initial",
    content: "Start working",
  });
  const first = begin(await next());
  await expect(
    f.t.mutation(internal.edgeDelivery.start, first),
  ).resolves.toMatchObject({ status: "started" });
  const { v, ...batch } = run;
  const append = async (seq: number, payload: object) => {
    const response = await f.t.fetch("/edge/v1/events.append", {
      method: "POST",
      headers: { authorization: `Bearer ${f.bearer}` },
      body: JSON.stringify({
        v,
        batches: [
          {
            ...batch,
            events: [
              {
                v,
                session: f.conversation,
                run: 1,
                turn: "open-turn",
                seq,
                at: Date.now(),
                source: "provider",
                ...payload,
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
  await append(1, {
    kind: "turn.started",
    body: withStarter ? { starter: { kind: "person", id: f.owner } } : {},
  });
  await expect(
    f.t.mutation(internal.edgeDelivery.settle, {
      ...first,
      outcome: "applied",
    }),
  ).resolves.toMatchObject({ status: "recorded" });

  return {
    next,
    end: () => append(2, { kind: "turn.ended", body: { reason: "completed" } }),
    start: (permit: Awaited<ReturnType<typeof next>>) =>
      f.t.mutation(internal.edgeDelivery.start, begin(permit)),
    settle: (permit: Awaited<ReturnType<typeof next>>) =>
      f.t.mutation(internal.edgeDelivery.settle, {
        ...begin(permit),
        outcome: "applied",
      }),
  };
}

test("a fresh composer session enrolls before its first send and queues an agent without a grant", async () => {
  const f = await launch();
  const state = await f.inspect();
  expect(state.conversation?.execution_protocol_state).toBe("fenced");
  expect(state.head).toMatchObject({
    current_epoch: 1,
    next_conversation_sequence: 1,
  });
  expect(state.commands).toHaveLength(0);
  expect(await f.signedIn.mutation(api.dispatch.dispatch, createArgs)).toBe(
    f.conversation,
  );

  const turn = await openTurn(f);
  const sent = await f.send("agent-queue");
  expect(await turn.next()).toMatchObject({ status: "empty" });
  expect(await f.t.run(({ db }) => db.get(sent.message_id!))).toMatchObject({
    execution_epoch: 1,
    conversation_sequence: 2,
    delivery_intent: "queue",
    from_conversation_id: f.sender,
  });
  await turn.end();
  expect(await turn.next()).toMatchObject({
    status: "permit",
    intent: "queue",
    delivery_id: "agent-queue",
    sender: { kind: "agent", id: f.sender },
  });
});

test.each([false, true])(
  "a live owner grant admits exactly its sender and a revoked permit cannot start (%s)",
  async (revoke) => {
    const f = await launch();
    const turn = await openTurn(f);
    const grant = (
      sender_conversation_id: Id<"conversations"> | null,
      viewer = f.owner,
    ) =>
      asUser(f.t, viewer).mutation(api.executionBindings.setAgentSteerGrant, {
        conversation_id: f.conversation,
        sender_conversation_id,
      });
    await expect(grant(f.outsiderSender, f.outsider)).rejects.toThrow(
      "Only the session owner",
    );
    await grant(f.sender);

    const queued = await f.send("other-sender", "different-session");
    expect(await f.t.run(({ db }) => db.get(queued.message_id!))).toMatchObject(
      { delivery_intent: "queue" },
    );

    const sent = await f.send("steer-sender");
    expect(await f.t.run(({ db }) => db.get(sent.message_id!))).toMatchObject({
      delivery_intent: "steer",
      delivery_observed_turn: { run: 1, id: "open-turn", start_event_seq: 1 },
    });
    const permit = await turn.next();
    expect(permit).toMatchObject({
      status: "permit",
      intent: "steer",
      sender: { kind: "agent", id: f.sender },
    });
    if (revoke) {
      await grant(null);
      await grant(f.sender);
      expect(await turn.start(permit)).toMatchObject({
        status: "rejected",
        reason: "stale-agent-grant",
      });
    } else {
      expect(await turn.start(permit)).toMatchObject({ status: "started" });
    }
  },
);

test("an owner grant cannot steer a turn that has no verified starter", async () => {
  const f = await launch();
  const turn = await openTurn(f, false);
  await f.signedIn.mutation(api.executionBindings.setAgentSteerGrant, {
    conversation_id: f.conversation,
    sender_conversation_id: f.sender,
  });

  const sent = await f.send("agent-without-verified-starter");
  expect(await f.t.run(({ db }) => db.get(sent.message_id!))).toMatchObject({
    delivery_intent: "queue",
    from_conversation_id: f.sender,
  });
  expect(await turn.next()).toMatchObject({ status: "empty" });
  await turn.end();
  expect(await turn.next()).toMatchObject({
    status: "permit",
    intent: "queue",
    sender: { kind: "agent", id: f.sender },
    delivery_id: "agent-without-verified-starter",
  });
});

test.each([false, true])(
  "an explicit agent queue preserves the sender and waits for the turn to end (grant: %s)",
  async (granted) => {
    const f = await launch();
    const turn = await openTurn(f);
    if (granted) {
      await f.signedIn.mutation(api.executionBindings.setAgentSteerGrant, {
        conversation_id: f.conversation,
        sender_conversation_id: f.sender,
      });
    }
    const sent = await f.send("explicit-agent-queue", "sending-session", true);
    expect(await f.t.run(({ db }) => db.get(sent.message_id!))).toMatchObject({
      queued: true,
      status: "held",
      delivery_intent: "queue",
      from_conversation_id: f.sender,
    });
    expect(await turn.next()).toMatchObject({ status: "empty" });
    await turn.end();
    const permit = await turn.next();
    expect(permit).toMatchObject({
      status: "permit",
      intent: "queue",
      sender: { kind: "agent", id: f.sender },
      delivery_id: "explicit-agent-queue",
    });
    expect(await turn.start(permit)).toMatchObject({ status: "started" });
    expect(await turn.settle(permit)).toMatchObject({ status: "recorded" });
  },
);

test("an explicit agent send stays unallocated and held when the baton flag is off", async () => {
  const clientId = "queue-without-baton";
  const f = await launch();
  const turn = await openTurn(f);
  delete process.env.SWARM_TURN_BATON;

  const sent = await f.send(clientId, "sending-session", true);
  const queued = await f.t.run(({ db }) => db.get(sent.message_id!));
  expect(queued).toMatchObject({
    queued: true,
    status: "held",
    from_conversation_id: f.sender,
  });
  expect(queued?.client_id).toBe(clientId);
  expect(queued?.delivery_protocol_version).toBeUndefined();
  expect(queued?.delivery_id).toBeUndefined();
  expect(queued?.delivery_intent).toBeUndefined();
  expect(await turn.next()).toMatchObject({ status: "empty" });
});

test("an explicit agent send without a client ID is refused and writes nothing", async () => {
  const f = await launch();
  const turn = await openTurn(f);
  const before = await f.t.run(({ db }) =>
    db.query("pending_messages").collect(),
  );

  await expect(f.send(undefined, "sending-session", true)).rejects.toThrow(
    "FENCED_DELIVERY_ID_REQUIRED",
  );
  expect(
    await f.t.run(({ db }) => db.query("pending_messages").collect()),
  ).toHaveLength(before.length);
  expect(await turn.next()).toMatchObject({ status: "empty" });
});

test("a boot that does not opt in preserves legacy start and delivery", async () => {
  const f = await launch(false);
  const state = await f.inspect();
  expect(state.conversation?.execution_protocol_state).toBeUndefined();
  expect(state.head).toBeNull();
  expect(state.commands).toMatchObject([
    { command: "start_session", target_device_id: machine },
  ]);
  const sent = await f.send("legacy-agent");
  expect(await f.t.run(({ db }) => db.get(sent.message_id!))).toMatchObject({
    status: "pending",
  });
  expect(
    await f.t.run(({ db }) => db.get(sent.message_id!)),
  ).not.toHaveProperty("delivery_protocol_version");
});

test("a pending takeover refuses agent steers on admission and claim even after the previous lease expires", async () => {
  const f = await launch();
  const turn = await openTurn(f);
  await f.signedIn.mutation(api.executionBindings.setAgentSteerGrant, {
    conversation_id: f.conversation,
    sender_conversation_id: f.sender,
  });

  const beforeTakeover = await f.send("agent-before-takeover");
  const claimed = await turn.next();
  expect(claimed).toMatchObject({
    status: "permit",
    intent: "steer",
    delivery_id: "agent-before-takeover",
  });
  const queuedBeforeTakeover = await f.send("agent-pending-before-takeover");
  expect(
    await f.t.run(({ db }) => db.get(queuedBeforeTakeover.message_id!)),
  ).toMatchObject({
    delivery_intent: "steer",
  });

  await f.t.run(({ db }) =>
    db.insert("claims", {
      conversation_id: f.conversation,
      kind: "steer",
      holder: f.outsider,
      token: 1,
      lease_until: Date.now() - 1,
      takeover: {
        id: "takeover-fence",
        run: 1,
        turn: "open-turn",
        start_event_seq: 1,
        baton_token: 1,
        new_baton_token: 2,
        owner: f.owner,
        previous_holder: f.outsider,
        state: "pending",
      },
    }),
  );

  const duringTakeover = await f.send("agent-during-takeover");
  expect(
    await f.t.run(({ db }) => db.get(duringTakeover.message_id!)),
  ).toMatchObject({
    delivery_intent: "queue",
    delivery_status: "pending",
  });

  await expect(turn.start(claimed)).resolves.toMatchObject({
    status: "rejected",
    reason: "stale-baton",
  });
  expect(
    await f.t.run(({ db }) => db.get(beforeTakeover.message_id!)),
  ).toMatchObject({
    delivery_status: "rejected",
  });

  expect(await turn.next()).toMatchObject({ status: "empty" });
  expect(
    await f.t.run(({ db }) => db.get(queuedBeforeTakeover.message_id!)),
  ).toMatchObject({
    delivery_status: "rejected",
  });
});
