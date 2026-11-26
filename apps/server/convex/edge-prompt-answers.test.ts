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
