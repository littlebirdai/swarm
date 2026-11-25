import { TURN_PROJECTION_VERSION } from "@codecast/session-contract/turn-projection";
import { purgeAccountPass } from "./accountDelete";
import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import {
  parseClaimResponse,
  parseEventsAppendResponse,
  type CanonicalEvent,
} from "@codecast/edge-contract";
import { asUser } from "../test-helpers/database.testkit";
import {
  boot,
  leaseMs,
  machine,
  setupRunLease,
  start,
} from "../test-helpers/run-lease.testkit";
import { api, internal } from "./_generated/api";
import {
  claimExecutionStartInDb,
  completeDeliveryInDb,
  initializeFencedExecutionInDb,
  EXECUTION_PROTOCOL_CAPABILITIES,
  registerExecutionDaemonBootInDb,
  startDeliveryInDb,
} from "./executionBindings";
import { teamDeletionSteps } from "./lib/deletionPlans";
import { purgeRow } from "./lib/purgeTree";
import { seedEventRun } from "./lib/edge/runEvents";
import { isFreshTurnProjection } from "./lib/edge/runLease";

const flag = "CODECAST_EDGE_DELIVERY_V1";
const previous = process.env[flag];

beforeEach(() => {
  process.env[flag] = "1";
  setSystemTime(new Date(start));
});
afterEach(() => {
  if (previous === undefined) delete process.env[flag];
  else process.env[flag] = previous;
  setSystemTime();
});

type Payload<K extends CanonicalEvent["kind"] = CanonicalEvent["kind"]> =
  K extends CanonicalEvent["kind"]
    ? Pick<Extract<CanonicalEvent, { kind: K }>, "kind" | "body">
    : never;

async function fixture() {
  const setup = await setupRunLease();
  const post = (verb: string, body: unknown, bearer = setup.bearer) =>
    setup.t.fetch(`/edge/v1/${verb}`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body),
    });
  const grant = async (claim_id = "events", claimBoot = boot) => {
    const response = await post("claim", {
      v: 1,
      session: setup.conversation,
      machine,
      boot: claimBoot,
      claim_id,
    });
    const parsed = parseClaimResponse(await response.json());
    if (!parsed.ok || parsed.value.status !== "granted")
      throw new Error(JSON.stringify(parsed));
    return parsed.value;
  };
  const event = (
    seq: number,
    payload: Payload,
    turn: string | null = "turn",
  ): CanonicalEvent => ({
    v: 1,
    session: setup.conversation,
    run: 1,
    turn,
    source: "provider",
    at: start,
    seq,
    ...payload,
  });
  const batch = (fencing_token: string, events: CanonicalEvent[]) => ({
    session: events[0]?.session ?? setup.conversation,
    run: events[0]?.run ?? 1,
    fencing_token,
    events,
  });
  const append = async (...batches: ReturnType<typeof batch>[]) => {
    const response = await post("events.append", { v: 1, batches });
    expect(response.status).toBe(200);
    const parsed = parseEventsAppendResponse(await response.json());
    if (!parsed.ok) throw new Error(JSON.stringify(parsed));
    return parsed.value.results;
  };
  const rows = () =>
    setup.t.run(async ({ db }) => ({
      cursor: await db.query("run_event_cursors").unique(),
      turn: await db.query("run_turn_projections").unique(),
      binding: await db.get(setup.binding),
      lease: await db.query("run_leases").first(),
    }));
  return { ...setup, post, grant, event, batch, append, rows };
}

test("HTTP batches close gaps, skip duplicated content and preserve request order", async () => {
  const f = await fixture();
  const { fencing_token, last_event_seq } = await f.grant();
  expect(last_event_seq).toBe(0);
  const initial = await f.rows();
  const turn = f.event(1, { kind: "turn.started", body: {} });
  const prompt = f.event(2, {
    kind: "prompt.opened",
    body: { prompt_id: "ask", kind: "permission" },
  });
  expect(await f.append(f.batch(fencing_token, [prompt]))).toEqual([
    { session: f.conversation, status: "gap", expected_seq: 1 },
  ]);
  expect(await f.rows()).toEqual(initial);

  const bogus = f.event(
    1,
    { kind: "session.ended", body: { reason: "different replay" } },
    null,
  );
  const otherRun = { ...turn, run: 2 };
  expect(
    await f.append(
      f.batch(fencing_token, [turn]),
      f.batch(fencing_token, [otherRun]),
      f.batch(fencing_token, [bogus, prompt]),
    ),
  ).toEqual([
    { session: f.conversation, status: "appended", through_seq: 1 },
    { session: f.conversation, status: "stale" },
    { session: f.conversation, status: "appended", through_seq: 2 },
  ]);
  const accepted = await f.rows();
  expect(accepted.turn).toMatchObject({
    status: "active",
    open_turn: { id: "turn", prompt_ids: ["ask"] },
  });
  expect(await f.append(f.batch(fencing_token, [bogus]))).toEqual([
    { session: f.conversation, status: "appended", through_seq: 2 },
  ]);
  expect(await f.rows()).toEqual(accepted);
  expect((await f.grant()).last_event_seq).toBe(2);
});

