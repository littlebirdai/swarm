import { afterEach, beforeEach, expect, setSystemTime } from "bun:test";
import {
  parseCommandsNextResponse,
  type CanonicalEvent,
} from "@codecast/edge-contract";
import type { FunctionArgs } from "convex/server";
import { api, internal } from "../convex/_generated/api";
import { asUser } from "./database.testkit";
import { boot, machine, setupRunLease, start } from "./run-lease.testkit";

export const flag = "CODECAST_FENCED_EXECUTION_V1";
export const edge = "CODECAST_EDGE_DELIVERY_V1";

export function installEdgePromptTestClock() {
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
}

export async function edgePromptFixture(
  kind: "question" | "permission" = "question",
) {
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
