// The hold (docs/architecture/the-line.md L5): a pending, blocking decision
// bound to a task at its current station keeps the task there. A session
// actor is refused; a person on the board moves past it and a note comment
// names the decision; answering the decision releases the hold.
import { describe, expect, test } from "bun:test";
import type { FunctionArgs } from "convex/server";
import { serverTest, asUser } from "../test-helpers/database.testkit";
import { fixtureRows, type NewRow } from "../test-helpers/rows.testkit";
import { api } from "./_generated/api";
import { holdingDecisionFor } from "./tasks";

const TOKEN = "hold-token";

async function setup(
  taskFields: Partial<NewRow<"tasks">> = {},
  decisionFields: Partial<NewRow<"session_decisions">> = {},
) {
  const t = serverTest();
  const ids = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "task station hold");
    const owner = await rows.user();
    await rows.token(owner, TOKEN);
    const taskId = await rows.task(owner, {
      short_id: "ct-1",
      status: "in_review",
      source: "agent",
      ...taskFields,
    });
    const hand = await rows.conversation(owner, { session_id: "hand" });
    const decisionId = await db.insert("session_decisions", {
      short_id: "sd-211",
      conversation_id: hand,
      session_id: "hand",
      user_id: owner,
      question: "Ship it?",
      options: [{ label: "Yes" }, { label: "No" }],
      blocking: true,
      status: "pending",
      task_id: taskId,
      station: "in_review",
      created_at: 1,
      ...decisionFields,
    });
    return { owner, taskId, decisionId };
  });
  return {
    ...ids,
    t,
    cliMove: (
      session?: string,
      fields: Partial<FunctionArgs<typeof api.tasks.update>> = {},
    ) =>
      t.mutation(api.tasks.update, {
        api_token: TOKEN,
        short_id: "ct-1",
        status: "in_progress",
        conversation_id: session,
        ...fields,
      }),
    boardMove: () =>
      asUser(t, ids.owner).mutation(api.tasks.webUpdate, {
        short_id: "ct-1",
        status: "in_progress",
      }),
    task: () => t.run(async ({ db }) => (await db.get(ids.taskId))!),
    decision: () => t.run(async ({ db }) => (await db.get(ids.decisionId))!),
    comments: () => t.run(({ db }) => db.query("task_comments").collect()),
  };
}

describe("the hold (the-line.md L5)", () => {
  test("a hand cannot move a held task; the error names the decision and the release path", async () => {
    const { task, decision, comments, cliMove } = await setup();
    const refused = await cliMove("hand").then(
      () => "",
      (err: Error) => err.message,
    );
    expect(refused).toStartWith(
      "Held at in_review by sd-211, a decision for a person to answer",
    );
    // The session is never told to answer the person's decision itself.
    expect(refused).not.toContain("decide answer");
    expect(refused).toContain("cast task dep ct-1 --blocked-by sd-211");
    expect((await task()).status).toBe("in_review");
    expect(await comments()).toHaveLength(0);
  });

  test("a hand's handoff on a held task keeps the evidence and leaves the task at its station", async () => {
    const { task, decision, cliMove } = await setup(
      { status: "in_progress" },
      { station: "in_progress" },
    );
    const result = await cliMove("hand", {
      status: "in_review",
      execution_status: "blocked",
      verification_evidence: "stopped: waiting on the call",
    });
    expect(result.held).toEqual({ decision: "sd-211", station: "in_progress" });
    expect((await task()).status).toBe("in_progress");
    expect((await task()).verification_evidence).toBe(
      "stopped: waiting on the call",
    );
    expect((await decision()).status).toBe("pending");
  });

  test("a person on the board moves past the hold; the decision stays open and a note names it", async () => {
    const { owner, task, decision, comments, boardMove } = await setup();
    await boardMove();
    expect((await task()).status).toBe("in_progress");
    expect((await decision()).status).toBe("pending");
    const note = (await comments()).find((c) => c.comment_type === "note");
    expect(note?.text).toContain("sd-211");
    expect(note?.text).toContain("in_review");
    expect(note?.author_user_id).toBe(owner);
  });

  test("a person at the CLI with no session is a person too: allowed, with the note", async () => {
    const { task, comments, cliMove } = await setup();
    await cliMove(undefined);
    expect((await task()).status).toBe("in_progress");
    expect(
      (await comments()).some(
        (c) => c.comment_type === "note" && c.text.includes("sd-211"),
      ),
    ).toBe(true);
  });

  test("answering releases the hold", async () => {
    const { task, comments, cliMove } = await setup(
      {},
      { status: "answered", answer_index: 0 },
    );
    await cliMove("hand");
    expect((await task()).status).toBe("in_progress");
    expect(await comments()).toHaveLength(0);
  });

  test("a non blocking decision does not hold", async () => {
    const { task, cliMove } = await setup(
      {},
      { blocking: false, default_option: 0 },
    );
    await cliMove("hand");
    expect((await task()).status).toBe("in_progress");
  });

  test("a decision at another station does not hold", async () => {
    const { task, cliMove } = await setup({}, { station: "in_progress" });
    await cliMove("hand");
    expect((await task()).status).toBe("in_progress");
  });

  test("the station is the team status id when the task carries one", async () => {
    const { task, cliMove } = await setup(
      { status_id: "qa" },
      { station: "qa" },
    );
    await expect(cliMove("hand")).rejects.toThrow(/Held at qa by sd-211/);
    expect((await task()).status).toBe("in_review");
  });

  test("a write that does not move the status is not held", async () => {
    const { t, task, cliMove } = await setup();
    await cliMove("hand", { status: undefined, title: "renamed" });
    const saved = await task();
    expect(saved.title).toBe("renamed");
    expect(
      await t.run((ctx) => holdingDecisionFor(ctx, saved, "in_review")),
    ).toBeNull();
    expect(
      await t.run((ctx) => holdingDecisionFor(ctx, saved, undefined)),
    ).toBeNull();
  });
});