test("HTTP transcript facts advance only the cursor and retain prompt state", async () => {
  const f = await fixture();
  const { fencing_token } = await f.grant();
  await f.append(
    f.batch(fencing_token, [
      f.event(1, { kind: "turn.started", body: {} }),
      f.event(2, {
        kind: "prompt.opened",
        body: { prompt_id: "ask", kind: "permission" },
      }),
      f.event(3, {
        kind: "prompt.opened",
        body: { prompt_id: "also", kind: "permission" },
      }),
    ]),
  );
  const before = await f.rows();
  setSystemTime(new Date(start + 1));
  await f.append(
    f.batch(fencing_token, [
      f.event(4, {
        kind: "message.assistant",
        body: { message_id: "reply", text: "ignored" },
      }),
      f.event(5, { kind: "context", body: { data: { $vendor: true } } }),
    ]),
  );
  const after = await f.rows();
  expect(after.cursor).toEqual({ ...before.cursor!, last_event_seq: 5 });
  expect(after.turn).toEqual(before.turn);
  expect(await f.t.run(({ db }) => db.query("messages").collect())).toEqual([]);
  if (!after.binding) throw Error("Expected the ready binding");
  expect(
    isFreshTurnProjection(after.binding, after.lease, after.turn, start + 1),
  ).toBe(true);
  expect(
    isFreshTurnProjection(
      after.binding,
      after.lease,
      after.turn,
      start + leaseMs,
    ),
  ).toBe(false);
  expect(
    isFreshTurnProjection(
      { ...after.binding, epoch: 2 },
      after.lease,
      after.turn,
      start + 1,
    ),
  ).toBe(false);
  expect(
    isFreshTurnProjection(
      { ...after.binding, state: "stopped" },
      after.lease,
      after.turn,
      start + 1,
    ),
  ).toBe(false);
  if (!after.turn) throw Error("Expected the turn projection");
  expect(
    isFreshTurnProjection(
      after.binding,
      after.lease,
      { ...after.turn, status: "completed" },
      start + 1,
    ),
  ).toBe(false);
  if (!after.lease) throw Error("Expected the lease");
  for (const lease of [
    { ...after.lease, claim_id: "old-claim" },
    { ...after.lease, released_at: start + 1 },
    { ...after.lease, boot: "old-boot" },
  ])
    expect(
      isFreshTurnProjection(after.binding, lease, after.turn, start + 1),
    ).toBe(false);
});

test("HTTP checks owner, device, boot, token and expiry before acknowledging a replay", async () => {
  const f = await fixture();
  const { fencing_token } = await f.grant();
  const turn = f.event(1, { kind: "turn.started", body: {} });
  await f.append(f.batch(fencing_token, [turn]));
  const valid = { v: 1, batches: [f.batch(fencing_token, [turn])] };
  const stale = {
    v: 1,
    results: [{ session: f.conversation, status: "stale" }],
  };
  for (const bearer of [f.wrongDevice, f.wrongUser])
    expect(await (await f.post("events.append", valid, bearer)).json()).toEqual(
      stale,
    );
  expect((await f.post("events.append", valid, "wrong-token")).status).toBe(
    401,
  );
  expect(await f.append(f.batch("wrong-fence", [turn]))).toEqual(stale.results);
  await f.t.run(({ db }) =>
    db.patch(f.binding, { daemon_boot_id: "new-boot" }),
  );
  expect(await (await f.post("events.append", valid)).json()).toEqual(stale);
  await f.t.run(({ db }) => db.patch(f.binding, { daemon_boot_id: boot }));
  setSystemTime(new Date(start + leaseMs));
  expect(await (await f.post("events.append", valid)).json()).toEqual(stale);
  const replacement = await f.grant("replacement");
  expect(replacement.last_event_seq).toBe(1);
  expect((await f.rows()).turn?.open_turn).toBeNull();
  expect(await (await f.post("events.append", valid)).json()).toEqual(stale);
  await f.append(f.batch(replacement.fencing_token, [{ ...turn, seq: 2 }]));
  expect((await f.rows()).turn?.open_turn?.id).toBe("turn");
});

