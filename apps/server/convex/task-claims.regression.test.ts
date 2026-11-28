import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { ConvexError } from "convex/values";
import { asUser, serverTest } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { api } from "./_generated/api";
import { findClaim, TASK_LEASE_MS } from "./lib/claims";

const START = 1_800_000_000_000;
const PREVIOUS_FLAG = process.env.SWARM_TASK_CLAIMS;

function advance(ms: number) {
  jest.advanceTimersByTime(ms);
}

beforeEach(() => {
  process.env.SWARM_TASK_CLAIMS = "1";
  jest.useFakeTimers();
  jest.setSystemTime(START);
});

afterEach(() => {
  jest.useRealTimers();
  if (PREVIOUS_FLAG === undefined) delete process.env.SWARM_TASK_CLAIMS;
  else process.env.SWARM_TASK_CLAIMS = PREVIOUS_FLAG;
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
    await db.insert("directory_team_mappings", {
      user_id: ben,
      path_prefix: "/repo",
      team_id: team,
      auto_share: true,
      created_at: START,
    });
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
    const convB = await rows.conversation(ben, {
      short_id: "jx7cccc",
      title: "Ben one",
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
    const secondTaskId = await rows.task(ana, {
      short_id: "ct-102",
      title: "Second task",
      team_id: team,
      workspace: `team:${team}`,
      project_path: "/repo",
    });
    return { ana, ben, team, convA1, convA2, convB, taskId, secondTaskId };
  });

  const start = (
    token: string,
    opts: {
      short_id?: string;
      conversation_id?: string;
      take?: boolean;
      claim_token?: number;
      claim_request_id?: string;
    } = {},
  ) =>
    t.mutation(api.tasks.update, {
      api_token: token,
      short_id: opts.short_id ?? "ct-101",
      status: "in_progress",
      ...(opts.conversation_id
        ? { conversation_id: opts.conversation_id }
        : {}),
      ...(opts.take !== undefined ? { take: opts.take } : {}),
      ...(opts.claim_token !== undefined
        ? { claim_token: opts.claim_token }
        : {}),
      ...(opts.claim_request_id !== undefined
        ? { claim_request_id: opts.claim_request_id }
        : {}),
    });

  const renew = (token: string, claimToken: number, conversationId?: string) =>
    t.mutation(api.tasks.renew, {
      api_token: token,
      short_id: "ct-101",
      claim_token: claimToken,
      ...(conversationId ? { conversation_id: conversationId } : {}),
    });

  const release = (
    token: string,
    claimToken: number,
    conversationId?: string,
  ) =>
    t.mutation(api.tasks.release, {
      api_token: token,
      short_id: "ct-101",
      claim_token: claimToken,
      ...(conversationId ? { conversation_id: conversationId } : {}),
    });

  const done = (
    token: string,
    opts: {
      claim_token?: number;
      conversation_id?: string;
      short_id?: string;
    } = {},
  ) =>
    t.mutation(api.tasks.update, {
      api_token: token,
      short_id: opts.short_id ?? "ct-101",
      status: "done",
      ...(opts.claim_token !== undefined
        ? { claim_token: opts.claim_token }
        : {}),
      ...(opts.conversation_id
        ? { conversation_id: opts.conversation_id }
        : {}),
    });

  return {
    t,
    tokA,
    tokB,
    ...data,
    start,
    renew,
    release,
    done,
    claimRow: (taskId = data.taskId) =>
      t.run(({ db }) => findClaim(db, { kind: "task", id: taskId })),
    getTask: (id = data.taskId) => t.run(({ db }) => db.get(id)),
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

test("field writes, verdicts, execution status, and fail-closed conversation refs respect claims", async () => {
  const f = await setup("fields-verdicts");
  const started: any = await f.start(f.tokA, {
    conversation_id: String(f.convA1),
  });
  expect(started.claim_token).toBe(1);

  expect(
    await catchClaimError(() =>
      f.t.mutation(api.tasks.update, {
        api_token: f.tokB,
        short_id: "ct-101",
        priority: "urgent",
      }),
    ),
  ).toMatchObject({ code: "CONFLICT", reason: "wrong_holder" });

  expect(
    await catchClaimError(() =>
      f.t.mutation(api.tasks.update, {
        api_token: f.tokA,
        short_id: "ct-101",
        title: "No session no token",
      }),
    ),
  ).toMatchObject({ code: "CONFLICT", reason: "wrong_holder" });

  expect(
    await catchClaimError(() =>
      f.t.mutation(api.tasks.update, {
        api_token: f.tokA,
        short_id: "ct-101",
        status: "done",
        conversation_id: "missing-conv-id",
      }),
    ),
  ).toMatchObject({ code: "CONFLICT", reason: "wrong_holder" });

  expect(
    await catchClaimError(() =>
      f.t.mutation(api.tasks.update, {
        api_token: f.tokA,
        short_id: "ct-101",
        status: "done",
        review_verdict: "approve",
        conversation_id: String(f.convA2),
      }),
    ),
  ).toMatchObject({ code: "CONFLICT", reason: "wrong_holder" });

  expect(
    await catchClaimError(() =>
      f.t.mutation(api.tasks.updateExecutionStatus, {
        api_token: f.tokA,
        short_id: "ct-101",
        execution_status: "blocked",
      }),
    ),
  ).toMatchObject({ code: "CONFLICT", reason: "wrong_holder" });

  expect(
    await catchClaimError(() =>
      f.t.mutation(api.tasks.incrementRetryCount, {
        api_token: f.tokA,
        short_id: "ct-101",
      }),
    ),
  ).toMatchObject({ code: "CONFLICT", reason: "wrong_holder" });

  expect(
    await catchClaimError(() =>
      f.t.mutation(api.tasks.scheduleRetry, {
        api_token: f.tokA,
        short_id: "ct-101",
      }),
    ),
  ).toMatchObject({ code: "CONFLICT", reason: "wrong_holder" });

  await f.t.mutation(api.tasks.update, {
    api_token: f.tokA,
    short_id: "ct-101",
    priority: "urgent",
    conversation_id: String(f.convA1),
  });
  expect((await f.getTask())?.priority).toBe("urgent");

  await f.t.mutation(api.tasks.updateExecutionStatus, {
    api_token: f.tokA,
    short_id: "ct-101",
    execution_status: "done_with_concerns",
    claim_token: 1,
    conversation_id: String(f.convA1),
  });
  await f.t.mutation(api.tasks.incrementRetryCount, {
    api_token: f.tokA,
    short_id: "ct-101",
    claim_token: 1,
    conversation_id: String(f.convA1),
  });

  await f.t.mutation(api.tasks.update, {
    api_token: f.tokA,
    short_id: "ct-101",
    status: "done",
    review_verdict: "approve",
    claim_token: 1,
    conversation_id: String(f.convA1),
  });
  expect((await f.claimRow())?.holder).toBeUndefined();
  expect((await f.getTask())?.status).toBe("done");
});

test("expired claims refuse all non-acquire writes and reschedule if renewed", async () => {
  const f = await setup("expired-all");
  await f.start(f.tokA, { conversation_id: String(f.convA1) });

  advance(60_000);
  await f.renew(f.tokA, 1, String(f.convA1));
  advance(TASK_LEASE_MS - 60_000);
  await f.t.finishInProgressScheduledFunctions();
  expect((await f.getTask())?.status).toBe("in_progress");
  expect((await f.claimRow())?.holder).toBe(f.ana);

  jest.setSystemTime(START + 60_000 + TASK_LEASE_MS);
  expect(
    await catchClaimError(() =>
      f.t.mutation(api.tasks.update, {
        api_token: f.tokA,
        short_id: "ct-101",
        priority: "high",
        conversation_id: String(f.convA1),
      }),
    ),
  ).toMatchObject({ code: "CONFLICT", reason: "expired" });
  expect(
    await catchClaimError(() =>
      f.t.mutation(api.tasks.update, {
        api_token: f.tokA,
        short_id: "ct-101",
        review_verdict: "approve",
        claim_token: 1,
        conversation_id: String(f.convA1),
      }),
    ),
  ).toMatchObject({ code: "CONFLICT", reason: "expired" });
  expect(
    await catchClaimError(() =>
      f.t.mutation(api.tasks.scheduleRetry, {
        api_token: f.tokA,
        short_id: "ct-101",
        claim_token: 1,
        conversation_id: String(f.convA1),
      }),
    ),
  ).toMatchObject({ code: "CONFLICT", reason: "expired" });

  jest.setSystemTime(START + TASK_LEASE_MS);
  advance(60_000);
  await f.t.finishInProgressScheduledFunctions();
  expect((await f.getTask())?.status).toBe("open");
  expect((await f.claimRow())?.holder).toBeUndefined();
  expect((await f.getConv(f.convA1))?.active_task_id).toBeUndefined();
});

test("cross-workspace starts keep session claim identity, refuse legacy active owners as busy, and reject foreign shared conversations", async () => {
  const f = await setup("xws-and-shared-conv");
  const personalConvA = await f.t.run(async ({ db }) =>
    fixtureRows(db, "xws-conv").conversation(f.ana, {
      short_id: "jx7pppp",
      title: "Personal conv",
      updated_at: START,
    }),
  );

  const started: any = await f.start(f.tokA, {
    conversation_id: String(personalConvA),
  });
  expect(started.claim_token).toBe(1);
  expect((await f.claimRow())?.task?.conversation_id).toBe(personalConvA);

  expect(
    await catchClaimError(() =>
      f.start(f.tokB, { conversation_id: String(f.convA1) }),
    ),
  ).toMatchObject({ code: "CONFLICT", reason: "wrong_holder" });

  expect(
    await catchClaimError(() => f.renew(f.tokB, 1, String(f.convA1))),
  ).toMatchObject({ code: "CONFLICT", reason: "wrong_holder" });

  expect(await catchClaimError(() => f.renew(f.tokA, 1))).toMatchObject({
    code: "CONFLICT",
    reason: "wrong_holder",
  });

  expect(
    await catchClaimError(() =>
      f.done(f.tokB, { conversation_id: String(f.convA1) }),
    ),
  ).toMatchObject({ code: "CONFLICT", reason: "wrong_holder" });

  await f.t.mutation(api.tasks.scheduleRetry, {
    api_token: f.tokA,
    short_id: "ct-101",
    claim_token: 1,
    conversation_id: String(personalConvA),
  });
  expect((await f.getTask())?.status).toBe("open");
  expect((await f.claimRow())?.holder).toBeUndefined();

  await f.t.run(async ({ db }) => {
    await db.patch(f.secondTaskId, {
      status: "in_progress",
      conversation_ids: [f.convA1],
    });
    await db.patch(f.convA1, {
      active_task_id: f.secondTaskId,
      updated_at: Date.now(),
    });
  });
  const legacyErr = await catchClaimError(() =>
    f.start(f.tokB, {
      short_id: "ct-102",
      conversation_id: String(f.convB),
    }),
  );
  expect(legacyErr.code).toBe("CONFLICT");
  expect(legacyErr.reason).toBe("busy");
});

test("in_review, webUpdate, batchUpdateStatus, spawnForTask, managed heartbeat, sessionDelete, and disabled checks work end to end", async () => {
  const f = await setup("lifecycle-all");

  const started: any = await f.start(f.tokA, {
    conversation_id: String(f.convA1),
  });
  expect(started.claim_token).toBe(1);

  await f.t.mutation(api.tasks.update, {
    api_token: f.tokA,
    short_id: "ct-101",
    status: "in_review",
    execution_status: "done",
    verification_evidence: "verified",
    claim_token: 1,
    conversation_id: String(f.convA1),
  });
  expect((await f.getTask())?.status).toBe("in_review");
  expect((await f.claimRow())?.holder).toBeUndefined();

  const taken2: any = await f.start(f.tokA, {
    conversation_id: String(f.convA1),
  });
  expect(taken2.claim_token).toBe(2);
  await asUser(f.t, f.ben).mutation(api.tasks.webUpdate, {
    short_id: "ct-101",
    status: "open",
  });
  expect((await f.getTask())?.status).toBe("open");
  expect((await f.claimRow())?.holder).toBeUndefined();
  expect((await f.getConv(f.convA1))?.active_task_id).toBeUndefined();

  const taken3: any = await f.start(f.tokA, {
    conversation_id: String(f.convA1),
  });
  expect(taken3.claim_token).toBe(3);
  await f.t.mutation(api.tasks.batchUpdateStatus, {
    api_token: f.tokA,
    short_ids: ["ct-101"],
    status: "in_review",
  });
  expect((await f.getTask())?.status).toBe("in_review");
  expect((await f.claimRow())?.holder).toBeUndefined();

  const spawned: any = await f.t.mutation(api.tasks.spawnForTask, {
    api_token: f.tokA,
    short_id: "ct-102",
  });
  expect(typeof spawned.claim_token).toBe("number");
  expect(typeof spawned.lease_until).toBe("number");
  await f.t.mutation(api.managedSessions.registerManagedSession, {
    api_token: f.tokA,
    session_id: spawned.sessionId,
    pid: 1234,
    conversation_id: spawned.conversationId,
    tmux_session: "tmux-spawn-ct102",
  });
  advance(60_000);
  await f.t.mutation(api.managedSessions.heartbeatBatch, {
    api_token: f.tokA,
    sessions: [{ session_id: spawned.sessionId, agent_status: "working" }],
  });
  const spawnedClaimAfterBeat = await f.claimRow(f.secondTaskId);
  expect(spawnedClaimAfterBeat?.lease_until).toBe(spawned.lease_until + 60_000);

  await asUser(f.t, f.ana).mutation(api.sessionDelete.deleteSession, {
    conversation_id: spawned.conversationId,
  });
  expect((await f.claimRow(f.secondTaskId))?.holder).toBeUndefined();

  delete process.env.SWARM_TASK_CLAIMS;
  await expect(f.renew("invalid-token", 1)).rejects.toThrow("Unauthorized");
  await expect(f.release("invalid-token", 1)).rejects.toThrow("Unauthorized");
  await expect(
    f.t.mutation(api.tasks.renew, {
      api_token: f.tokA,
      short_id: "ct-missing",
      claim_token: 1,
    }),
  ).rejects.toThrow("Task not found");
  await expect(
    f.t.mutation(api.tasks.release, {
      api_token: f.tokA,
      short_id: "ct-missing",
      claim_token: 1,
    }),
  ).rejects.toThrow("Task not found");
  expect(await f.renew(f.tokA, 1, String(f.convA1))).toEqual({
    success: false,
    status: "disabled",
  });
});
