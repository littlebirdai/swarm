import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  EdgeClient,
  EdgeOperation,
  EdgeRequests,
  EdgeSteerOutcome,
  EdgeSteerPermit,
  EdgeSteerRecovery,
  EdgeTransport,
} from "@codecast/edge-client";
import type {
  PermitsNextRequest,
  PermitsNextResponse,
  TakeoverFence,
} from "@codecast/edge-contract";
import hello from "../../../../packages/edge-contract/test/fixtures/hello.json";
import { createDaemonEdgeClient } from "./daemon-edge-client.js";

const enabled = { SWARM_TURN_BATON: "1", CODECAST_EDGE_DELIVERY_V1: "1" };
const run = {
  v: 1,
  session: "session",
  run: 1,
  fencing_token: "lease",
} satisfies PermitsNextRequest;
const attempt = {
  ...run,
  delivery_id: "delivery",
  attempt_id: "attempt",
  seq: 2,
  sender: { kind: "person", id: "ana" },
} as const;
const steer = {
  ...attempt,
  status: "permit",
  state: "new",
  intent: "steer",
  input: [{ type: "text", text: "hello" }],
  expected: { kind: "turn", turn: "open-turn" },
  baton_token: 1,
} satisfies EdgeSteerPermit;
const fence = {
  ...run,
  status: "takeover_fence",
  turn: "open-turn",
  fence_id: "fence",
  baton_token: 1,
  new_baton_token: 2,
} satisfies TakeoverFence;
const recorded = { v: 1, status: "recorded" } as const;

function fakeEdge(permit: PermitsNextResponse) {
  const calls: {
    operation: EdgeOperation;
    request: EdgeRequests[EdgeOperation];
  }[] = [];
  let next = permit;
  const transport: EdgeTransport = async (operation, request) => {
    calls.push({ operation, request: structuredClone(request) });
    switch (operation) {
      case "hello":
        return { status: 200, body: hello.response };
      case "permits.next":
        return { status: 200, body: next };
      case "delivery.start":
        return {
          status: 200,
          body: {
            ...request,
            status: "started",
            input: [{ type: "text", text: "server input" }],
          },
        };
      case "delivery.settle":
      case "takeover.ack":
        return { status: 200, body: recorded };
      default:
        throw new Error(`Unexpected edge operation ${operation}`);
    }
  };
  return {
    transport,
    calls,
    offer: (value: PermitsNextResponse) => {
      next = value;
    },
  };
}

type Agent = NonNullable<Parameters<typeof createDaemonEdgeClient>[0]["agent"]>;

function fakeAgent(
  turn = "open-turn",
  outcome: EdgeSteerOutcome = { outcome: "applied" },
) {
  const steers: Parameters<Agent["steer"]>[0][] = [];
  const recoveries: Parameters<Agent["recover"]>[0][] = [];
  let recovery: EdgeSteerRecovery = { outcome: "in_doubt" };
  const agent: Agent = {
    runningTurn: () => turn,
    async prepareInput(permit) {
      return permit.input.map((part) => {
        if (part.type !== "text") throw new Error("Expected text");
        return part;
      });
    },
    async steer(request) {
      steers.push(structuredClone(request));
      return outcome;
    },
    async recover(handover) {
      recoveries.push(structuredClone(handover));
      return recovery;
    },
  };
  return {
    agent,
    steers,
    recoveries,
    confirm: (evidence: string) => {
      recovery = { outcome: "applied", resolution_evidence: evidence };
    },
  };
}

let journalDirectory: string;
let clients: EdgeClient[];
beforeEach(async () => {
  journalDirectory = await mkdtemp(join(tmpdir(), "daemon-steer-journal-"));
  clients = [];
});
afterEach(async () => {
  await Promise.all(clients.map((client) => client.close()));
  await rm(journalDirectory, { recursive: true, force: true });
});

async function connect(
  edge: ReturnType<typeof fakeEdge>,
  agent: Agent,
  env: Parameters<typeof createDaemonEdgeClient>[1] = enabled,
) {
  const client = createDaemonEdgeClient(
    { transport: edge.transport, journalDirectory, agent },
    env,
  );
  clients.push(client);
  expect(
    await client.hello({
      ...hello.request,
      capabilities: ["delivery-permit-v1"],
    }),
  ).toMatchObject({ ok: true });
  return client;
}

test.each([{}, { CODECAST_EDGE_DELIVERY_V1: "1" }, { SWARM_TURN_BATON: "1" }])(
  "offers the queue capability alone unless both flags are on (%j)",
  async (env) => {
    const queue = {
      ...attempt,
      status: "permit",
      state: "new",
      intent: "queue",
      input: steer.input,
    } as const;
    const edge = fakeEdge({ ...queue, input: [...queue.input] });
    const machine = fakeAgent();
    const client = await connect(edge, machine.agent, env);
    expect(edge.calls[0]?.request).toMatchObject({
      capabilities: ["delivery-permit-v1"],
    });
    expect(await client.deliverNext(run)).toEqual({ ok: true, value: queue });
    expect(edge.calls.map(({ operation }) => operation)).toEqual([
      "hello",
      "permits.next",
    ]);
    expect(machine.steers).toEqual([]);
    expect(await readdir(journalDirectory)).toEqual([]);
  },
);

