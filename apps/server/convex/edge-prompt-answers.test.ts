import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import {
  parseCommandsNextResponse,
  type CanonicalEvent,
} from "@codecast/edge-contract";
import type { FunctionArgs } from "convex/server";
import { asUser } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import {
  boot,
  leaseMs,
  machine,
  setupRunLease,
  start,
} from "../test-helpers/run-lease.testkit";
import { api, internal } from "./_generated/api";

const flag = "CODECAST_FENCED_EXECUTION_V1";
const edge = "CODECAST_EDGE_DELIVERY_V1";
const saved = [process.env[flag], process.env[edge]];
beforeEach(() => {
  process.env[flag] = "1";
  process.env[edge] = "1";
  setSystemTime(new Date(start));
});
afterEach(() => {
  for (const [index, name] of [flag, edge].entries()) {
    const previous = saved[index];
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
  setSystemTime();
});

async function fixture(kind: "question" | "permission" = "question") {
  const f = await setupRunLease();
  const browser = asUser(f.t, f.owner);
  const lease = await f.claim("prompt-lease");
  if (lease.status !== "granted") throw new Error("Expected run lease");

  const target = {
    conversation_id: f.conversation,
    run: 1,
    turn_id: "turn",
    prompt_id: "active-prompt",
  };
  const base = {
    v: 1,
    session: f.conversation,
    run: target.run,
    source: "provider",
    turn: target.turn_id,
    at: start,
  } as const;
  const append = async (
    events: CanonicalEvent[],
    token = lease.fencing_token,
  ) => {
    expect(
      await f.t.mutation(internal.edgeRunLease.append, {
        ...f.requestFence(token),
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
      body: { prompt_id: target.prompt_id, kind },
    },
  ]);
  const address = await browser.query(api.permissions.getPromptAddress, target);
  if (!address) throw new Error("Expected open prompt address");
  const post = (name: string, body: unknown, bearer = f.bearer) =>
    f.t.fetch(`/edge/v1/${name}`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body),
    });
  const next = async (
    bearer = f.bearer,
    requestedBoot = boot,
    requestedMachine = machine,
  ) => {
    const response = await post(
      "commands.next",
      {
        v: 1,
        machine: requestedMachine,
        boot: requestedBoot,
      },
      bearer,
    );
    expect(response.status).toBe(200);
    const parsed = parseCommandsNextResponse(await response.json());
    if (!parsed.ok) throw new Error(JSON.stringify(parsed));
    return parsed.value;
  };
  return {
    ...f,
    browser,
    target,
    address,
    lease,
    base,
    append,
    next,
    post,
    answer: (
      answer: FunctionArgs<typeof api.permissions.answerPrompt>["answer"] = {
        behavior: "allow",
      },
    ) => browser.mutation(api.permissions.answerPrompt, { ...address, answer }),
    rows: () => f.t.run(({ db }) => db.query("edge_prompt_answers").collect()),
  };
}

test("question answers deliver with the authenticated actor only to the run device and boot", async () => {
  const f = await fixture();
  const answer = { answers: { "question-id": { answers: ["Choice"] } } };
  const id = await f.answer(answer);
  expect(
    await f.browser.query(api.permissions.getPromptAddress, f.target),
  ).toBeNull();
  expect(await f.next(f.wrongDevice, boot, "wrong-machine")).toEqual({
    v: 1,
    status: "empty",
  });
  expect(await f.next(f.wrongDevice)).toEqual({ v: 1, status: "empty" });
  expect(await f.next(f.wrongUser)).toEqual({ v: 1, status: "empty" });
  expect(await f.next(f.bearer, "old-boot")).toEqual({ v: 1, status: "empty" });
  const expected = {
    v: 1,
    status: "command",
    command_id: id,
    name: "prompt_answer",
    claim: {
      session: f.conversation,
      run: 1,
      fencing_token: f.lease.fencing_token,
    },
    expected: { kind: "prompt", run: 1, prompt_id: f.target.prompt_id },
    args: { by: { kind: "person", id: f.owner }, answer },
  };
  expect(await f.next()).toEqual(expected);
  expect(await f.next()).toEqual(expected);

  const result = {
    v: 1,
    machine,
    boot,
    command_id: id,
    claim: expected.claim,
    outcome: "completed",
    output: null,
  };
  const bad = await f.post("commands.result", {
    ...result,
    claim: { ...result.claim, fencing_token: "wrong" },
  });
  expect(await bad.json()).toEqual({ v: 1, status: "stale" });
  expect(await f.next()).toEqual(expected);
  const ack = await f.post("commands.result", result);
  expect(await ack.json()).toEqual({ v: 1, status: "recorded" });
  const retry = await f.post("commands.result", result);
  expect(await retry.json()).toEqual({ v: 1, status: "duplicate" });
  expect(await f.next()).toEqual({ v: 1, status: "empty" });
  expect(await f.rows()).toMatchObject([
    { _id: id, actor_user_id: f.owner, answer },
  ]);
});

