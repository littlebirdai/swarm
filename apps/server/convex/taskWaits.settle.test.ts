import { describe, expect, test } from "bun:test";
import {
  REPO,
  decision,
  owner,
  pr,
  setup,
  task,
  waitClock,
} from "../test-helpers/taskWaits.testkit";
import { internal } from "./_generated/api";

waitClock();

describe("decision waits", () => {
  test("answering meets the wait with the answer; reopening puts it back to waiting", async () => {
    const c = await setup({
      tasks: [task("ct-1")],
      session_decisions: [decision(4)],
    });
    await c.add({ short_id: "ct-1", ref: "sd-4" });
    expect((await c.read("session_decisions"))[0].waiting_task_ids).toEqual([
      c.id("ct-1"),
    ]);

    await c.answer(4, { status: "answered", answer_index: 0 });
    expect((await c.row("ct-1")).waits[0]).toMatchObject({
      state: "met",
      note: "answered: Ship it",
    });
    expect(await c.comments("ct-1")).toEqual([
      "note: Unblocked: sd-4 answered: Ship it",
    ]);

    await c.roleAnswer(4);
    expect((await c.reopen(4)).reopened).toBe(true);
    const wait = (await c.row("ct-1")).waits[0];
    expect(wait.state).toBe("waiting");
    expect("note" in wait || "settled_at" in wait).toBe(false);
    expect((await c.row("ct-1")).waiting_since).toBeNumber();
    expect((await c.comments("ct-1")).at(-1)).toBe(
      "note: Waiting again: sd-4 was reopened, so its answer no longer stands.",
    );
  });

  test("withdrawing fails the wait", async () => {
    const c = await setup({
      tasks: [task("ct-1")],
      session_decisions: [decision(4)],
    });
    await c.add({ short_id: "ct-1", ref: "sd-4" });
    await c.withdraw(4);
    await c.drain();
    expect((await c.row("ct-1")).waits[0]).toMatchObject({
      state: "failed",
      note: "withdrawn",
    });
    expect(await c.comments("ct-1")).toEqual([
      "blocker: Still blocked: sd-4 withdrawn, so this wait can no longer clear.",
    ]);
  });

  test("an answered decision is met at once; a dismissed one is refused", async () => {
    const c = await setup({
      tasks: [task("ct-1")],
      session_decisions: [
        decision(4, { status: "answered", answer_index: 1 }),
        decision(5, { status: "dismissed" }),
      ],
    });
    expect((await c.add({ short_id: "ct-1", ref: "sd-4" })).wait).toMatchObject(
      { state: "met", note: "already answered: Hold" },
    );
    await expect(c.add({ short_id: "ct-1", ref: "sd-5" })).rejects.toThrow(
      /dismissed/,
    );
    await expect(c.add({ short_id: "ct-1", ref: "sd-6" })).rejects.toThrow(
      /No decision sd-6/,
    );
  });
});

describe("time waits", () => {
  test("a time wait schedules its job, which meets it; a removed wait is left alone", async () => {
    const c = await setup({
      tasks: [task("ct-1"), task("ct-2")],
    });
    const { wait } = await c.add({ short_id: "ct-1", ref: "2h" });
    expect(await c.timed()).toEqual([
      {
        at: wait.at,
        args: { task_id: c.id("ct-1"), wait_id: wait.id, at: wait.at },
      },
    ]);
    await c.t.mutation(
      internal.taskWaits.settleTimeWait,
      (await c.timed())[0].args,
    );
    expect((await c.row("ct-1")).waits[0]).toMatchObject({
      state: "met",
      note: "passed",
    });
    expect((await c.comments("ct-1"))[0]).toMatch(
      /^note: Unblocked: .* passed$/,
    );

    const second = await c.add({ short_id: "ct-2", ref: "3d" });
    await c.remove({ short_id: "ct-2", wait_id: second.wait.id });
    await c.t.mutation(
      internal.taskWaits.settleTimeWait,
      (await c.timed())[1].args,
    );
    expect((await c.row("ct-2")).waits).toEqual([]);
    expect(await c.comments("ct-2")).toEqual([
      expect.stringMatching(
        /^note: Unblocked: User removed the wait until .*UTC$/,
      ),
    ]);
  });

  test("a date with the person's zone lands on their wall time", async () => {
    const c = await setup({ tasks: [task("ct-1")] });
    const { wait } = await c.add({
      short_id: "ct-1",
      ref: "2099-01-15T09:00",
      time_zone: "America/New_York",
    });
    expect(new Date(wait.at).toISOString()).toBe("2099-01-15T14:00:00.000Z");
  });
});

