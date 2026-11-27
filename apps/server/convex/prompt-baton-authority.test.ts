import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import {
  STEER_BATON_CAPABILITY,
  type CanonicalEvent,
} from "@codecast/edge-contract";
import { asUser } from "../test-helpers/database.testkit";
import { installEdgePromptTestClock } from "../test-helpers/edge-prompt.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import {
  boot,
  machine,
  setupRunLease,
  start,
} from "../test-helpers/run-lease.testkit";
import { api, internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";

const baton = "SWARM_TURN_BATON";
const saved = process.env[baton];
installEdgePromptTestClock();
beforeEach(() => {
  process.env[baton] = "1";
});
afterEach(() => {
  if (saved === undefined) delete process.env[baton];
  else process.env[baton] = saved;
});

const routine = { answers: { choice: { answers: ["Short"] } } };
const approval = { behavior: "allow" } as const;
const stale =
  "The prompt has closed or you no longer have permission to answer it.";

async function setup() {
  const f = await setupRunLease();
  const { holder, viewer, stranger, claim } = await f.t.run(async ({ db }) => {
    const rows = fixtureRows(db, "prompt baton roles");
    const holder = await rows.user({ name: "Driver" });
    const viewer = await rows.user();
    const stranger = await rows.user();
    await db.patch(f.conversation, { share_token: "readable-prompt" });
    const binding = (await db.get(f.binding))!;
    await db.patch(f.binding, {
      capabilities: [...binding.capabilities!, STEER_BATON_CAPABILITY],
    });
    for (const user_id of [holder, viewer])
      await db.insert("share_redemptions", {
        conversation_id: f.conversation,
        user_id,
        token: "readable-prompt",
        created_at: start,
      });
    await db.insert("collab_grants", {
      conversation_id: f.conversation,
      grantee_user_id: holder,
      owner_user_id: f.owner,
      status: "granted",
      created_at: start,
      updated_at: start,
    });
    const claim = await db.insert("claims", {
      conversation_id: f.conversation,
      kind: "steer",
      holder,
      token: 1,
      lease_until: start + 5_000,
    });
    return { holder, viewer, stranger, claim };
  });
  const lease = await f.claim("prompt-baton-run");
  if (lease.status !== "granted") throw new Error("Expected run lease");
  const base = {
    v: 1,
    session: f.conversation,
    run: 1,
    source: "provider",
    turn: "turn",
    at: start,
  } as const;
  const append = async (events: CanonicalEvent[]) => {
    expect(
      await f.t.mutation(internal.edgeRunLease.append, {
        ...f.requestFence(lease.fencing_token),
        events_json: JSON.stringify(events),
      }),
    ).toMatchObject({ status: "appended" });
  };
  await append([
    { ...base, seq: 1, kind: "turn.started", body: {} },
    {
      ...base,
      seq: 2,
      kind: "prompt.opened",
      body: {
        prompt_id: "routine",
        kind: "question",
        summary: "Choose the output",
      },
    },
    {
      ...base,
      seq: 3,
      kind: "context",
      body: {
        data: {
          prompt_id: "routine",
          questions: [{ id: "choice", is_secret: false }],
        },
      },
    },
    {
      ...base,
      seq: 4,
      kind: "prompt.opened",
      body: {
        prompt_id: "escalation",
        kind: "permission",
        summary: "Modify deployment settings",
      },
    },
    {
      ...base,
      seq: 5,
      kind: "prompt.opened",
      body: { prompt_id: "unverified", kind: "question" },
    },
    {
      ...base,
      seq: 6,
      kind: "context",
      body: {
        data: {
          prompt_id: "unverified",
          questions: [{ id: "choice", is_secret: false }],
        },
      },
    },
    {
      ...base,
      seq: 7,
      kind: "prompt.opened",
      body: {
        prompt_id: "secret",
        kind: "question",
        summary: "Enter a credential",
      },
    },
    {
      ...base,
      seq: 8,
      kind: "context",
      body: {
        data: {
          prompt_id: "secret",
          questions: [{ id: "choice", is_secret: true }],
        },
      },
    },
  ]);
  const lease_id = (await f.t.run(({ db }) => db.query("run_leases").unique()))!
    ._id;
  const address = (prompt_id: string) => ({
    conversation_id: f.conversation,
    run: 1,
    turn_id: base.turn,
    lease_id,
    prompt_id,
  });
  const seat = (id: typeof f.owner) => {
    const browser = asUser(f.t, id);
    return {
      feed: () =>
        browser.query(api.permissions.getFencedPromptFeed, {
          conversation_id: f.conversation,
        }),
      pendingPermissions: () =>
        browser.query(api.permissions.getPendingPermissions, {
          conversation_id: f.conversation,
          as_proposer: true,
        }),
      answer: (prompt: string, answer: Doc<"edge_prompt_answers">["answer"]) =>
        browser.mutation(api.permissions.answerPrompt, {
          ...address(prompt),
          answer,
        }),
    };
  };
  return {
    ...f,
    base,
    append,
    holder,
    claim,
    viewer,
    stranger,
    seat,
    ownerSeat: seat(f.owner),
    holderSeat: seat(holder),
    viewerSeat: seat(viewer),
    rows: () => f.t.run(({ db }) => db.query("edge_prompt_answers").collect()),
    next: () =>
      f.t.mutation(internal.permissions.nextEdgePromptAnswer, {
        bearer: f.bearer,
        machine,
        boot,
      }),
  };
}

test("a verified routine question names the driver and only the driver can answer", async () => {
  const f = await setup();
  for (const [seat, allowed] of [
    [f.ownerSeat, false],
    [f.holderSeat, true],
    [f.viewerSeat, false],
  ] as const)
    expect((await seat.feed()).prompts).toContainEqual(
      expect.objectContaining({
        prompt_id: "routine",
        answerer: { name: "Driver", can_answer: allowed },
      }),
    );
  expect(await f.seat(f.stranger).feed()).toEqual({ prompts: [], turn: null });
  await expect(f.ownerSeat.answer("routine", routine)).rejects.toThrow(stale);
  await expect(f.viewerSeat.answer("routine", routine)).rejects.toThrow(stale);
  await expect(f.holderSeat.answer("routine", approval)).rejects.toThrow(
    "INVALID_PROMPT_ANSWER",
  );
  await expect(
    f.holderSeat.answer("routine", { answers: { gone: { answers: ["old"] } } }),
  ).rejects.toThrow("INVALID_PROMPT_ANSWER");
  await f.holderSeat.answer("routine", routine);
  expect(await f.rows()).toMatchObject([
    { owner_user_id: f.owner, actor_user_id: f.holder, answer: routine },
  ]);
  expect(await f.next()).toMatchObject({
    name: "prompt_answer",
    args: { by: { kind: "person", id: f.holder }, answer: routine },
  });
  for (const seat of [f.ownerSeat, f.holderSeat, f.viewerSeat])
    expect(
      (await seat.feed()).prompts.some(
        ({ prompt_id }) => prompt_id === "routine",
      ),
    ).toBe(false);
});

test("the owner answers escalation prompts even while a collaborator holds the baton", async () => {
  const f = await setup();
  for (const prompt of ["escalation", "unverified", "secret"]) {
    expect((await f.ownerSeat.feed()).prompts).toContainEqual(
      expect.objectContaining({
        prompt_id: prompt,
        answerer: { can_answer: true, name: "Session owner" },
      }),
    );
    expect((await f.holderSeat.feed()).prompts).toContainEqual(
      expect.objectContaining({
        prompt_id: prompt,
        answerer: { can_answer: false, name: "Session owner" },
      }),
    );
  }
  const permission = await f.t.run(({ db }) =>
    db.insert("pending_permissions", {
      conversation_id: f.conversation,
      session_id: "session",
      fenced_prompt_id: "escalation",
      fenced_prompt_turn_id: f.base.turn,
      tool_name: "Deploy",
      arguments_preview: "unshared preview",
      status: "pending",
      created_at: start,
    }),
  );
  expect(await f.viewerSeat.pendingPermissions()).toMatchObject([
    { _id: permission, fenced_prompt_id: "escalation", arguments_preview: "" },
  ]);
  expect(await f.seat(f.stranger).pendingPermissions()).toEqual([]);
  await expect(f.holderSeat.answer("escalation", approval)).rejects.toThrow(
    stale,
  );
  await expect(f.viewerSeat.answer("escalation", approval)).rejects.toThrow(
    stale,
  );
  await f.ownerSeat.answer("escalation", approval);
  expect(await f.rows()).toMatchObject([
    { actor_user_id: f.owner, answer: approval },
  ]);
});

test("concurrent answers settle once and a new answerer cannot answer the same address again", async () => {
  const f = await setup();
  const concurrent = await Promise.allSettled([
    f.holderSeat.answer("routine", routine),
    f.ownerSeat.answer("routine", routine),
  ]);
  expect(concurrent.map(({ status }) => status)).toEqual([
    "fulfilled",
    "rejected",
  ]);
  setSystemTime(new Date(start + 5_001));
  await expect(f.ownerSeat.answer("routine", routine)).rejects.toThrow(
    "This prompt already has an answer.",
  );
  expect(await f.rows()).toHaveLength(1);
});

test("the owner can answer after the holder expires and stale holders and prompts are refused", async () => {
  const f = await setup();
  setSystemTime(new Date(start + 5_001));
  await expect(f.holderSeat.answer("routine", routine)).rejects.toThrow(stale);
  expect((await f.ownerSeat.feed()).prompts).toContainEqual(
    expect.objectContaining({
      prompt_id: "routine",
      answerer: { can_answer: true, name: "Session owner" },
    }),
  );
  await f.ownerSeat.answer("routine", routine);
  await f.append([
    {
      ...f.base,
      seq: 9,
      kind: "prompt.settled",
      body: {
        prompt_id: "escalation",
        by: { kind: "person", id: f.owner },
        answer: null,
      },
    },
  ]);
  await expect(f.ownerSeat.answer("escalation", approval)).rejects.toThrow(
    stale,
  );
  expect(await f.rows()).toHaveLength(1);
});

test("flag off preserves the original owner-only prompt feed and answer", async () => {
  const f = await setup();
  delete process.env[baton];
  expect(await f.holderSeat.feed()).toEqual({ prompts: [], turn: null });
  expect((await f.ownerSeat.feed()).prompts[0]).not.toHaveProperty("answerer");
  await expect(f.holderSeat.answer("routine", routine)).rejects.toThrow(stale);
  await f.ownerSeat.answer("routine", routine);
});