test("concurrent answers to the same prompt record just one decision", async () => {
  const f = await fixture("permission");
  const results = await Promise.allSettled([
    f.answer({ behavior: "allow" }),
    f.answer({ behavior: "deny" }),
  ]);
  expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
    1,
  );
  expect(results.filter(({ status }) => status === "rejected")).toEqual([
    expect.objectContaining({
      reason: expect.objectContaining({
        message: expect.stringContaining("PROMPT_ALREADY_ANSWERED"),
      }),
    }),
  ]);
  expect(await f.rows()).toHaveLength(1);
  expect(await f.next()).toMatchObject({
    name: "prompt_answer",
    args: { answer: (await f.rows())[0].answer },
  });
});

test("a stale run cannot accept or deliver an answer", async () => {
  const f = await fixture();
  await expect(
    f.browser.mutation(api.permissions.answerPrompt, {
      ...f.address,
      run: 2,
      answer: null,
    }),
  ).rejects.toThrow("STALE_OR_UNAUTHORIZED_PROMPT");
  await expect(
    f.browser.mutation(api.permissions.answerPrompt, {
      ...f.address,
      turn_id: "old-turn",
      answer: null,
    }),
  ).rejects.toThrow("STALE_OR_UNAUTHORIZED_PROMPT");
  await f.answer();
  await f.t.run(({ db }) => db.patch(f.head, { current_epoch: 2 }));
  await expect(f.answer()).rejects.toThrow("STALE_OR_UNAUTHORIZED_PROMPT");
  expect(await f.next()).toEqual({ v: 1, status: "empty" });
});

test("a settled prompt refuses new answers and queued work cannot use a replacement lease", async () => {
  const f = await fixture();
  await f.answer(null);
  await f.append([
    {
      ...f.base,
      seq: 3,
      kind: "prompt.settled",
      body: {
        prompt_id: f.target.prompt_id,
        by: { kind: "person", id: f.owner },
        answer: null,
      },
    },
  ]);
  expect(await f.next()).toEqual({ v: 1, status: "empty" });
  await expect(f.answer()).rejects.toThrow("STALE_OR_UNAUTHORIZED_PROMPT");

  setSystemTime(new Date(start + leaseMs));
  const lease = await f.claim("replacement");
  if (lease.status !== "granted") throw new Error("Expected replacement lease");
  await f.append(
    [
      { ...f.base, seq: 4, kind: "turn.started", body: {} },
      {
        ...f.base,
        seq: 5,
        kind: "prompt.opened",
        body: { prompt_id: f.target.prompt_id, kind: "permission" },
      },
    ],
    lease.fencing_token,
  );
  await expect(f.answer()).rejects.toThrow("STALE_OR_UNAUTHORIZED_PROMPT");
  const current = await f.browser.query(
    api.permissions.getPromptAddress,
    f.target,
  );
  expect(current?.lease_id).not.toBe(f.address.lease_id);
  if (!current) throw new Error("Expected replacement prompt");
  await f.browser.mutation(api.permissions.answerPrompt, {
    ...current,
    answer: { behavior: "allow" },
  });
  expect(await f.next()).toMatchObject({
    args: { answer: { behavior: "allow" } },
  });
});

test("an unsigned caller and another signed-in person cannot retrieve or answer the prompt", async () => {
  const f = await fixture();
  const other = await f.t.run(({ db }) =>
    fixtureRows(db, "wrong prompt actor").user(),
  );
  const browser = asUser(f.t, other);
  const args = { ...f.address, answer: null };
  expect(
    await browser.query(api.permissions.getPromptAddress, f.target),
  ).toBeNull();
  await expect(
    browser.mutation(api.permissions.answerPrompt, args),
  ).rejects.toThrow("STALE_OR_UNAUTHORIZED_PROMPT");
  await expect(
    f.t.mutation(api.permissions.answerPrompt, args),
  ).rejects.toThrow("Unauthorized");
  const spoofed = { ...args, by: { kind: "person", id: f.owner } };
  await expect(
    browser.mutation(api.permissions.answerPrompt, spoofed),
  ).rejects.toThrow();
  expect(await f.rows()).toEqual([]);
});

