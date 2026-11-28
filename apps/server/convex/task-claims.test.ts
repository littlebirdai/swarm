import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { ConvexError } from "convex/values";
import { asUser, serverTest } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { api, internal } from "./_generated/api";
import { claim, findClaim, readClaimToken, TASK_LEASE_MS } from "./lib/claims";
import { claimFrontier } from "./lib/claimFrontier";

const START = 1_800_000_000_000;

function advance(ms: number) {
  jest.advanceTimersByTime(ms);
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(START);
});

afterEach(() => {
  jest.useRealTimers();
});

async function setup(seed = "task-claims") {
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
      claim_purpose?: string;
    } = {},
  ) =>
    t.mutation(api.taskUpdate.update, {
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
      ...(opts.claim_purpose !== undefined
        ? { claim_purpose: opts.claim_purpose }
        : {}),
    });

  const renew = (token: string, claimToken: number, conversationId?: string) =>
    t.mutation(api.taskExecution.renew, {
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
    t.mutation(api.taskExecution.release, {
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
    t.mutation(api.taskUpdate.update, {
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

test("first claim mints token 1, renew extends lease, and stale tokens are refused", async () => {
  const f = await setup("first-and-renew");
  const started: any = await f.start(f.tokA, {
    conversation_id: String(f.convA1),
    claim_request_id: "start-req-1",
    claim_purpose: "implement",
  });
  expect(started.claim_token).toBe(1);
  expect(started.lease_until).toBe(START + TASK_LEASE_MS);

  const row = await f.claimRow();
  expect(row).toMatchObject({
    kind: "task",
    task_id: f.taskId,
    holder: f.ana,
    token: 1,
    lease_until: START + TASK_LEASE_MS,
    purpose: "implement",
    task: { conversation_id: f.convA1 },
  });
  expect((await f.getConv(f.convA1))?.active_task_id).toBe(f.taskId);

  advance(60_000);
  const renewed = await f.renew(f.tokA, 1, String(f.convA1));
  expect(renewed).toMatchObject({
    success: true,
    claim_token: 1,
    lease_until: START + 60_000 + TASK_LEASE_MS,
  });

  const beat: any = await f.t.mutation(api.taskExecution.heartbeat, {
    api_token: f.tokA,
    short_id: "ct-101",
    claim_token: 1,
    conversation_id: String(f.convA1),
    progress_pct: 50,
  });
  expect(beat.claim_token).toBe(1);
  expect((await f.getTask())?.progress_pct).toBe(50);

  expect(
    await catchClaimError(() => f.renew(f.tokA, 99, String(f.convA1))),
  ).toMatchObject({
    code: "CONFLICT",
    reason: "stale_token",
    current_token: 1,
  });
  expect(
    await catchClaimError(() => f.renew(f.tokB, 1, String(f.convB))),
  ).toMatchObject({
    code: "CONFLICT",
    reason: "wrong_holder",
  });
  expect(
    await catchClaimError(() => f.renew(f.tokA, 1, String(f.convA2))),
  ).toMatchObject({
    code: "CONFLICT",
    reason: "wrong_holder",
  });
  expect(
    await catchClaimError(() =>
      f.start(f.tokA, { conversation_id: String(f.convA2) }),
    ),
  ).toMatchObject({
    code: "CONFLICT",
    reason: "busy",
  });

  const sameConvRestart: any = await f.start(f.tokA, {
    conversation_id: String(f.convA1),
  });
  expect(sameConvRestart.claim_token).toBe(1);
  expect(sameConvRestart.released_owners).toBeUndefined();

  const reStarted: any = await f.start(f.tokA, {
    conversation_id: String(f.convA1),
    claim_request_id: "start-req-1",
  });
  expect(reStarted.claim_token).toBe(1);
  expect(reStarted.released_owners).toBeUndefined();
});

test("lease expiry returns task to ready list and new holder claims with token+1 without --take", async () => {
  const f = await setup("expiry-and-ready");
  const first: any = await f.start(f.tokA, {
    conversation_id: String(f.convA1),
  });
  expect(first.claim_token).toBe(1);

  const readyWhileHeld = await f.t.query(api.taskList.list, {
    api_token: f.tokB,
    workspace: "team",
    team_id: f.team,
    ready: true,
  });
  expect(readyWhileHeld.map((t: any) => t.short_id)).toEqual(["ct-102"]);

  jest.setSystemTime(START + TASK_LEASE_MS);

  expect(
    await catchClaimError(() =>
      f.done(f.tokA, { claim_token: 1, conversation_id: String(f.convA1) }),
    ),
  ).toMatchObject({
    code: "CONFLICT",
    reason: "expired",
  });
  expect(
    await catchClaimError(() =>
      f.done(f.tokA, { conversation_id: String(f.convA1) }),
    ),
  ).toMatchObject({
    code: "CONFLICT",
    reason: "expired",
  });

  jest.setSystemTime(START);
  advance(TASK_LEASE_MS);
  await f.t.finishInProgressScheduledFunctions();
  expect((await f.getTask())?.status).toBe("open");
  expect((await f.getConv(f.convA1))?.active_task_id).toBeUndefined();

  const readyAfterExpiry = await f.t.query(api.taskList.list, {
    api_token: f.tokB,
    workspace: "team",
    team_id: f.team,
    ready: true,
  });
  expect(readyAfterExpiry.map((t: any) => t.short_id).sort()).toEqual([
    "ct-101",
    "ct-102",
  ]);
  const apiReady = await f.t.query(api.taskList.getReadyTasks, {
    api_token: f.tokB,
    project_path: "/repo",
  });
  expect(apiReady.map((t: any) => t.short_id).sort()).toEqual([
    "ct-101",
    "ct-102",
  ]);
  const webReady = await asUser(f.t, f.ben).query(api.taskWebList.webList, {
    ready: true,
    workspace: "team",
    team_id: f.team,
  });
  expect(webReady.items.map((t: any) => t.short_id).sort()).toEqual([
    "ct-101",
    "ct-102",
  ]);
  const webPaginated = await asUser(f.t, f.ben).query(
    api.taskWebList.webListPaginated,
    {
      workspace: "team",
      team_id: f.team,
      paginationOpts: { numItems: 50, cursor: null },
    },
  );
  expect(
    webPaginated.page
      .filter((t: any) => t.status === "open")
      .map((t: any) => t.short_id)
      .sort(),
  ).toEqual(["ct-101", "ct-102"]);
  const webTeam = await asUser(f.t, f.ben).query(api.taskWebList.webTeamList, {
    team_id: f.team,
  });
  expect(
    webTeam
      .filter((t: any) => t.status === "open")
      .map((t: any) => t.short_id)
      .sort(),
  ).toEqual(["ct-101", "ct-102"]);

  expect(
    await catchClaimError(() => f.renew(f.tokA, 1, String(f.convA1))),
  ).toMatchObject({
    code: "CONFLICT",
    reason: "free",
  });
  expect(
    await catchClaimError(() =>
      f.done(f.tokA, { claim_token: 1, conversation_id: String(f.convA1) }),
    ),
  ).toMatchObject({
    code: "CONFLICT",
    reason: "free",
  });

  const claimed: any = await f.t.action((ctx) =>
    claimFrontier(ctx, {
      api_token: f.tokB,
      workspace: "team",
      team_id: f.team,
      conversation_id: String(f.convB),
    }),
  );
  expect(claimed.task?.short_id).toBe("ct-101");
  expect(claimed.claim_token).toBe(2);
  expect(typeof claimed.lease_until).toBe("number");

  const row = await f.claimRow();
  expect(row).toMatchObject({
    holder: f.ben,
    token: 2,
    task: { conversation_id: f.convB },
  });
  expect((await f.getConv(f.convA1))?.active_task_id).toBeUndefined();
  expect((await f.getConv(f.convB))?.active_task_id).toBe(f.taskId);

  expect(
    await catchClaimError(() =>
      f.done(f.tokA, { claim_token: 1, conversation_id: String(f.convA1) }),
    ),
  ).toMatchObject({
    code: "CONFLICT",
    reason: "stale_token",
    current_token: 2,
  });
  expect(
    await catchClaimError(() =>
      f.done(f.tokA, { conversation_id: String(f.convA1) }),
    ),
  ).toMatchObject({
    code: "CONFLICT",
    reason: "wrong_holder",
  });
});

test("release frees the task, preserves token, and blocks stale done", async () => {
  const f = await setup("release-and-done");
  const started: any = await f.start(f.tokA, {
    conversation_id: String(f.convA1),
  });
  expect(started.claim_token).toBe(1);

  expect(
    await catchClaimError(() => f.release(f.tokA, 9, String(f.convA1))),
  ).toMatchObject({
    code: "CONFLICT",
    reason: "stale_token",
    current_token: 1,
  });
  expect(
    await catchClaimError(() => f.release(f.tokB, 1, String(f.convB))),
  ).toMatchObject({
    code: "CONFLICT",
    reason: "wrong_holder",
  });

  const rel = await f.release(f.tokA, 1, String(f.convA1));
  expect(rel).toEqual({ success: true, token: 1 });
  expect((await f.getTask())?.status).toBe("open");
  expect((await f.getConv(f.convA1))?.active_task_id).toBeUndefined();

  const rowAfterRelease = await f.claimRow();
  expect(rowAfterRelease?.holder).toBeUndefined();
  expect(rowAfterRelease?.lease_until).toBe(0);
  expect(rowAfterRelease?.token).toBe(1);

  expect(
    await catchClaimError(() =>
      f.done(f.tokA, { claim_token: 1, conversation_id: String(f.convA1) }),
    ),
  ).toMatchObject({
    code: "CONFLICT",
    reason: "free",
  });

  const next: any = await f.start(f.tokB, {
    conversation_id: String(f.convB),
  });
  expect(next.claim_token).toBe(2);

  await f.done(f.tokB, { claim_token: 2, conversation_id: String(f.convB) });
  expect((await f.getTask())?.status).toBe("done");
  expect((await f.claimRow())?.holder).toBeUndefined();
  expect((await f.claimRow())?.token).toBe(2);
});

test("--take revokes active claim, mints token+1, and fences the displaced holder", async () => {
  const f = await setup("takeover");
  await f.start(f.tokA, { conversation_id: String(f.convA1) });

  const taken: any = await f.start(f.tokB, {
    conversation_id: String(f.convB),
    take: true,
  });
  expect(taken.claim_token).toBe(2);
  expect(taken.released_owners).toEqual([
    { short_id: "jx7aaaa", title: "Ana one", live: true },
  ]);
  expect((await f.getConv(f.convA1))?.active_task_id).toBeUndefined();
  expect((await f.getConv(f.convB))?.active_task_id).toBe(f.taskId);

  expect(
    await catchClaimError(() =>
      f.done(f.tokA, { claim_token: 1, conversation_id: String(f.convA1) }),
    ),
  ).toMatchObject({
    code: "CONFLICT",
    reason: "stale_token",
    current_token: 2,
  });
});

test("steer and terminal claims remain unaffected while task claims are active", async () => {
  const f = await setup("coexist");
  await f.start(f.tokA, { conversation_id: String(f.convA1) });
  await f.t.run((ctx) =>
    claim(ctx, {
      kind: "steer",
      id: f.convA1,
      holder: f.ana,
      steering: { mode: "contested" },
      requestId: "steer-req",
      expectedToken: 0,
    }),
  );
  await f.t.run((ctx) =>
    claim(ctx, {
      kind: "terminal",
      id: f.convA1,
      paneInstance: 1,
      holder: f.ana,
      requestId: "term-req",
      expectedToken: 0,
    }),
  );

  expect(
    await f.t.query(({ db }) =>
      readClaimToken(db, { kind: "steer", id: f.convA1 }),
    ),
  ).toBe(1);
  expect(
    await f.t.query(({ db }) =>
      readClaimToken(db, { kind: "terminal", id: f.convA1 }),
    ),
  ).toBe(1);
  expect(
    await f.t.query(({ db }) =>
      readClaimToken(db, { kind: "task", id: f.taskId }),
    ),
  ).toBe(1);
});

test("account deletion and user merge clear task claim holders and preserve tokens", async () => {
  const fDelete = await setup("acct-delete");
  await fDelete.start(fDelete.tokB, {
    conversation_id: String(fDelete.convB),
    claim_purpose: "work",
  });
  await fDelete.t.mutation(internal.accountDelete.purgeAccount, {
    user_id: fDelete.ben,
  });
  expect(await fDelete.t.run(({ db }) => db.get(fDelete.ben))).toBeNull();
  const afterDelete = await fDelete.claimRow();
  expect(afterDelete).toMatchObject({
    kind: "task",
    task_id: fDelete.taskId,
    token: 1,
    lease_until: 0,
  });
  expect(afterDelete).not.toHaveProperty("holder");
  expect(afterDelete).not.toHaveProperty("purpose");
  expect(afterDelete).not.toHaveProperty("task");
  expect(afterDelete).not.toHaveProperty("request_id");
  expect(afterDelete).not.toHaveProperty("request_holder");

  const reClaimed: any = await fDelete.start(fDelete.tokA, {
    conversation_id: String(fDelete.convA1),
  });
  expect(reClaimed.claim_token).toBe(2);

  const fMerge = await setup("user-merge");
  await fMerge.start(fMerge.tokB, {
    conversation_id: String(fMerge.convB),
    claim_purpose: "work",
  });
  const mergeRes: any = await fMerge.t.mutation(
    internal.admin_mergeUser.mergeDuplicateUser,
    {
      from_user_id: fMerge.ben,
      to_user_id: fMerge.ana,
      dry_run: false,
      delete_source: true,
    },
  );
  expect(mergeRes.source_deleted).toBe(true);
  const afterMerge = await fMerge.claimRow();
  expect(afterMerge).toMatchObject({
    kind: "task",
    task_id: fMerge.taskId,
    token: 1,
    lease_until: 0,
  });
  expect(afterMerge).not.toHaveProperty("holder");
  expect(afterMerge).not.toHaveProperty("purpose");
  expect(afterMerge).not.toHaveProperty("task");
  expect(afterMerge).not.toHaveProperty("request_id");
  expect(afterMerge).not.toHaveProperty("request_holder");
});

test("spawnForTask allows the spawned session to run cast task start idempotently", async () => {
  const f = await setup("spawn-then-start");
  const spawned: any = await f.t.mutation(api.taskSpawn.spawnForTask, {
    api_token: f.tokA,
    short_id: "ct-101",
  });
  const firstToken = (await f.claimRow())?.token;
  expect(typeof firstToken).toBe("number");

  const started: any = await f.start(f.tokA, {
    conversation_id: String(spawned.conversationId),
  });
  expect(started.claim_token).toBe(firstToken);
  expect(started.released_owners).toBeUndefined();
});
