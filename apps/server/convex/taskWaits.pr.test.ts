import { describe, expect, test } from "bun:test";
import {
  REPO,
  USER,
  owner,
  pr,
  setup,
  task,
  waitClock,
} from "../test-helpers/taskWaits.testkit";
import { internal } from "./_generated/api";
import { firePrTrigger, patchPullRequest } from "./prShepherd";

waitClock();

describe("PR events", () => {
  test("a merge meets the wait, unblocks the task and wakes the session that owns it", async () => {
    const c = await setup({
      tasks: [
        task("ct-1", {
          status: "in_progress",
          conversation_ids: ["conv_owner"],
        }),
      ],
      conversations: [owner("ct-1")],
      pull_requests: [pr(42)],
    });
    await c.add({ short_id: "ct-1", ref: `${REPO}#42` });
    expect((await c.read("pull_requests"))[0].waiting_task_ids).toEqual([
      c.id("ct-1"),
    ]);
    await c.movePr(42, { state: "merged" });

    expect((await c.row("ct-1")).waits[0]).toMatchObject({
      state: "met",
      note: "merged",
    });
    expect((await c.row("ct-1")).waiting_since).toBeUndefined();
    expect(await c.comments("ct-1")).toEqual([
      "note: Unblocked: PR #42 merged",
    ]);
    expect(await c.wakes()).toHaveLength(1);
    expect((await c.wakes())[0]).toContain(
      'ct-1 ("Task ct-1") is unblocked: PR #42 merged',
    );
    expect((await c.read("pull_requests"))[0].waiting_task_ids).toEqual([]);

    await c.t.mutation(internal.taskWaits.settlePr, {
      pr_id: c.pullRequests.pr_42,
    });
    expect(await c.comments("ct-1")).toHaveLength(1);
    expect(await c.wakes()).toHaveLength(1);
  });

  test("the webhook's trigger fan-out no longer settles waits inline", async () => {
    const c = await setup({
      tasks: [task("ct-1")],
      pull_requests: [pr(42)],
    });
    await c.add({ short_id: "ct-1", ref: `${REPO}#42` });
    await c.t.run(async (ctx) =>
      firePrTrigger(ctx, "pr_merged", {
        ...(await ctx.db.get(c.pullRequests.pr_42))!,
        state: "merged",
      }),
    );
    expect((await c.row("ct-1")).waits[0].state).toBe("waiting");
  });

  test("a close without merging fails the wait, which keeps blocking and asks the owner to re-plan", async () => {
    const c = await setup({
      tasks: [task("ct-1", { conversation_ids: ["conv_owner"] })],
      conversations: [owner("ct-1")],
      pull_requests: [pr(42)],
    });
    await c.add({ short_id: "ct-1", ref: `${REPO}#42` });
    await c.movePr(42, { state: "closed" });

    expect((await c.row("ct-1")).waits[0]).toMatchObject({
      state: "failed",
      note: "closed without merging",
    });
    expect(await c.comments("ct-1")).toEqual([
      `blocker: Still blocked: PR ${REPO}#42 closed without merging, so this wait can no longer clear.`,
    ]);
    expect((await c.wakes())[0]).toContain("needs a new plan");
    expect((await c.wakes())[0]).toContain(
      `cast task dep ct-1 --remove-blocked-by ${REPO}#42`,
    );
    const history = (await c.read("task_history"))
      .filter((h: any) => h.field === "waits")
      .map((h: any) => h.new_value);
    expect(history.at(-1)).toBe(
      "Wait on PR #42 failed: closed without merging",
    );
  });

  test("a wait added again on a failed target replaces it, so the reopened PR's merge unblocks the task", async () => {
    const c = await setup({
      tasks: [task("ct-1", { conversation_ids: ["conv_owner"] })],
      conversations: [owner("ct-1")],
      pull_requests: [pr(42)],
    });
    await c.add({ short_id: "ct-1", ref: `${REPO}#42` });
    await c.movePr(42, { state: "closed" });
    await c.movePr(42, { state: "open" });
    await c.add({ short_id: "ct-1", ref: "#42" });
    expect((await c.row("ct-1")).waits.map((w: any) => w.state)).toEqual([
      "waiting",
    ]);
    await c.movePr(42, { state: "merged" });
    expect((await c.comments("ct-1")).at(-1)).toBe(
      "note: Unblocked: PR #42 merged",
    );
    expect((await c.wakes()).at(-1)).toContain("PR #42 merged");
  });

  test("a replacement met at once unblocks the task the way a settle does", async () => {
    const c = await setup({
      tasks: [task("ct-1", { conversation_ids: ["conv_owner"] })],
      conversations: [owner("ct-1")],
      pull_requests: [pr(42, { checks_state: "pending" })],
    });
    await c.add({ short_id: "ct-1", ref: `${REPO}#42:checks` });
    await c.movePr(42, { state: "closed" });
    await c.movePr(42, { state: "open", checks_state: "success" });
    await c.add({ short_id: "ct-1", ref: `${REPO}#42:checks` });
    expect((await c.row("ct-1")).waits).toHaveLength(1);
    expect((await c.row("ct-1")).waits[0]).toMatchObject({
      state: "met",
      note: "already green",
    });
    expect((await c.comments("ct-1")).at(-1)).toBe(
      "note: Unblocked: checks green on #42",
    );
  });

  test("a met checks wait gives way when the checks turn red again, so a new wait holds the task", async () => {
    const c = await setup({
      tasks: [task("ct-1")],
      pull_requests: [pr(42, { checks_state: "pending" })],
    });
    await c.add({ short_id: "ct-1", ref: `${REPO}#42:checks` });
    await c.movePr(42, { checks_state: "success" });
    expect(await c.add({ short_id: "ct-1", ref: "#42:checks" })).toMatchObject({
      met: true,
      wait: { state: "met" },
    });
    expect((await c.row("ct-1")).waits).toHaveLength(1);

    await c.movePr(42, { checks_state: "failure" });
    const res = await c.add({
      short_id: "ct-1",
      ref: "#42:checks",
    });
    expect(res).toMatchObject({ met: false, wait: { state: "waiting" } });
    expect(res.existing).toBeUndefined();
    expect((await c.row("ct-1")).waits.map((w: any) => w.state)).toEqual([
      "waiting",
    ]);
    expect((await c.row("ct-1")).waiting_since).toBeNumber();
    expect((await c.read("pull_requests"))[0].waiting_task_ids).toEqual([
      c.id("ct-1"),
    ]);
    await c.movePr(42, { checks_state: "success" });
    expect((await c.row("ct-1")).waits[0].state).toBe("met");
  });

  test("a wait follows its PR when the repository is renamed", async () => {
    const c = await setup({
      tasks: [task("ct-1")],
      pull_requests: [pr(42)],
    });
    await c.add({ short_id: "ct-1", ref: `${REPO}#42` });
    await c.t.run(({ db }) =>
      db.patch(c.pullRequests.pr_42, { repository: "acme/renamed" }),
    );
    await c.movePr(42, { state: "merged" });
    expect((await c.row("ct-1")).waits[0]).toMatchObject({
      state: "met",
      note: "merged",
    });
    expect((await c.read("pull_requests"))[0].waiting_task_ids).toEqual([]);
  });

  test("checks green meets a checks wait and leaves a merge wait on the same PR waiting", async () => {
    const c = await setup({
      tasks: [task("ct-1")],
      pull_requests: [pr(42)],
    });
    await c.add({ short_id: "ct-1", ref: `${REPO}#42:ci` });
    await c.add({ short_id: "ct-1", ref: `${REPO}#42` });
    await c.movePr(42, { checks_state: "success" });

    const [checks, merge] = (await c.row("ct-1")).waits;
    expect(checks).toMatchObject({ kind: "pr_checks_green", state: "met" });
    expect(merge).toMatchObject({ kind: "pr_merged", state: "waiting" });
    expect(await c.comments("ct-1")).toEqual([]);
    expect((await c.row("ct-1")).waiting_since).toBeNumber();
    expect((await c.read("pull_requests"))[0].waiting_task_ids).toEqual([
      c.id("ct-1"),
    ]);
  });

  test("a wait set before PRs carried a back reference is linked by the backfill, then settles", async () => {
    const c = await setup({
      tasks: [task("ct-1")],
      pull_requests: [pr(42)],
    });
    await c.add({ short_id: "ct-1", ref: `${REPO}#42` });
    await c.t.run(({ db }) =>
      db.patch(c.pullRequests.pr_42, { waiting_task_ids: undefined }),
    );
    expect(
      await c.t.mutation(internal.taskWaits.linkPrWaits, {}),
    ).toMatchObject({
      linked: 1,
      done: true,
    });
    expect(
      await c.t.mutation(internal.taskWaits.linkPrWaits, {}),
    ).toMatchObject({
      linked: 0,
    });
    await c.movePr(42, { state: "merged" });
    expect((await c.row("ct-1")).waits[0].state).toBe("met");
  });

  test("a checks wait fails when its PR merges before going green", async () => {
    const c = await setup({
      tasks: [task("ct-1")],
      pull_requests: [pr(42, { checks_state: "failure" })],
    });
    await c.add({ short_id: "ct-1", ref: `${REPO}#42:checks` });
    await c.movePr(42, { state: "merged" });
    expect((await c.row("ct-1")).waits[0]).toMatchObject({
      state: "failed",
      note: "merged before its checks went green",
    });
    expect((await c.row("ct-1")).waiting_since).toBeUndefined();
    expect((await c.comments("ct-1"))[0]).toStartWith(
      "blocker: Still blocked:",
    );
  });

  test("another repository's PR with the same number leaves the wait alone", async () => {
    const c = await setup({
      tasks: [task("ct-1")],
      pull_requests: [
        pr(42),
        pr(42, { _id: "pr_other", repository: "other/repo" }),
      ],
    });
    await c.add({ short_id: "ct-1", ref: `${REPO}#42` });
    await c.t.run((ctx) =>
      patchPullRequest(ctx, c.pullRequests.pr_other, { state: "merged" }),
    );
    await c.t.mutation(internal.taskWaits.settlePr, {
      pr_id: c.pullRequests.pr_other,
    });
    expect((await c.row("ct-1")).waits[0].state).toBe("waiting");
  });

  test("a PR its task no longer reaches fails the wait instead of holding it forever", async () => {
    const c = await setup({
      tasks: [task("ct-1")],
      pull_requests: [pr(42)],
    });
    await c.add({ short_id: "ct-1", ref: `${REPO}#42` });
    await c.t.run(({ db }) =>
      db.patch(c.pullRequests.pr_42, { team_id: c.otherTeam }),
    );
    await c.movePr(42, { state: "merged" });
    expect((await c.row("ct-1")).waits[0]).toMatchObject({
      state: "failed",
      note: "belongs to a team the task left",
    });
    expect((await c.read("pull_requests"))[0].waiting_task_ids).toEqual([]);
    expect((await c.comments("ct-1"))[0]).toStartWith(
      "blocker: Still blocked:",
    );
  });

  test("with no owning session, a person assigned the task is notified", async () => {
    const c = await setup({
      tasks: [task("ct-1", { assignee: "u_bob" })],
      pull_requests: [pr(42)],
    });
    await c.add({ short_id: "ct-1", ref: `${REPO}#42` });
    await c.movePr(42, { state: "merged" });
    expect(await c.wakes()).toEqual([]);
    expect(
      (await c.read("notifications")).map((n) => [
        n.type,
        n.recipient_user_id,
        n.message,
      ]),
    ).toEqual([["task_unblocked", c.bob, "ct-1 is unblocked: PR #42 merged"]]);
  });
});