describe("blocker tasks closing", () => {
  test("the last open blocker closing unblocks its dependent once; an earlier one does not", async () => {
    const c = await setup({
      tasks: [
        task("ct-1", { blocks: ["ct-3"] }),
        task("ct-2", { blocks: ["ct-3"] }),
        task("ct-3", {
          blocked_by: ["ct-1", "ct-2"],
          conversation_ids: ["conv_owner"],
        }),
      ],
      conversations: [owner("ct-3")],
    });
    await c.update({ short_id: "ct-1", status: "done" });
    expect(await c.comments("ct-3")).toEqual([]);
    await c.update({ short_id: "ct-2", status: "dropped" });
    expect(await c.comments("ct-3")).toEqual(["note: Unblocked: ct-2 dropped"]);
    expect(await c.wakes()).toHaveLength(1);
    await c.update({ short_id: "ct-2", status: "done" });
    expect(await c.comments("ct-3")).toHaveLength(1);
  });

  test("a dependent that still has a wait stays blocked when its blocker task closes", async () => {
    const c = await setup({
      tasks: [
        task("ct-1", { blocks: ["ct-2"] }),
        task("ct-2", { blocked_by: ["ct-1"] }),
      ],
      pull_requests: [pr(42)],
    });
    await c.add({ short_id: "ct-2", ref: `${REPO}#42` });
    await c.update({ short_id: "ct-1", status: "done" });
    expect(await c.comments("ct-2")).toEqual([]);
    await c.movePr(42, { state: "merged" });
    expect(await c.comments("ct-2")).toEqual([
      "note: Unblocked: PR #42 merged",
    ]);
  });

  test("a plan mate missing from the blocks mirror is unblocked too, also one naming it by _id", async () => {
    const c = await setup({
      tasks: [
        task("ct-1", { plan_id: "plan_1" }),
        task("ct-2", { plan_id: "plan_1", blocked_by: ["ct-1"] }),
        task("ct-3", { plan_id: "plan_1", blocked_by: ["task_ct-1"] }),
      ],
    });
    await c.update({ short_id: "ct-1", status: "done" });
    expect([await c.comments("ct-2"), await c.comments("ct-3")]).toEqual([
      ["note: Unblocked: ct-1 done"],
      ["note: Unblocked: ct-1 done"],
    ]);
  });

  test("an update that drops the last open blocker releases it, from either side", async () => {
    const c = await setup({
      tasks: [
        task("ct-1", { blocks: ["ct-2", "ct-3"] }),
        task("ct-2", { blocked_by: ["ct-1"] }),
        task("ct-3", { blocked_by: ["ct-1"] }),
      ],
    });
    await c.update({ short_id: "ct-2", blocked_by: [] });
    expect(await c.comments("ct-2")).toEqual([
      "note: Unblocked: the blocker ct-1 was removed",
    ]);
    await c.update({ short_id: "ct-1", blocks: [] });
    expect(
      (await c.read("tasks")).find((t) => t.short_id === "ct-3").blocked_by,
    ).toEqual([]);
    expect(await c.comments("ct-3")).toEqual([
      "note: Unblocked: the blocker ct-1 was removed",
    ]);
  });

  test("an overwrite that swaps an open blocker for a finished one releases it", async () => {
    const c = await setup({
      tasks: [
        task("ct-1", { blocks: ["ct-2"] }),
        task("ct-2", { blocked_by: ["ct-1"] }),
        task("ct-3", { status: "done" }),
      ],
    });
    await c.update({ short_id: "ct-2", blocked_by: ["ct-3"] });
    expect(await c.comments("ct-2")).toEqual([
      "note: Unblocked: the blocker ct-1 was removed",
    ]);
  });
});
