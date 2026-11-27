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
import { scheduledJobs } from "../test-helpers/database.testkit";
import { internal } from "./_generated/api";
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

test("retention caps each run without stopping the event cursor", async () => {
  const f = await setup();
  for (const offset of [0, 100]) {
    const events = Array.from({ length: 100 }, (_, i) => ({
      ...f.started,
      seq: offset + i + 1,
      body: { ...f.started.body, pane_instance: offset + i + 1 },
    }));
    expect(await f.append(events)).toMatchObject({
      status: "appended",
      through_seq: offset + 100,
    });
  }
  expect(
    (await f.rows()).map((pane) => pane.pane_instance).sort((a, b) => a - b),
  ).toEqual(Array.from({ length: 128 }, (_, i) => i + 73));
  expect(await f.grant()).toMatchObject({
    last_event_seq: 200,
    last_pane_instance: 200,
  });
});

test("the terminal pane prune expires receipts in bounded pages and preserves fresh panes", async () => {
  const f = await setup();
  expect(await f.append([f.started])).toMatchObject({ status: "appended" });
  const [pane] = await f.rows();
  const retainedFor = 7 * 24 * 60 * 60_000;
  expect(pane.retain_until).toBe(start + retainedFor);
  const { _id, _creationTime, ...fields } = pane;
  await f.t.run(async ({ db }) => {
    for (let i = 0; i < 501; i++)
      await db.insert("run_terminal_panes", {
        ...fields,
        run: i + 2,
        retain_until: start + retainedFor,
      });
    await db.insert("run_terminal_panes", {
      ...fields,
      run: 503,
      retain_until: start + retainedFor + 1,
    });
  });
  jest.setSystemTime(start + retainedFor - 1);
  expect(await f.t.mutation(internal.edgeRunLease.pruneTerminalPanes, {})).toBe(
    0,
  );
  jest.setSystemTime(start + retainedFor);
  expect(await f.t.mutation(internal.edgeRunLease.pruneTerminalPanes, {})).toBe(
    500,
  );
  expect(
    await scheduledJobs(f.t, internal.edgeRunLease.pruneTerminalPanes),
  ).toHaveLength(1);
  expect(await f.t.mutation(internal.edgeRunLease.pruneTerminalPanes, {})).toBe(
    2,
  );
  expect(await f.rows()).toMatchObject([{ run: 503 }]);
});

test("a terminal receipt replay followed by a provider event advances both once", async () => {
  const f = await setup();
  expect(await f.append([f.started])).toMatchObject({
    status: "appended",
    through_seq: 1,
  });
  expect(
    await f.append([
      f.started,
      {
        ...f.stamp,
        seq: 2,
        turn: "provider-turn",
        source: "provider",
        kind: "turn.started",
        body: {},
      },
    ]),
  ).toMatchObject({ status: "appended", through_seq: 2 });
  expect(await f.rows()).toMatchObject([
    { pane_instance: 7, started: { seq: 1 } },
  ]);
  expect(
    await f.t.run(({ db }) => db.query("run_turn_projections").unique()),
  ).toMatchObject({ open_turn: { id: "provider-turn" } });
});