test("HTTP uses its own body, event, UTF-16 and per-batch limits", async () => {
  const f = await fixture();
  const { fencing_token } = await f.grant();
  const startTurn = f.event(1, { kind: "turn.started", body: {} });
  const request = { v: 1, batches: [f.batch(fencing_token, [startTurn])] };
  delete process.env[flag];
  expect((await f.post("events.append", request)).status).toBe(404);
  process.env[flag] = "1";
  expect((await f.post("events.append", { ...request, boot })).status).toBe(
    400,
  );
  const huge = f.event(1, {
    kind: "message.assistant",
    body: { message_id: "big", text: "a".repeat(512 * 1024) },
  });
  expect(
    (
      await f.post("events.append", {
        v: 1,
        batches: [f.batch(fencing_token, [huge])],
      })
    ).status,
  ).toBe(413);
  const events = Array.from({ length: 101 }, (_, i) => ({
    ...startTurn,
    seq: i + 1,
  }));
  expect(
    (
      await f.post("events.append", {
        v: 1,
        batches: [f.batch(fencing_token, events)],
      })
    ).status,
  ).toBe(413);
  const oversized = { ...startTurn, turn: "🔵".repeat(129) };
  expect(
    (
      await f.post("events.append", {
        v: 1,
        batches: [f.batch(fencing_token, [oversized])],
      })
    ).status,
  ).toBe(413);
  const oversizedPrompt = f.event(1, {
    kind: "prompt.opened",
    body: { prompt_id: "🔵".repeat(129), kind: "permission" },
  });
  expect(
    (
      await f.post("events.append", {
        v: 1,
        batches: [f.batch(fencing_token, [oversizedPrompt])],
      })
    ).status,
  ).toBe(413);
  const gap = f.batch(fencing_token, [{ ...startTurn, seq: 2 }]);
  expect(await f.append(gap, gap)).toMatchObject([
    { status: "gap" },
    { status: "gap" },
  ]);
  await f.t.run(async ({ db }) => {
    const budget = await db
      .query("ip_rate_limits")
      .withIndex("by_key", (q) =>
        q.eq("key", `edge/v1/events:${f.owner}:${machine}`),
      )
      .unique();
    expect(budget?.count).toBe(2);
    if (!budget) throw Error("Expected an event budget");
    await db.patch(budget._id, { count: 239 });
  });
  const blocked = await f.post("events.append", {
    ...request,
    batches: [...request.batches, ...request.batches],
  });
  expect(blocked.status).toBe(429);
  expect(blocked.headers.get("Retry-After")).toBe("60");
  expect((await f.rows()).cursor?.last_event_seq).toBe(0);

  expect(
    await f.t.run(
      async ({ db }) =>
        (
          await db
            .query("ip_rate_limits")
            .withIndex("by_key", (q) =>
              q.eq("key", `edge/v1/events:${f.owner}:${machine}`),
            )
            .unique()
        )?.count,
    ),
  ).toBe(239);
  const allowed = await f.post("events.append", request);
  expect(allowed.status).toBe(200);
  expect((await f.rows()).cursor?.last_event_seq).toBe(1);
  expect((await f.grant()).last_event_seq).toBe(1);
});

test("session deletion fences HTTP retries before the cursor and turn rows are purged", async () => {
  const f = await fixture();
  const { fencing_token } = await f.grant();
  const request = f.batch(fencing_token, [
    f.event(1, { kind: "turn.started", body: {} }),
  ]);
  await f.append(request);
  await asUser(f.t, f.owner).mutation(api.sessionDelete.deleteSession, {
    conversation_id: f.conversation,
  });
  expect(await f.append(request)).toEqual([
    { session: f.conversation, status: "stale" },
  ]);
  await f.t.mutation(internal.sessionDelete.purgeConversationRows, {
    conversation_id: f.conversation,
  });
  expect(await f.rows()).toEqual({
    binding: null,
    lease: null,
    cursor: null,
    turn: null,
  });
  expect(await f.append(request)).toEqual([
    { session: f.conversation, status: "stale" },
  ]);
});

