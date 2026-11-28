import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import {
  STEER_BATON_CAPABILITY,
  type CanonicalEvent,
} from "@codecast/edge-contract";
import {
  TURN_PROJECTION_VERSION,
  TURN_STARTER_PROJECTION_VERSION,
} from "@codecast/session-contract/turn-projection";
import { asUser } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { setupRunLease, start } from "../test-helpers/run-lease.testkit";
import { api, internal } from "./_generated/api";
import { EXECUTION_PROTOCOL_CAPABILITIES } from "./executionBindings";
import { isFreshTurnProjection } from "./lib/edge/runLease";

const batonFlag = "SWARM_TURN_BATON";
const originalBaton = process.env[batonFlag];

beforeEach(() => {
  process.env[batonFlag] = "1";
  setSystemTime(new Date(start));
});

afterEach(() => {
  if (originalBaton === undefined) delete process.env[batonFlag];
  else process.env[batonFlag] = originalBaton;
  setSystemTime();
});

type Started = Extract<CanonicalEvent, { kind: "turn.started" }>;
type Actor = NonNullable<Started["body"]["starter"]>;
type EventPayload =
  | Started
  | Extract<
      CanonicalEvent,
      { kind: "turn.ended" | "prompt.opened" | "prompt.settled" }
    >;
type Payload<T> = T extends CanonicalEvent ? Pick<T, "kind" | "body"> : never;

async function fixture({
  capable = true,
  senderKind = "person",
}: {
  capable?: boolean;
  senderKind?: Actor["kind"] | "scheduler" | "non-human";
} = {}) {
  const f = await setupRunLease();
  const agent = await f.t.run(async ({ db }) => {
    const rows = fixtureRows(db, "starter agent");
    const agent = await rows.conversation(f.owner);
    if (capable)
      await db.patch(f.binding, {
        capabilities: [
          ...EXECUTION_PROTOCOL_CAPABILITIES,
          STEER_BATON_CAPABILITY,
        ],
      });
    await db.patch(
      f.message,
      senderKind === "agent"
        ? { from_conversation_id: agent }
        : {
            human: senderKind !== "non-human",
            ...(senderKind === "scheduler" && { origin: "scheduler" }),
          },
    );
    return agent;
  });
  const granted = await f.claim("starter");
  if (granted.status !== "granted") throw Error("Expected run lease");
  const run = {
    v: 1 as const,
    bearer: f.bearer,
    session: f.conversation,
    run: granted.run,
    fencing_token: granted.fencing_token,
  };
  const reserve = async () => {
    const permit = await f.t.mutation(internal.edgeDelivery.next, run);
    if (permit.status !== "permit") throw Error(JSON.stringify(permit));
    const delivery = {
      ...run,
      attempt_id: permit.attempt_id,
      delivery_id: permit.delivery_id,
      seq: permit.seq,
      intent: permit.intent,
      sender: permit.sender,
    };
    return {
      begin: () => f.t.mutation(internal.edgeDelivery.start, delivery),
      settle: () =>
        f.t.mutation(internal.edgeDelivery.settle, {
          ...delivery,
          outcome: "applied",
        }),
    };
  };
  const append = async (...events: CanonicalEvent[]) => {
    const { bearer, v, ...batch } = run;
    const response = await f.t.fetch("/edge/v1/events.append", {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ v, batches: [{ ...batch, events }] }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      results: [{ status: "appended", through_seq: events.at(-1)?.seq }],
    });
  };
  const event = (
    seq: number,
    turn: string,
    payload: Payload<EventPayload>,
  ): CanonicalEvent => ({
    v: 1,
    session: f.conversation,
    run: run.run,
    turn,
    seq,
    at: start,
    source: "provider",
    ...payload,
  });
  const started = (seq: number, turn: string, starter?: Actor) =>
    event(seq, turn, {
      kind: "turn.started",
      body: starter ? { starter } : {},
    });
  const ended = (seq: number, turn: string) =>
    event(seq, turn, {
      kind: "turn.ended",
      body: { reason: "completed" },
    });
  const prompt = (seq: number, turn: string) =>
    event(seq, turn, {
      kind: "prompt.opened",
      body: { prompt_id: "approval", kind: "permission" },
    });
  const projection = () =>
    f.t.run(({ db }) => db.query("run_turn_projections").unique());
  return {
    ...f,
    agent,
    reserve,
    append,
    event,
    started,
    ended,
    prompt,
    projection,
  };
}

