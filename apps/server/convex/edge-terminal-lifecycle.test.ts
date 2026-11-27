import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import {
  parseClaimResponse,
  parseEventsAppendResponse,
  type CanonicalEvent,
} from "@codecast/edge-contract";
import {
  boot,
  machine,
  setupRunLease,
  start,
} from "../test-helpers/run-lease.testkit";
import { purgeAccountPass } from "./accountDelete";

const edgeFlag = "CODECAST_EDGE_DELIVERY_V1";
const terminalFlag = "CODECAST_EDGE_TERMINAL_EVENTS";
const previous = Object.fromEntries(
  [edgeFlag, terminalFlag].map((key) => [key, process.env[key]]),
);
beforeEach(() => {
  process.env[edgeFlag] = "1";
  process.env[terminalFlag] = "1";
  jest.useFakeTimers();
  jest.setSystemTime(start);
});
afterEach(() => {
  for (const [key, value] of Object.entries(previous))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  jest.useRealTimers();
});

async function setup() {
  const f = await setupRunLease();
  const post = async (operation: string, body: object) => {
    const result = await f.t.fetch(`/edge/v1/${operation}`, {
      method: "POST",
      headers: { authorization: `Bearer ${f.bearer}` },
      body: JSON.stringify(body),
    });
    expect(result.status).toBe(200);
    return result.json();
  };
  const grant = async () => {
    const parsed = parseClaimResponse(
      await post("claim", {
        v: 1,
        session: f.conversation,
        machine,
        boot,
        claim_id: "terminal-events",
      }),
    );
    if (!parsed.ok || parsed.value.status !== "granted")
      throw new Error("Expected a run claim");
    return parsed.value;
  };
  const lease = await grant();
  const append = async (
    events: CanonicalEvent[],
    token = lease.fencing_token,
  ) => {
    const parsed = parseEventsAppendResponse(
      await post("events.append", {
        v: 1,
        batches: [
          {
            session: lease.session,
            run: lease.run,
            fencing_token: token,
            events,
          },
        ],
      }),
    );
    if (!parsed.ok) throw parsed.error;
    return parsed.value.results[0];
  };
  const stamp = {
    v: 1,
    session: lease.session,
    run: lease.run,
    at: start,
    turn: null,
    source: "observed",
  } as const;
  const started = {
    ...stamp,
    seq: 1,
    kind: "terminal.started",
    body: { pane_instance: 7, actor: { kind: "person", id: f.owner } },
  } as const;
  const ended = {
    ...stamp,
    seq: 2,
    kind: "terminal.ended",
    body: {
      pane_instance: 7,
      started_run: lease.run,
      outcome: { kind: "lost" },
    },
  } as const;
  const rows = () =>
    f.t.run(({ db }) => db.query("run_terminal_panes").collect());
  return { ...f, append, grant, lease, stamp, started, ended, rows };
}

test("a live claim retains terminal event bodies and fences replay by pane instance", async () => {
  const f = await setup();
  expect(f.lease.terminal_lifecycle).toBe(true);
  expect(await f.append([f.started, f.ended], "stale")).toMatchObject({
    status: "stale",
  });
  expect(await f.rows()).toEqual([]);
  expect(await f.append([f.started, f.ended])).toMatchObject({
    status: "appended",
    through_seq: 2,
  });
  expect(await f.append([f.started, f.ended])).toMatchObject({
    through_seq: 2,
  });
  expect(
    await f.append([
      {
        ...f.ended,
        seq: 3,
        body: { ...f.ended.body, outcome: { kind: "replaced" } },
      },
    ]),
  ).toMatchObject({ through_seq: 3 });
  expect(
    await f.append([
      {
        ...f.started,
        seq: 4,
        body: { ...f.started.body, tool_call_id: "different" },
      },
    ]),
  ).toMatchObject({ status: "conflict", seq: 4 });
  expect(await f.rows()).toMatchObject([
    {
      conversation_id: f.conversation,
      run: f.lease.run,
      pane_instance: 7,
      started: { actor: f.started.body.actor, seq: 1 },
      ended: { outcome: { kind: "lost" }, run: f.lease.run, seq: 2 },
    },
  ]);
  expect(await f.grant()).toMatchObject({
    last_pane_instance: 7,
    last_event_seq: 3,
  });
  await f.t.run(async (ctx) => {
    while (await purgeAccountPass(ctx, f.owner));
  });
  expect(await f.rows()).toEqual([]);
});

test("the default-off grant leaves an old daemon's cursor and turn events working", async () => {
  delete process.env[terminalFlag];
  const f = await setup();
  expect(f.lease.terminal_lifecycle).toBeUndefined();
  expect(
    await f.append([
      {
        ...f.stamp,
        seq: 1,
        turn: "turn",
        kind: "turn.started",
        body: {},
      },
    ]),
  ).toMatchObject({ status: "appended", through_seq: 1 });
  expect(await f.rows()).toEqual([]);
  expect(await f.grant()).toMatchObject({
    last_pane_instance: 0,
    last_event_seq: 1,
  });
});