test.each([flag, edge])(
  "the legacy permission mutation keeps its path with %s off",
  async (disabled) => {
    const f = await fixture();
    const permission_id = await f.browser.mutation(
      api.permissions.createPermissionRequest,
      {
        conversation_id: f.conversation,
        session_id: "runtime",
        tool_name: "read",
        arguments_preview: "read notes",
      },
    );
    await expect(
      f.browser.mutation(api.permissions.updatePermissionStatus, {
        permission_id,
        status: "approved",
      }),
    ).rejects.toThrow("exact prompt address");
    delete process.env[disabled];
    await expect(f.answer()).rejects.toThrow("FENCED_PROMPT_ANSWERS_DISABLED");
    expect(
      (await f.post("commands.next", { v: 1, machine, boot })).status,
    ).toBe(404);
    expect(
      await f.browser.mutation(api.permissions.updatePermissionStatus, {
        permission_id,
        status: "approved",
      }),
    ).toBe(permission_id);
    expect(await f.rows()).toEqual([]);
  },
);

test("conversation deletion removes queued prompt answers and stops command delivery immediately", async () => {
  const f = await fixture();
  await f.answer();
  await f.browser.mutation(api.sessionDelete.deleteSession, {
    conversation_id: f.conversation,
  });
  expect(await f.next()).toEqual({ v: 1, status: "empty" });
  await f.t.mutation(internal.sessionDelete.purgeConversationRows, {
    conversation_id: f.conversation,
  });
  expect(await f.rows()).toEqual([]);
});

test("account deletion removes orphan prompt answers by owner", async () => {
  const f = await fixture();
  await f.answer();
  await f.t.run(({ db }) => db.delete(f.conversation));
  await f.t.mutation(internal.accountDelete.purgeAccount, { user_id: f.owner });
  expect(await f.rows()).toEqual([]);
  expect(await f.t.run(({ db }) => db.get(f.owner))).toBeNull();
});

test("the answerable feed publishes only the owner's exact prompt addresses and question metadata", async () => {
  const f = await fixture();
  const feed = api.permissions.listAnswerablePromptAddresses;
  expect(
    await f.browser.query(feed, { conversation_id: f.conversation }),
  ).toEqual([]);
  const questions = [
    { id: "choice", is_secret: false, question: "Choose an option" },
    {
      id: "hidden",
      is_secret: true,
      question: "Provide a secret",
      header: "Secret",
    },
  ];
  await f.append([
    {
      ...f.base,
      seq: 3,
      turn: "wrong-turn",
      kind: "context",
      body: { data: { prompt_id: f.target.prompt_id, questions } },
    },
    {
      ...f.base,
      seq: 4,
      kind: "context",
      body: {
        data: {
          prompt_id: f.target.prompt_id,
          questions: [{ id: "missing-secret-marker" }],
        },
      },
    },
  ]);
  expect(
    await f.browser.query(feed, { conversation_id: f.conversation }),
  ).toEqual([]);
  await f.append([
    {
      ...f.base,
      seq: 5,
      kind: "context",
      body: { data: { prompt_id: f.target.prompt_id, questions } },
    },
    {
      ...f.base,
      seq: 6,
      kind: "prompt.opened",
      body: {
        prompt_id: "approval",
        kind: "permission",
        tool_call_id: "tool-approval",
      },
    },
  ]);
  const result = await f.browser.query(feed, {
    conversation_id: f.conversation,
  });
  expect(result).toEqual([
    {
      ...f.address,
      _id: JSON.stringify([
        f.address.lease_id,
        f.target.turn_id,
        f.target.prompt_id,
      ]),
      kind: "question",
      questions: [
        { id: "choice", is_secret: false },
        { id: "hidden", is_secret: true },
      ],
    },
    {
      ...f.address,
      _id: JSON.stringify([f.address.lease_id, f.target.turn_id, "approval"]),
      prompt_id: "approval",
      kind: "permission",
      tool_call_id: "tool-approval",
      questions: [],
    },
  ]);
  const rows = await f.t.run(({ db }) =>
    db.query("run_turn_projections").collect(),
  );
  expect(rows[0]?.open_turn?.prompt_details).toEqual([
    {
      prompt_id: f.target.prompt_id,
      kind: "question",
      questions: [
        { id: "choice", is_secret: false },
        { id: "hidden", is_secret: true },
      ],
    },
    {
      prompt_id: "approval",
      kind: "permission",
      tool_call_id: "tool-approval",
    },
  ]);
  const [outsider, other] = await f.t.run(async ({ db }) => {
    const rows = fixtureRows(db, "prompt address access");
    return [
      await rows.user(),
      await rows.conversation(f.owner, {
        execution_protocol_state: "fenced",
        owner_device_id: machine,
      }),
    ] as const;
  });
  expect(
    await asUser(f.t, outsider).query(feed, {
      conversation_id: f.conversation,
    }),
  ).toEqual([]);
  expect(await f.t.query(feed, { conversation_id: f.conversation })).toEqual(
    [],
  );
  expect(await f.browser.query(feed, { conversation_id: other })).toEqual([]);

  await f.answer({ answers: { choice: { answers: ["Option"] } } });
  expect(
    (await f.browser.query(feed, { conversation_id: f.conversation })).map(
      ({ prompt_id }) => prompt_id,
    ),
  ).toEqual(["approval"]);
  process.env[flag] = "0";
  expect(
    await f.browser.query(feed, { conversation_id: f.conversation }),
  ).toEqual([]);
});