test("a started human delivery supplies the durable starter and exact accepted turn instance", async () => {
  const f = await fixture();
  const { begin } = await f.reserve();
  expect((await begin()).status).toBe("started");
  const starter = { kind: "person", id: f.owner } as const;
  await f.append(
    f.started(1, "opening"),
    f.started(2, "follow-up", { kind: "person", id: "different-person" }),
    f.ended(3, "opening"),
    f.started(4, "follow-up", starter),
  );
  expect(await f.projection()).toMatchObject({
    projection_version: TURN_STARTER_PROJECTION_VERSION,
    open_turn: { id: "follow-up", prompt_ids: [], starter, start_event_seq: 4 },
  });
  const opened = await f.projection();
  await f.append(f.started(4, "follow-up", { kind: "agent", id: f.agent }));
  expect(await f.projection()).toEqual(opened);
  await f.append(f.prompt(5, "follow-up"));
  const projection = await f.projection();
  expect(projection?.open_turn).toEqual({
    id: "follow-up",
    prompt_ids: ["approval"],
    prompt_details: [{ prompt_id: "approval", kind: "permission" }],
    starter,
    start_event_seq: 4,
  });
  expect(
    await f.t.run(async ({ db }) => {
      const binding = await db.get(f.binding);
      if (!binding) throw Error("Expected binding");
      const lease = await db.query("run_leases").unique();
      return isFreshTurnProjection(binding, lease, projection, start);
    }),
  ).toBe(true);
  expect(await f.t.run(({ db }) => db.query("claims").collect())).toEqual([]);
  const second = await f.t.run(async ({ db }) => {
    const user = await fixtureRows(db, "starter contender").user();
    await db.patch(f.conversation, { owner_user_id: user });
    return user;
  });
  await asUser(f.t, second).mutation(api.pendingMessages.sendMessageV2, {
    conversation_id: f.conversation,
    command_id: "contest",
    client_id: "contest",
    content: "Second sender",
    observed_turn: { id: "follow-up", run: 1, start_event_seq: 4 },
  });
  const joined = await f.t.run(async ({ db }) => ({
    claim: await db.query("claims").unique(),
    message: await db
      .query("pending_messages")
      .withIndex("by_conversation_client_id", (q) =>
        q.eq("conversation_id", f.conversation).eq("client_id", "contest"),
      )
      .unique(),
  }));
  expect(joined.claim).toMatchObject({ holder: f.owner, token: 1 });
  expect(joined.message).toMatchObject({ delivery_intent: "queue" });
  expect((await f.projection())?.open_turn?.baton_converted).toBe(true);
  await f.append(
    f.event(6, "follow-up", {
      kind: "prompt.settled",
      body: { prompt_id: "approval", by: starter, answer: null },
    }),
  );
  expect((await f.projection())?.open_turn).toEqual({
    id: "follow-up",
    prompt_ids: [],
    starter,
    start_event_seq: 4,
    baton_converted: true,
  });
  await f.append(f.ended(7, "follow-up"));
  expect((await f.projection())?.open_turn).toBeNull();
});

test.each([
  { senderKind: "person", report: "person", stage: "claimed", valid: false },
  {
    senderKind: "person",
    report: "wrong-person",
    stage: "started",
    valid: false,
  },
  { senderKind: "person", report: "unknown", stage: "started", valid: false },
  { senderKind: "scheduler", report: "person", stage: "started", valid: false },
  { senderKind: "non-human", report: "person", stage: "started", valid: false },
  { senderKind: "agent", report: "person", stage: "started", valid: false },
  { senderKind: "agent", report: "agent", stage: "started", valid: true },
] as const)(
  "starter verification $senderKind $report $stage",
  async ({ senderKind, report, stage, valid }) => {
    const f = await fixture({ senderKind });
    const { begin } = await f.reserve();
    if (stage === "started") expect((await begin()).status).toBe("started");
    const reported: Actor | undefined =
      report === "unknown"
        ? undefined
        : report === "agent"
          ? { kind: "agent", id: f.agent }
          : {
              kind: "person",
              id: report === "person" ? f.owner : "different-person",
            };
    await f.append(f.started(1, "turn", reported));
    expect((await f.projection())?.open_turn).toEqual({
      id: "turn",
      prompt_ids: [],
      start_event_seq: 1,
      ...(valid && { starter: reported }),
    });
  },
);

test("an existing live claim converts the new turn and stays converted after release", async () => {
  const f = await fixture();
  const claim = await f.t.run(({ db }) =>
    db.insert("claims", {
      conversation_id: f.conversation,
      kind: "steer",
      holder: f.owner,
      token: 1,
      lease_until: start + 100,
    }),
  );
  await f.append(f.started(1, "first"));
  expect((await f.projection())?.open_turn).toEqual({
    id: "first",
    prompt_ids: [],
    start_event_seq: 1,
    baton_converted: true,
  });
  await f.t.run(({ db }) =>
    db.patch(claim, { holder: undefined, lease_until: start }),
  );
  await f.append(f.prompt(2, "first"));
  expect((await f.projection())?.open_turn).toEqual({
    id: "first",
    prompt_ids: ["approval"],
    prompt_details: [{ prompt_id: "approval", kind: "permission" }],
    start_event_seq: 1,
    baton_converted: true,
  });
  await f.append(f.ended(3, "first"), f.started(4, "second"));
  expect((await f.projection())?.open_turn).toEqual({
    id: "second",
    prompt_ids: [],
    start_event_seq: 4,
  });
});

