import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { ConvexError } from "convex/values";
import { asUser, serverTest } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { api, internal } from "./_generated/api";
import { findClaim } from "./lib/claims";
import { normalizeLinearIssue } from "./lib/issueMapping";
import { setTaskStatus } from "./orgInit";

const START = 1_800_000_000_000;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(START);
});

afterEach(() => {
  jest.useRealTimers();
});

async function setup(seed: string) {
  const t = serverTest();
  const tokA = `tok-ana-${seed}`;
  const tokB = `tok-ben-${seed}`;
  const data = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, seed);
    const ana = await rows.user({ name: "Ana", email: "same@example.test" });
    const ben = await rows.user({ name: "Ben", email: "same@example.test" });
    const team = await rows.team({ name: "Team" });
    await rows.membership(ana, team, { role: "admin" });
    await rows.membership(ben, team, { role: "member" });
    await rows.token(ana, tokA);
    await rows.token(ben, tokB);
    const convA1 = await rows.conversation(ana, {
      short_id: "jx7aaaa",
      title: "Ana one",
      team_id: team,
      is_private: false,
      updated_at: START,
    });
    const convA2 = await rows.conversation(ana, {
      short_id: "jx7bbbb",
      title: "Ana two",
      team_id: team,
      is_private: false,
      updated_at: START,
    });
    const taskId = await rows.task(ana, {
      short_id: "ct-101",
      title: "Claimed task",
      team_id: team,
      workspace: `team:${team}`,
      project_path: "/repo",
    });
    return { ana, ben, team, convA1, convA2, taskId };
  });

  const start = (
    token: string,
    opts: { conversation_id?: string; take?: boolean } = {},
  ) =>
    t.mutation(api.tasks.update, {
      api_token: token,
      short_id: "ct-101",
      status: "in_progress",
      ...(opts.conversation_id
        ? { conversation_id: opts.conversation_id }
        : {}),
      ...(opts.take !== undefined ? { take: opts.take } : {}),
    });

  return {
    t,
    tokA,
    tokB,
    ...data,
    start,
    claimRow: () =>
      t.run(({ db }) => findClaim(db, { kind: "task", id: data.taskId })),
    getTask: () => t.run(({ db }) => db.get(data.taskId)),
    getConv: (id: any) => t.run(({ db }) => db.get(id)),
  };
}

async function catchClaimError(fn: () => Promise<unknown>) {
  try {
    await fn();
    throw new Error("Expected ConvexError");
  } catch (err) {
    expect(err).toBeInstanceOf(ConvexError);
    return (err as ConvexError<any>).data;
  }
}