test("settlement, turn end, and lease release remove durable prompt details", async () => {
  const f = await fixture("permission");
  const feed = () =>
    f.browser.query(api.permissions.listAnswerablePromptAddresses, {
      conversation_id: f.conversation,
    });
  const openTurn = async () =>
    (await f.t.run(({ db }) => db.query("run_turn_projections").unique()))
      ?.open_turn;
  await f.append([
    {
      ...f.base,
      seq: 3,
      kind: "prompt.opened",
      body: { prompt_id: "next", kind: "permission" },
    },
  ]);
  expect((await feed()).map(({ prompt_id }) => prompt_id)).toEqual([
    f.target.prompt_id,
    "next",
  ]);
  await f.append([
    {
      ...f.base,
      seq: 4,
      kind: "prompt.settled",
      body: {
        prompt_id: f.target.prompt_id,
        by: { kind: "person", id: f.owner },
        answer: { behavior: "deny" },
      },
    },
  ]);
  expect((await feed()).map(({ prompt_id }) => prompt_id)).toEqual(["next"]);
  expect((await openTurn())?.prompt_details).toEqual([
    { prompt_id: "next", kind: "permission" },
  ]);

  await f.append([
    { ...f.base, seq: 5, kind: "turn.ended", body: { reason: "done" } },
  ]);
  expect(await feed()).toEqual([]);
  expect(await openTurn()).toBeNull();

  const newTurn = { ...f.base, turn: "another-turn" };
  await f.append([
    { ...newTurn, seq: 6, kind: "turn.started", body: {} },
    {
      ...newTurn,
      seq: 7,
      kind: "prompt.opened",
      body: { prompt_id: "next", kind: "question" },
    },
    {
      ...newTurn,
      seq: 8,
      kind: "context",
      body: {
        data: {
          prompt_id: "next",
          questions: [{ id: "once", is_secret: true }],
        },
      },
    },
  ]);
  expect(await feed()).toHaveLength(1);
  expect(
    await f.t.mutation(
      internal.edgeRunLease.release,
      f.requestFence(f.lease.fencing_token),
    ),
  ).toMatchObject({ status: "released" });
  expect(await feed()).toEqual([]);
  expect(await openTurn()).toBeNull();

  const replacement = await f.claim("replacement");
  if (replacement.status !== "granted")
    throw new Error("Expected replacement lease");
  await f.append(
    [
      { ...newTurn, seq: 9, kind: "turn.started", body: {} },
      {
        ...newTurn,
        seq: 10,
        kind: "prompt.opened",
        body: { prompt_id: "next", kind: "question" },
      },
    ],
    replacement.fencing_token,
  );
  expect(await feed()).toEqual([]);
  expect((await openTurn())?.prompt_details).toEqual([
    { prompt_id: "next", kind: "question" },
  ]);
});