describe("an owner that refuses messages", () => {
  const refusing = (shortId: string) => ({
    conversations: [
      { ...owner(shortId), execution_protocol_state: "legacy-quiescing" },
    ],
    conversation_execution_heads: [
      {
        _id: "head_1",
        conversation_id: "conv_owner",
        protocol_state: "legacy-quiescing",
      },
    ],
  });

  test("the wait still settles, and the person assigned is told instead", async () => {
    const c = await setup({
      tasks: [
        task("ct-1", { conversation_ids: ["conv_owner"], assignee: "u_bob" }),
      ],
      pull_requests: [pr(42)],
      ...refusing("ct-1"),
    });
    await c.add({ short_id: "ct-1", ref: `${REPO}#42` });
    await c.movePr(42, { state: "merged" });
    expect((await c.row("ct-1")).waits[0]).toMatchObject({ state: "met" });
    expect(await c.comments("ct-1")).toEqual([
      "note: Unblocked: PR #42 merged",
    ]);
    expect(await c.wakes()).toEqual([]);
    expect(
      (await c.read("notifications")).map((n) => [n.type, n.recipient_user_id]),
    ).toEqual([["task_unblocked", c.bob]]);
  });

  test("a person's close of the blocker still lands", async () => {
    const c = await setup({
      tasks: [
        task("ct-1", { blocks: ["ct-2"] }),
        task("ct-2", {
          blocked_by: ["ct-1"],
          conversation_ids: ["conv_owner"],
        }),
      ],
      ...refusing("ct-2"),
    });
    await c.update({ short_id: "ct-1", status: "done" });
    expect((await c.row("ct-1")).status).toBe("done");
    expect(await c.comments("ct-2")).toEqual(["note: Unblocked: ct-1 done"]);
  });

  test("a wake is a machine's, so it acknowledges no assignment ping", async () => {
    const c = await setup({
      tasks: [task("ct-1", { conversation_ids: ["conv_owner"] })],
      conversations: [owner("ct-1")],
      session_owners: [
        {
          _id: "so_1",
          conversation_id: "conv_owner",
          user_id: USER,
          added_by: "u_bob",
        },
      ],
      pull_requests: [pr(42)],
    });
    await c.add({ short_id: "ct-1", ref: `${REPO}#42` });
    await c.movePr(42, { state: "merged" });
    expect((await c.read("pending_messages")).map((m) => m.origin)).toEqual([
      "scheduler",
    ]);
    expect((await c.read("session_owners"))[0].seen_at).toBeUndefined();
  });
});