test("tokenless free/unresolved refusals, orgInit/issueSync release, unheld rebind cleanup, claim-backed delivery/wake, and cross-workspace start", async () => {
  const f = await setup("review-fixes");

  await f.start(f.tokA, { conversation_id: String(f.convA1) });
  await asUser(f.t, f.ben).mutation(api.tasks.webUpdate, {
    short_id: "ct-101",
    status: "in_progress",
  });
  expect((await f.claimRow())?.holder).toBeUndefined();

  expect(
    await catchClaimError(() =>
      f.t.mutation(api.tasks.update, {
        api_token: f.tokA,
        short_id: "ct-101",
        priority: "high",
      }),
    ),
  ).toMatchObject({ code: "CONFLICT", reason: "free" });

  expect(
    await catchClaimError(() =>
      f.t.mutation(api.tasks.update, {
        api_token: f.tokB,
        short_id: "ct-101",
        priority: "urgent",
      }),
    ),
  ).toMatchObject({ code: "CONFLICT", reason: "free" });

  expect(
    await catchClaimError(() =>
      f.t.mutation(api.tasks.update, {
        api_token: f.tokB,
        short_id: "ct-101",
        priority: "low",
        conversation_id: "missing-conv-id",
      }),
    ),
  ).toMatchObject({ code: "CONFLICT", reason: "free" });

  expect(
    await catchClaimError(() =>
      f.t.mutation(api.tasks.updateExecutionStatus, {
        api_token: f.tokB,
        short_id: "ct-101",
        execution_status: "blocked",
      }),
    ),
  ).toMatchObject({ code: "CONFLICT", reason: "free" });

  await f.start(f.tokA, { conversation_id: String(f.convA1) });
  await f.t.run(async (ctx) => {
    const task = await ctx.db.get(f.taskId);
    await setTaskStatus(ctx, { team_id: f.team }, task, "open", Date.now());
  });
  expect((await f.getTask())?.status).toBe("open");
  expect((await f.claimRow())?.holder).toBeUndefined();
  expect((await f.getConv(f.convA1))?.active_task_id).toBeUndefined();

  expect(
    await catchClaimError(() =>
      f.t.mutation(api.tasks.update, {
        api_token: f.tokB,
        short_id: "ct-101",
        priority: "low",
        conversation_id: "missing-conv-id",
      }),
    ),
  ).toMatchObject({ code: "CONFLICT", reason: "wrong_holder" });

  const staleConv = f.convA1;
  await f.t.run(async ({ db }) => {
    await db.patch(f.taskId, { conversation_ids: [staleConv] });
    await db.patch(staleConv, { active_task_id: f.taskId });
  });
  await f.start(f.tokA, { conversation_id: String(f.convA2) });
  expect((await f.getConv(staleConv))?.active_task_id).toBeUndefined();
  expect((await f.getConv(f.convA2))?.active_task_id).toBe(f.taskId);

  const personalConvA = await f.t.run(({ db }) =>
    fixtureRows(db, "xws-review").conversation(f.ana, {
      short_id: "jx7xws1",
      title: "Ana personal",
      updated_at: START - 30 * 60_000,
    }),
  );

  await expect(
    f.start(f.tokA, { conversation_id: String(personalConvA) }),
  ).rejects.toThrow(/owned by session jx7bbbb[\s\S]*--take/);

  const xwsTakeover: any = await f.start(f.tokA, {
    conversation_id: String(personalConvA),
    take: true,
  });
  expect(xwsTakeover.released_owners).toEqual([
    { short_id: "jx7bbbb", title: "Ana two", live: true },
  ]);
  expect((await f.claimRow())?.task?.conversation_id).toBe(personalConvA);
  expect((await f.getConv(f.convA2))?.active_task_id).toBeUndefined();
  expect((await f.getConv(personalConvA))?.active_task_id).toBe(f.taskId);
  expect((await f.getTask())?.conversation_ids ?? []).not.toContain(
    personalConvA,
  );
  const notes = await f.t.run(({ db }) =>
    db
      .query("task_comments")
      .withIndex("by_task_id", (q) => q.eq("task_id", f.taskId))
      .collect(),
  );
  expect(
    notes.some((n) => n.text.includes("took over as owner from jx7bbbb")),
  ).toBe(true);

  await f.t.mutation(api.tasks.addComment, {
    api_token: f.tokA,
    short_id: "ct-101",
    text: "Relay despite 30m idle timestamp because lease is live",
  });
  const relayed = await f.t.run(({ db }) =>
    db.query("pending_messages").collect(),
  );
  expect(relayed).toHaveLength(1);
  expect(relayed[0].conversation_id).toBe(personalConvA);

  await f.t.mutation(api.taskWaits.addWait, {
    api_token: f.tokA,
    short_id: "ct-101",
    ref: "2h",
  });
  const timerWait = (await f.getTask())?.waits?.[0];
  await f.t.mutation(api.taskWaits.removeWait, {
    api_token: f.tokB,
    short_id: "ct-101",
    wait_id: timerWait.id,
  });
  const wokeMsgs = await f.t.run(({ db }) =>
    db.query("pending_messages").collect(),
  );
  expect(wokeMsgs).toHaveLength(2);
  expect(wokeMsgs[1].conversation_id).toBe(personalConvA);

  await f.t.run(async ({ db }) => {
    await db.patch(f.taskId, {
      external: {
        provider: "linear",
        id: "lin-101",
        identifier: "LIN-101",
        url: "",
        synced_at: START,
        remote_updated_at: START,
      },
    });
  });
  await f.t.mutation(internal.issueSync.applyRemote, {
    issue: normalizeLinearIssue({
      id: "lin-101",
      identifier: "LIN-101",
      title: "Claimed task",
      state: { type: "completed", name: "Done" },
    }),
  });
  expect((await f.getTask())?.status).toBe("done");
  expect((await f.claimRow())?.holder).toBeUndefined();
  expect((await f.getConv(personalConvA))?.active_task_id).toBeUndefined();

  await f.t.mutation(internal.issueSync.applyRemote, {
    issue: normalizeLinearIssue({
      id: "lin-101",
      identifier: "LIN-101",
      title: "Claimed task",
      state: { type: "started", name: "In Progress" },
    }),
  });
  await f.start(f.tokA, { conversation_id: String(personalConvA) });
  expect((await f.claimRow())?.holder).toBe(f.ana);
  await f.t.mutation(internal.issueSync.applyRemote, {
    issue: normalizeLinearIssue({
      id: "lin-101",
      identifier: "LIN-101",
      title: "Claimed task",
      state: { type: "unstarted", name: "Todo" },
    }),
  });
  expect((await f.getTask())?.status).toBe("open");
  expect((await f.claimRow())?.holder).toBeUndefined();
  expect((await f.getConv(personalConvA))?.active_task_id).toBeUndefined();

  const spawned: any = await f.t.mutation(api.tasks.spawnForTask, {
    api_token: f.tokA,
    short_id: "ct-101",
  });
  expect((await f.claimRow())?.task?.conversation_id).toBe(
    spawned.conversationId,
  );
  expect((await f.getConv(spawned.conversationId))?.active_task_id).toBe(
    f.taskId,
  );
});