test("a started steer cannot verify the starter of a later turn", async () => {
  const f = await fixture();
  const queue = await f.reserve();
  expect((await queue.begin()).status).toBe("started");
  const starter = { kind: "person", id: f.owner } as const;
  await f.append(f.started(1, "original", starter));
  expect((await queue.settle()).status).toBe("recorded");
  await asUser(f.t, f.owner).mutation(api.pendingMessages.sendMessageV2, {
    conversation_id: f.conversation,
    command_id: "steer",
    client_id: "steer",
    content: "Steer the original turn",
    observed_turn: { id: "original", run: 1, start_event_seq: 1 },
  });
  const steer = await f.reserve();
  expect(await steer.begin()).toMatchObject({
    status: "started",
    intent: "steer",
  });

  await f.append(f.ended(2, "original"), f.started(3, "later", starter));

  expect((await f.projection())?.open_turn).toEqual({
    id: "later",
    prompt_ids: [],
    start_event_seq: 3,
  });
});

test("an expired claim with a holder does not convert the new turn", async () => {
  const f = await fixture();
  await f.t.run(({ db }) =>
    db.insert("claims", {
      conversation_id: f.conversation,
      kind: "steer",
      holder: f.owner,
      token: 1,
      lease_until: start,
    }),
  );

  await f.append(f.started(1, "turn"));

  expect((await f.projection())?.open_turn).toEqual({
    id: "turn",
    prompt_ids: [],
    start_event_seq: 1,
  });
});

test("a queue delivery settled before turn start cannot verify the starter", async () => {
  const f = await fixture();
  const delivery = await f.reserve();
  expect((await delivery.begin()).status).toBe("started");
  expect((await delivery.settle()).status).toBe("recorded");

  await f.append(f.started(1, "turn", { kind: "person", id: f.owner }));

  expect((await f.projection())?.open_turn).toEqual({
    id: "turn",
    prompt_ids: [],
    start_event_seq: 1,
  });
});

test("a higher-sequence duplicate start leaves the open turn instance intact", async () => {
  const f = await fixture();
  const { begin } = await f.reserve();
  expect((await begin()).status).toBe("started");
  await f.append(f.started(1, "turn", { kind: "person", id: f.owner }));
  const original = await f.projection();

  await f.append(f.started(2, "turn", { kind: "agent", id: f.agent }));

  expect(await f.projection()).toEqual(original);
});

test.each([true, false])(
  "reusing a turn id records the last accepted start (already open=%p)",
  async (alreadyOpen) => {
    const f = await fixture();
    const { begin } = await f.reserve();
    expect((await begin()).status).toBe("started");
    const original = f.started(1, "reused", { kind: "person", id: f.owner });
    const batch = [f.ended(2, "reused")];
    for (let seq = 3; seq < 67; seq += 2) {
      const id = `intervening-${seq}`;
      batch.push(f.started(seq, id), f.ended(seq + 1, id));
    }
    batch.push(f.started(67, "reused"));
    if (alreadyOpen) {
      const claim = await f.t.run(({ db }) =>
        db.insert("claims", {
          conversation_id: f.conversation,
          kind: "steer",
          holder: f.owner,
          token: 1,
          lease_until: start + 1,
        }),
      );
      await f.append(original);
      expect((await f.projection())?.open_turn).toMatchObject({
        starter: { kind: "person", id: f.owner },
        start_event_seq: 1,
        baton_converted: true,
      });
      await f.t.run(({ db }) => db.patch(claim, { lease_until: start }));
    } else {
      batch.unshift(original);
    }

    await f.append(...batch);

    expect((await f.projection())?.open_turn).toEqual({
      id: "reused",
      prompt_ids: [],
      start_event_seq: 67,
    });
  },
);

test.each([true, false])(
  "a disabled baton path keeps the version 1 projection (capable=%p)",
  async (capable) => {
    if (capable) delete process.env[batonFlag];
    const f = await fixture({ capable });
    const { begin } = await f.reserve();
    expect((await begin()).status).toBe("started");
    await f.append(f.started(1, "legacy", { kind: "person", id: f.owner }));
    expect(await f.projection()).toMatchObject({
      projection_version: TURN_PROJECTION_VERSION,
    });
    expect((await f.projection())?.open_turn).toEqual({
      id: "legacy",
      prompt_ids: [],
    });
    if (capable) {
      process.env[batonFlag] = "1";
      await f.append(f.prompt(2, "legacy"));
      expect((await f.projection())?.open_turn).toEqual({
        id: "legacy",
        prompt_ids: ["approval"],
        prompt_details: [{ prompt_id: "approval", kind: "permission" }],
      });
      await f.append(f.ended(3, "legacy"), f.started(4, "new"));
      expect(await f.projection()).toMatchObject({
        projection_version: TURN_STARTER_PROJECTION_VERSION,
        open_turn: { id: "new", start_event_seq: 4 },
      });
    }
  },
);