test("hands the confirmed input to the agent with the named open turn and lease", async () => {
  const edge = fakeEdge(steer);
  const machine = fakeAgent();
  const client = await connect(edge, machine.agent);
  expect(edge.calls[0]?.request).toMatchObject({
    capabilities: [
      "delivery-permit-v1",
      "expected",
      "steer-baton-v1",
      "takeover-fence-v1",
    ],
  });
  expect(await client.deliverNext(run)).toEqual({
    ok: true,
    value: { status: "settled", outcome: "applied", receipt: recorded },
  });
  expect(machine.steers).toEqual([
    {
      session: "session",
      expected: { run: 1, fencing_token: "lease", turn: "open-turn" },
      delivery_id: "delivery",
      authors: [{ kind: "person", id: "ana" }],
      input: [{ type: "text", text: "server input" }],
    },
  ]);
});

test("settles a stale steer without handing it to the agent", async () => {
  const edge = fakeEdge(steer);
  const machine = fakeAgent("other-turn");
  const client = await connect(edge, machine.agent);
  expect(await client.deliverNext(run)).toEqual({
    ok: true,
    value: { status: "settled", outcome: "stale", receipt: recorded },
  });
  expect(edge.calls.map(({ operation }) => operation)).toEqual([
    "hello",
    "permits.next",
    "delivery.settle",
  ]);
  expect(edge.calls.at(-1)?.request).toEqual({
    ...attempt,
    intent: "steer",
    outcome: "stale",
    observed: { kind: "turn", turn: "other-turn" },
  });
  expect(machine.steers).toEqual([]);
});

test("withholds takeover ack until the covered handover settles", async () => {
  const edge = fakeEdge(steer);
  const machine = fakeAgent("open-turn", { outcome: "in_doubt" });
  const client = await connect(edge, machine.agent);
  expect(await client.deliverNext(run)).toMatchObject({
    ok: true,
    value: { outcome: "in_doubt" },
  });
  edge.offer(fence);
  expect(await client.deliverNext(run)).toEqual({
    ok: true,
    value: { status: "pending" },
  });
  expect(edge.calls.some(({ operation }) => operation === "takeover.ack")).toBe(
    false,
  );

  machine.confirm("published receipt");
  const before = edge.calls.length;
  expect(await client.deliverNext(run)).toEqual({
    ok: true,
    value: { status: "takeover", receipt: recorded },
  });
  expect(edge.calls.slice(before).map(({ operation }) => operation)).toEqual([
    "permits.next",
    "delivery.settle",
    "takeover.ack",
  ]);
  expect(edge.calls.at(-2)?.request).toMatchObject({
    outcome: "applied",
    resolution_evidence: "published receipt",
  });
  expect(machine.steers).toHaveLength(1);
});

test("a restart before ack preserves the fence and recovers the open handover without resending", async () => {
  const before = fakeEdge(steer);
  const client = await connect(
    before,
    fakeAgent("open-turn", { outcome: "in_doubt" }).agent,
  );
  expect(await client.deliverNext(run)).toMatchObject({
    ok: true,
    value: { outcome: "in_doubt" },
  });
  before.offer(fence);
  expect(await client.deliverNext(run)).toEqual({
    ok: true,
    value: { status: "pending" },
  });
  await client.close();

  const resumed = { ...run, fencing_token: "resumed-lease" };
  const after = fakeEdge({
    ...steer,
    ...resumed,
    attempt_id: "another-attempt",
  });
  const machine = fakeAgent();
  const restarted = await connect(after, machine.agent);
  expect(await restarted.deliverNext(resumed)).toEqual({
    ok: true,
    value: { status: "fenced" },
  });
  expect(after.calls.map(({ operation }) => operation)).toEqual([
    "hello",
    "permits.next",
  ]);

  machine.confirm("recovered published receipt");
  after.offer({ ...fence, ...resumed });
  expect(await restarted.deliverNext(resumed)).toEqual({
    ok: true,
    value: { status: "takeover", receipt: recorded },
  });
  expect(machine.recoveries).toEqual([
    expect.objectContaining({
      fencing_token: "resumed-lease",
      delivery_id: "delivery",
      attempt_id: "attempt",
      expected: { kind: "turn", turn: "open-turn" },
      baton_token: 1,
    }),
  ]);
  expect(machine.steers).toEqual([]);
  expect(after.calls.slice(-2).map(({ operation }) => operation)).toEqual([
    "delivery.settle",
    "takeover.ack",
  ]);
  expect(after.calls.at(-1)?.request).toEqual({
    ...resumed,
    fence_id: "fence",
    turn: "open-turn",
    baton_token: 1,
  });
});

test("corrupt journal evidence prevents a takeover acknowledgement", async () => {
  const edge = fakeEdge(steer);
  const machine = fakeAgent("open-turn", { outcome: "in_doubt" });
  const client = await connect(edge, machine.agent);
  expect(await client.deliverNext(run)).toMatchObject({
    ok: true,
    value: { outcome: "in_doubt" },
  });
  const [file] = await readdir(journalDirectory);
  if (file === undefined) throw new Error("No steer journal exists");
  await writeFile(
    join(journalDirectory, file),
    '{"version":1,"fences":[],"handovers":[{}]}',
  );

  edge.offer(fence);
  expect(await client.deliverNext(run)).toMatchObject({
    ok: false,
    error: { code: "steer_journal_read_failed" },
  });
  expect(edge.calls.some(({ operation }) => operation === "takeover.ack")).toBe(
    false,
  );
  expect(machine.recoveries).toEqual([]);
});