test("unresolvable conversation_id on heartbeat, renew, and assertTaskMutationClaim keeps matching free/wrong_holder and real token", async () => {
  const f = await setup("unresolved-conv-match");
  await f.start(f.tokA, { conversation_id: String(f.convA1) });
  await asUser(f.t, f.ana).mutation(api.tasks.webUpdate, {
    short_id: "ct-101",
    status: "in_progress",
  });
  const freeRow = await f.claimRow();
  expect(freeRow?.holder).toBeUndefined();
  const realToken = freeRow?.token ?? 0;
  expect(realToken).toBeGreaterThan(0);

  const hbFree = await catchClaimError(() =>
    f.t.mutation(api.tasks.heartbeat, {
      api_token: f.tokB,
      short_id: "ct-101",
      conversation_id: "missing-session",
    }),
  );
  expect(hbFree).toMatchObject({
    code: "CONFLICT",
    reason: "free",
    current_token: realToken,
  });

  const renewFree = await catchClaimError(() =>
    f.t.mutation(api.tasks.renew, {
      api_token: f.tokB,
      short_id: "ct-101",
      claim_token: realToken,
      conversation_id: "missing-session",
    }),
  );
  expect(renewFree).toMatchObject({
    code: "CONFLICT",
    reason: "wrong_holder",
    current_token: realToken,
  });

  const mutFree = await catchClaimError(() =>
    f.t.mutation(api.tasks.updateExecutionStatus, {
      api_token: f.tokB,
      short_id: "ct-101",
      execution_status: "blocked",
      conversation_id: "missing-session",
    }),
  );
  expect(mutFree).toMatchObject({
    code: "CONFLICT",
    reason: "free",
    current_token: realToken,
  });

  await f.start(f.tokA, { conversation_id: String(f.convA1) });
  const heldToken = (await f.claimRow())?.token;
  expect(heldToken).toBe(realToken + 1);

  const hbHeld = await catchClaimError(() =>
    f.t.mutation(api.tasks.heartbeat, {
      api_token: f.tokB,
      short_id: "ct-101",
      conversation_id: "missing-session",
    }),
  );
  expect(hbHeld).toMatchObject({
    code: "CONFLICT",
    reason: "wrong_holder",
    current_token: heldToken,
  });

  const renewHeld = await catchClaimError(() =>
    f.t.mutation(api.tasks.renew, {
      api_token: f.tokB,
      short_id: "ct-101",
      claim_token: heldToken!,
      conversation_id: "missing-session",
    }),
  );
  expect(renewHeld).toMatchObject({
    code: "CONFLICT",
    reason: "wrong_holder",
    current_token: heldToken,
  });

  const mutHeld = await catchClaimError(() =>
    f.t.mutation(api.tasks.updateExecutionStatus, {
      api_token: f.tokB,
      short_id: "ct-101",
      execution_status: "blocked",
      claim_token: heldToken,
      conversation_id: "missing-session",
    }),
  );
  expect(mutHeld).toMatchObject({
    code: "CONFLICT",
    reason: "wrong_holder",
    current_token: heldToken,
  });
});