test.each(["on", "off"] as const)(
  "a boot transfer clears the HTTP turn with the flag %s",
  async (flagState) => {
    const f = await fixture();
    const { fencing_token } = await f.grant();
    const first = f.batch(fencing_token, [
      f.event(1, { kind: "turn.started", body: {} }),
    ]);
    await f.append(first);
    if (flagState === "off") delete process.env[flag];
    await f.t.run(async (ctx) => {
      await registerExecutionDaemonBootInDb(ctx, f.owner, {
        ownerDeviceId: machine,
        daemonBootId: "next-boot",
        now: start + 1,
      });
      const claimed = await claimExecutionStartInDb(ctx, f.owner, {
        conversationId: f.conversation,
        epoch: 1,
        configurationRevision: 1,
        ownerDeviceId: machine,
        daemonBootId: "next-boot",
        protocolVersion: 1,
        requiredCapabilities: [...EXECUTION_PROTOCOL_CAPABILITIES],
        proposedOperationId: "operation",
        now: start + 1,
      });
      expect(claimed.state).toBe("ready");
    });
    expect((await f.rows()).turn?.open_turn).toBeNull();
    process.env[flag] = "1";
    expect(await f.append(first)).toEqual([
      { session: f.conversation, status: "stale" },
    ]);
    const next = await f.grant("next-lease", "next-boot");
    expect(next.last_event_seq).toBe(1);
    expect(
      await f.append(
        f.batch(next.fencing_token, [
          f.event(2, { kind: "turn.started", body: {} }),
        ]),
      ),
    ).toEqual([
      { session: f.conversation, status: "appended", through_seq: 2 },
    ]);
    expect((await f.rows()).turn?.open_turn?.id).toBe("turn");
  },
);

test("the first team purge page fences HTTP uploads while the conversation remains", async () => {
  const f = await fixture();
  const { fencing_token } = await f.grant();
  const batch = f.batch(fencing_token, [
    f.event(1, { kind: "turn.started", body: {} }),
  ]);
  await f.append(batch);
  const plan = teamDeletionSteps().find(
    ({ table }) => table === "conversations",
  );
  if (!plan) throw Error("Missing team conversation purge plan");
  const progress = await f.t.run(async (ctx) =>
    purgeRow(ctx, plan, await ctx.db.get(f.conversation), { left: 1 }, {}),
  );
  expect(progress).toBe("more");
  expect((await f.rows()).cursor?.last_event_seq).toBe(1);
  expect(await f.append(batch)).toEqual([
    { session: f.conversation, status: "stale" },
  ]);
});