test("a replacement lease starts without question metadata from the expired lease", async () => {
  const f = await fixture();
  const context: Omit<Extract<CanonicalEvent, { kind: "context" }>, "seq"> = {
    ...f.base,
    kind: "context",
    body: {
      data: {
        prompt_id: f.target.prompt_id,
        questions: [{ id: "expired-secret", is_secret: true }],
      },
    },
  };
  await f.append([{ ...context, seq: 3 }]);
  const feed = () =>
    f.browser.query(api.permissions.listAnswerablePromptAddresses, {
      conversation_id: f.conversation,
    });
  expect(await feed()).toHaveLength(1);
  setSystemTime(new Date(start + leaseMs));
  expect(await feed()).toEqual([]);
  const newLease = await f.claim("replacement-after-expiry");
  if (newLease.status !== "granted") throw new Error("Expected a fresh lease");
  expect(
    await f.t.run(
      async ({ db }) =>
        (await db.query("run_turn_projections").unique())?.open_turn,
    ),
  ).toBeNull();
  await f.append(
    [
      { ...f.base, seq: 4, kind: "turn.started", body: {} },
      {
        ...f.base,
        seq: 5,
        kind: "prompt.opened",
        body: { prompt_id: f.target.prompt_id, kind: "question" },
      },
      {
        ...f.base,
        seq: 6,
        kind: "context",
        body: {
          data: {
            prompt_id: f.target.prompt_id,
            questions: [{ id: "replacement", is_secret: false }],
          },
        },
      },
    ],
    newLease.fencing_token,
  );
  const addresses = await feed();
  expect(addresses).toHaveLength(1);
  expect(addresses[0]?.lease_id).not.toBe(f.address.lease_id);
  expect(addresses[0]?.questions).toEqual([
    { id: "replacement", is_secret: false },
  ]);
});

test("the prompt feed keeps only the 32 prompts admitted by the turn", async () => {
  const f = await fixture("permission");
  await f.append(
    Array.from({ length: 32 }, (_, index) => ({
      ...f.base,
      seq: index + 3,
      kind: "prompt.opened" as const,
      body: { prompt_id: `approval-${index}`, kind: "permission" as const },
    })),
  );
  const rows = await f.browser.query(
    api.permissions.listAnswerablePromptAddresses,
    {
      conversation_id: f.conversation,
    },
  );
  expect(rows.map(({ prompt_id }) => prompt_id)).toEqual([
    f.target.prompt_id,
    ...Array.from({ length: 31 }, (_, index) => `approval-${index}`),
  ]);
});

test.each([
  [
    "question count",
    Array.from({ length: 33 }, (_, index) => `question-${index}`),
  ],
  ["question id length", ["q".repeat(257)]],
])("the prompt feed refuses excessive %s", async (_bound, ids) => {
  const f = await fixture();
  await f.append([
    {
      ...f.base,
      seq: 3,
      kind: "context",
      body: {
        data: {
          prompt_id: f.target.prompt_id,
          questions: ids.map((id) => ({ id, is_secret: false })),
        },
      },
    },
  ]);
  expect(
    await f.browser.query(api.permissions.listAnswerablePromptAddresses, {
      conversation_id: f.conversation,
    }),
  ).toEqual([]);
});

test("question metadata respects the total turn budget and can use space freed by a settled prompt", async () => {
  const f = await fixture();
  const ids = [f.target.prompt_id, "second", "third", "fourth"];
  const questions = Array.from({ length: 32 }, (_, index) => ({
    id: String(index).padStart(256, "q"),
    is_secret: true,
  }));
  const context = (prompt_id: string, seq: number): CanonicalEvent => ({
    ...f.base,
    seq,
    kind: "context",
    body: { data: { prompt_id, questions } },
  });
  await f.append([
    ...ids.slice(1).map((prompt_id, index) => ({
      ...f.base,
      seq: index + 3,
      kind: "prompt.opened" as const,
      body: { prompt_id, kind: "question" as const },
    })),
    ...ids.map((prompt_id, index) => context(prompt_id, index + 6)),
  ]);
  const feed = () =>
    f.browser.query(api.permissions.listAnswerablePromptAddresses, {
      conversation_id: f.conversation,
    });
  const addresses = await feed();
  expect(addresses.map(({ prompt_id }) => prompt_id)).toEqual(ids.slice(0, 3));
  expect(addresses[0]?.questions).toEqual(questions);
  await f.append([
    {
      ...f.base,
      seq: 10,
      kind: "prompt.settled",
      body: { prompt_id: f.target.prompt_id, outcome: "answered" },
    },
    context("fourth", 11),
  ]);
  expect((await feed()).map(({ prompt_id }) => prompt_id)).toEqual(
    ids.slice(1),
  );
});