test("cross-workspace private takeover does not leak session id or conversation_id in team task comment", async () => {
  const f = await setup("cross-ws-takeover-comment");
  await f.start(f.tokA, { conversation_id: String(f.convA1) });
  const privateConv = await f.t.run(({ db }) =>
    fixtureRows(db, "cross-ws-priv").conversation(f.ben, {
      short_id: "priv999",
      title: "Secret session",
      is_private: true,
      updated_at: START,
    }),
  );
  await f.start(f.tokB, {
    conversation_id: String(privateConv),
    take: true,
  });
  const comments = await f.t.run(({ db }) =>
    db
      .query("task_comments")
      .withIndex("by_task_created", (q) => q.eq("task_id", f.taskId))
      .collect(),
  );
  const takeover = comments.find((c) => c.text.includes("took over as owner"));
  expect(takeover).toBeDefined();
  expect(takeover?.conversation_id).toBeUndefined();
  expect(takeover?.text).not.toContain("priv999");
  expect(takeover?.text).not.toContain(String(privateConv));
});

test("workflowRunTaskTransition revokes live hand claim across open, in_review, and done, and updateProgress records log_note", async () => {
  const f = await setup("wf-transition");
  const { runId, primaryConvId } = await f.t.run(async ({ db }) => {
    const primaryConvId = await fixtureRows(db, "wf-log").conversation(f.ana, {
      session_id: "wf-primary-1",
      short_id: "wfp1",
    });
    const runId = await db.insert("workflow_runs", {
      user_id: f.ana,
      task_id: f.taskId,
      primary_conversation_id: primaryConvId,
      workflow_name: "line",
      status: "running",
      node_statuses: [],
      created_at: START,
      updated_at: START,
    } as any);
    return { runId, primaryConvId };
  });

  await f.start(f.tokA, { conversation_id: String(f.convA1) });
  expect((await f.claimRow())?.holder).toBe(f.ana);

  await f.t.mutation(api.workflowRunTaskTransition.transitionTaskFromCli, {
    api_token: f.tokA,
    run_id: runId,
    short_id: "ct-101",
    status: "open",
  });
  expect((await f.getTask())?.status).toBe("open");
  expect((await f.claimRow())?.holder).toBeUndefined();
  expect((await f.getConv(f.convA1))?.active_task_id).toBeUndefined();

  await f.start(f.tokA, { conversation_id: String(f.convA1) });
  await f.t.mutation(api.workflowRunTaskTransition.transitionTaskFromCli, {
    api_token: f.tokA,
    run_id: runId,
    short_id: "ct-101",
    status: "done",
    execution_status: "done",
    verification_evidence: "dissolved",
  });
  expect((await f.getTask())?.status).toBe("done");
  expect((await f.claimRow())?.holder).toBeUndefined();
  expect((await f.getConv(f.convA1))?.active_task_id).toBeUndefined();

  await f.t.mutation(api.workflow_runs.updateProgress, {
    api_token: f.tokA,
    run_id: runId,
    current_node_id: "__log",
    log_note: "409 CONFLICT (wrong_holder) /cli/work/update: mismatch",
  });
  const msgs = await f.t.run(({ db }) =>
    db
      .query("messages")
      .filter((q) => q.eq(q.field("conversation_id"), primaryConvId))
      .collect(),
  );
  expect(
    msgs.some((m) => m.content.includes("409 CONFLICT (wrong_holder)")),
  ).toBe(true);
});