test.each(["move", "reparent", "ownership claim"] as const)(
  "%s fences new work while preserving the started settlement",
  async (kind) => {
    const f = await fixture();
    const { fencing_token } = await f.grant();
    const fence = { v: 1, session: f.conversation, run: 1, fencing_token };
    const next = await f.post("permits.next", fence);
    const {
      status,
      state: _state,
      input: _input,
      ...permit
    } = await next.json();
    expect(status).toBe("permit");
    expect(await (await f.post("delivery.start", permit)).json()).toMatchObject(
      { status: "started" },
    );

    const destination = "destination";
    await f.t.run(({ db }) =>
      db.insert("devices", {
        user_id: f.owner,
        device_id: destination,
        label: "Destination",
        platform: "linux",
        last_seen: start,
      }),
    );
    const owner = asUser(f.t, f.owner);
    if (kind === "move")
      await owner.mutation(api.devices.moveSessionToDevice, {
        conversation_id: f.conversation,
        owner_device_id: destination,
        project_path: "/fixture",
        resume: false,
      });
    else if (kind === "reparent")
      await owner.mutation(api.devices.reparentSessionToDevice, {
        session_id: f.conversation,
        device_id: destination,
        remote_url: "https://example.com/repo.git",
      });
    else
      expect(
        await owner.mutation(api.devices.claimConversationForStart, {
          conversation_id: f.conversation,
          device_id: destination,
        }),
      ).toMatchObject({ won: true });
    const moved = await f.t.run(async ({ db }) => ({
      conversation: await db.get(f.conversation),
      head: await db.get(f.head),
    }));
    expect(moved.conversation?.owner_device_id).toBe(destination);
    expect(moved.head?.current_epoch).toBe(1);

    for (const verb of ["renew", "permits.next"])
      expect(await (await f.post(verb, fence)).json()).toMatchObject({
        status: "stale",
      });
    expect(
      await (
        await f.post("claim", {
          v: 1,
          session: f.conversation,
          machine,
          boot,
          claim_id: "events",
        })
      ).json(),
    ).toMatchObject({ status: "stale" });
    expect(await (await f.post("delivery.start", permit)).json()).toMatchObject(
      { status: "rejected", reason: "stale" },
    );
    expect(
      await f.append(
        f.batch(fencing_token, [
          f.event(1, { kind: "turn.started", body: {} }),
        ]),
      ),
    ).toMatchObject([{ status: "stale" }]);
    expect(
      await (
        await f.post("delivery.settle", { ...permit, outcome: "applied" })
      ).json(),
    ).toMatchObject({ status: "recorded" });
    expect(
      await (
        await f.post("delivery.settle", { ...permit, outcome: "applied" })
      ).json(),
    ).toMatchObject({ status: "duplicate" });
    expect(await f.t.run(({ db }) => db.get(f.message))).toMatchObject({
      delivery_status: "delivered",
    });
    const wrong = { ...fence, fencing_token: "other-claim" };
    expect(await (await f.post("release", wrong)).json()).toMatchObject({
      status: "stale",
    });
    expect(await (await f.post("release", fence)).json()).toMatchObject({
      status: "released",
    });
    expect((await f.rows()).lease?.released_at).toBe(start);
  },
);

test("a device move cannot authorize settlement of an unstarted permit", async () => {
  const f = await fixture();
  const { fencing_token } = await f.grant();
  const {
    status,
    input: _input,
    state: _state,
    ...permit
  } = await (
    await f.post("permits.next", {
      v: 1,
      session: f.conversation,
      run: 1,
      fencing_token,
    })
  ).json();
  expect(status).toBe("permit");
  await asUser(f.t, f.owner).mutation(api.devices.claimConversation, {
    conversation_id: f.conversation,
    device_id: "destination",
  });
  expect(
    await (
      await f.post("delivery.settle", { ...permit, outcome: "rejected" })
    ).json(),
  ).toMatchObject({ status: "stale" });
  expect(await f.t.run(({ db }) => db.get(f.message))).toMatchObject({
    delivery_status: "claimed",
  });
});

test("a version mismatch stays stale across appends and clears on a boot reset", async () => {
  const f = await fixture();
  const { fencing_token } = await f.grant();
  const initial = await f.rows();
  if (!initial.turn || !initial.binding)
    throw Error("Expected a ready event run");
  const older = TURN_PROJECTION_VERSION - 1;
  const rowId = initial.turn._id;
  await f.t.run(({ db }) => db.patch(rowId, { projection_version: older }));
  expect(
    await f.append(
      f.batch(fencing_token, [f.event(1, { kind: "turn.started", body: {} })]),
    ),
  ).toMatchObject([{ status: "appended", through_seq: 1 }]);
  const appended = await f.rows();
  expect(appended.turn).toEqual({ ...initial.turn, projection_version: older });
  expect(
    isFreshTurnProjection(
      initial.binding,
      appended.lease,
      appended.turn,
      start,
    ),
  ).toBe(false);

  await f.t.run(async (ctx) => {
    await registerExecutionDaemonBootInDb(ctx, f.owner, {
      ownerDeviceId: machine,
      daemonBootId: "next-boot",
      now: start + 1,
    });
    expect(
      await claimExecutionStartInDb(ctx, f.owner, {
        conversationId: f.conversation,
        epoch: 1,
        configurationRevision: 1,
        ownerDeviceId: machine,
        daemonBootId: "next-boot",
        protocolVersion: 1,
        requiredCapabilities: [...EXECUTION_PROTOCOL_CAPABILITIES],
        proposedOperationId: "operation",
        now: start + 1,
      }),
    ).toMatchObject({ state: "ready" });
  });
  const next = await f.grant("next-lease", "next-boot");
  expect(next.last_event_seq).toBe(1);
  expect((await f.rows()).turn).toMatchObject({
    projection_version: TURN_PROJECTION_VERSION,
    open_turn: null,
    received_at: start + 1,
  });
});

