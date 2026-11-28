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