test("account deletion purges orphan cursor and turn rows", async () => {
  const f = await fixture();
  await f.grant();
  await f.t.run(async (ctx) => {
    await ctx.db.delete(f.conversation);
    while (await purgeAccountPass(ctx, f.owner));
  });
  const rows = await f.rows();
  expect(rows.cursor).toBeNull();
  expect(rows.turn).toBeNull();
});

test("the first claim after flag enablement seeds an existing run", async () => {
  const f = await fixture();
  delete process.env[flag];
  await f.t.run(async (ctx) => {
    const old = await ctx.db.get(f.binding);
    if (!old) throw Error("Expected the binding fixture");
    await ctx.db.delete(f.message);
    await ctx.db.delete(f.head);
    await ctx.db.delete(f.binding);
    await ctx.db.patch(f.conversation, { execution_protocol_state: undefined });
    await initializeFencedExecutionInDb(ctx, f.owner, {
      conversationId: f.conversation,
      target: {
        requestedAgent: "codex",
        transport: "app-server",
        projectPath: "/fixture",
        configurationRevision: 1,
        ownerDeviceId: machine,
        daemonBootId: boot,
        requiredCapabilities: [...EXECUTION_PROTOCOL_CAPABILITIES],
        protocolVersion: 1,
      },
      now: start - 10,
    });
    const binding = await ctx.db.query("execution_bindings").unique();
    if (!binding) throw Error("Expected the activation binding");
    await ctx.db.patch(binding._id, {
      state: "ready",
      runtime_id: "runtime",
      actual_agent: "codex",
      applied_configuration_revision: 1,
    });
  });
  expect((await f.rows()).cursor).toBeNull();
  expect((await f.rows()).turn).toBeNull();
  process.env[flag] = "1";
  const granted = await f.grant();
  expect(granted.last_event_seq).toBe(0);
  expect(
    await f.append(
      f.batch(granted.fencing_token, [
        f.event(1, { kind: "turn.started", body: {} }),
      ]),
    ),
  ).toMatchObject([{ status: "appended", through_seq: 1 }]);
});

test("Convex records a started outcome after a same-account device move", async () => {
  const f = await fixture();
  const { fencing_token } = await f.grant();
  const { permit } = await f.deliver(fencing_token);
  const fence = {
    ...permit,
    conversationId: f.conversation,
    conversationSequence: Number(permit.conversationSequence),
    fencingToken: fencing_token,
    now: start,
  };
  await f.t.run((ctx) => startDeliveryInDb(ctx, f.owner, fence));
  await asUser(f.t, f.owner).mutation(api.devices.claimConversation, {
    conversation_id: f.conversation,
    device_id: "destination",
  });
  expect(
    await f.t.run((ctx) => completeDeliveryInDb(ctx, f.owner, fence)),
  ).toEqual({ accepted: true });
  expect(await f.t.run(({ db }) => db.get(f.message))).toMatchObject({
    delivery_status: "delivered",
  });
});

test("flag-off epochs preserve the last cursor when a later run first claims", async () => {
  const f = await fixture();
  const { fencing_token } = await f.grant();
  await f.append(
    f.batch(fencing_token, [f.event(1, { kind: "turn.started", body: {} })]),
  );
  delete process.env[flag];
  await f.t.run(async (ctx) => {
    const { db } = ctx;
    const old = await db.get(f.binding);
    const conversation = await db.get(f.conversation);
    if (!old || !conversation) throw Error("Expected an active run");
    const { _id, _creationTime, claim_id, ...fields } = old;
    for (const epoch of [2, 3]) {
      const binding = await db.insert("execution_bindings", {
        ...fields,
        epoch,
      });
      await seedEventRun(ctx, binding, conversation, epoch, start);
      await db.patch(f.head, { current_epoch: epoch });
    }
    expect(await db.query("run_event_cursors").collect()).toHaveLength(1);
    expect(await db.query("run_turn_projections").collect()).toHaveLength(1);
  });
  process.env[flag] = "1";
  const claimed = await f.grant("resumed");
  expect(claimed).toMatchObject({ run: 3, last_event_seq: 1 });
  expect(
    await f.append(
      f.batch(claimed.fencing_token, [
        { ...f.event(2, { kind: "turn.started", body: {} }), run: 3 },
      ]),
    ),
  ).toMatchObject([{ status: "appended", through_seq: 2 }]);
});
