import { describe, expect, test } from "bun:test";
import { OTHER, TOKEN, setup, task } from "../test-helpers/taskLinks.testkit";
import { api, internal } from "./_generated/api";
import { addDepCore, moveTaskStatus } from "./tasks";
import { applyPlanStatus } from "./orgInit";
import { normalizeLinearIssue } from "./lib/issueMapping";

describe("duplicate (TG5)", () => {
  test("marking a duplicate moves its dependents to the canonical", async () => {
    const c = await setup([
      task("ct-1", { blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-7"),
    ]);
    await c.actor.mutation(api.tasks.webUpdate, {
      short_id: "ct-1",
      duplicate_of: "ct-7",
    });
    expect((await c.row("ct-1")).duplicate_of).toBe("ct-7");
    expect((await c.row("ct-2")).blocked_by).toEqual(["ct-7"]);
    expect((await c.row("ct-7")).blocks).toEqual(["ct-2"]);
  });

  test("marked with a drop in one write, the moved dependents get no unblocked note", async () => {
    const c = await setup([
      task("ct-1", { blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-7"),
    ]);
    await c.actor.mutation(api.tasks.webUpdate, {
      short_id: "ct-1",
      duplicate_of: "ct-7",
      status: "dropped",
    });
    expect((await c.row("ct-1")).status).toBe("dropped");
    expect((await c.row("ct-2")).blocked_by).toEqual(["ct-7"]);
    expect(await c.comments("ct-2")).toEqual([]);
  });

  test("a done canonical releases the moved dependents with a note", async () => {
    const c = await setup([
      task("ct-1", { blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-7", { status: "done" }),
    ]);
    await c.actor.mutation(api.tasks.webUpdate, {
      short_id: "ct-1",
      duplicate_of: "ct-7",
      status: "dropped",
    });
    expect(await c.comments("ct-2")).toEqual([
      "Unblocked: ct-1 duplicate of ct-7",
    ]);
  });

  test("a done duplicate keeps its released dependents where they are", async () => {
    const c = await setup([
      task("ct-1", { status: "done", blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"], status: "in_progress" }),
      task("ct-7"),
    ]);
    await c.actor.mutation(api.tasks.webUpdate, {
      short_id: "ct-1",
      duplicate_of: "ct-7",
    });
    expect((await c.row("ct-1")).duplicate_of).toBe("ct-7");
    expect((await c.row("ct-2")).blocked_by).toEqual(["ct-1"]);
    expect((await c.row("ct-7")).blocks ?? []).toEqual([]);
  });

  test("undoing a mark (clear plus reopen in one write) puts the dependents back", async () => {
    const c = await setup([
      task("ct-1", { blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-7"),
    ]);
    await c.actor.mutation(api.tasks.webUpdate, {
      short_id: "ct-1",
      duplicate_of: "ct-7",
      status: "dropped",
    });
    await c.actor.mutation(api.tasks.webUpdate, {
      short_id: "ct-1",
      duplicate_of: "",
      status: "open",
    });
    expect((await c.row("ct-2")).blocked_by).toEqual(["ct-1"]);
    expect((await c.row("ct-1")).blocks).toEqual(["ct-2"]);
    expect((await c.row("ct-7")).blocks).toEqual([]);
  });

  test("undone as two writes (reopen, then clear), a released dependent is blocked again and told", async () => {
    const c = await setup([
      task("ct-1", { blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-7", { status: "done" }),
    ]);
    await c.actor.mutation(api.tasks.webUpdate, {
      short_id: "ct-1",
      duplicate_of: "ct-7",
    });
    await c.actor.mutation(api.tasks.webUpdate, {
      short_id: "ct-1",
      status: "dropped",
    });
    await c.actor.mutation(api.tasks.webUpdate, {
      short_id: "ct-1",
      status: "open",
    });
    await c.actor.mutation(api.tasks.webUpdate, {
      short_id: "ct-1",
      duplicate_of: "",
    });
    expect((await c.row("ct-2")).blocked_by).toEqual(["ct-1"]);
    expect((await c.row("ct-7")).blocks).toEqual([]);
    expect(await c.comments("ct-2")).toEqual([
      "Unblocked: ct-1 duplicate of ct-7",
      "Blocked again: ct-1 was reopened, so it waits on ct-1",
    ]);
  });

  test("a mark cleared on an open task takes the dependents back; on a closed one they stay", async () => {
    const c = await setup([
      task("ct-1", { blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-3", { blocks: ["ct-4"] }),
      task("ct-4", { blocked_by: ["ct-3"] }),
      task("ct-7"),
    ]);
    await c.actor.mutation(api.tasks.webUpdate, {
      short_id: "ct-1",
      duplicate_of: "ct-7",
    });
    await c.actor.mutation(api.tasks.webUpdate, {
      short_id: "ct-1",
      duplicate_of: "",
    });
    expect((await c.row("ct-2")).blocked_by).toEqual(["ct-1"]);
    await c.actor.mutation(api.tasks.webUpdate, {
      short_id: "ct-3",
      duplicate_of: "ct-7",
      status: "dropped",
    });
    await c.actor.mutation(api.tasks.webUpdate, {
      short_id: "ct-3",
      duplicate_of: "",
    });
    expect((await c.row("ct-4")).blocked_by).toEqual(["ct-7"]);
  });

  test("undoing one of two duplicates folded into one canonical keeps the other's edge", async () => {
    const c = await setup([
      task("ct-1", { blocks: ["ct-4"] }),
      task("ct-2", { blocks: ["ct-4"] }),
      task("ct-4", { blocked_by: ["ct-1", "ct-2"] }),
      task("ct-7"),
    ]);
    await c.actor.mutation(api.tasks.webUpdate, {
      short_id: "ct-1",
      duplicate_of: "ct-7",
      status: "dropped",
    });
    await c.actor.mutation(api.tasks.webUpdate, {
      short_id: "ct-2",
      duplicate_of: "ct-7",
      status: "dropped",
    });
    expect((await c.row("ct-4")).blocked_by).toEqual(["ct-7"]);
    await c.actor.mutation(api.tasks.webUpdate, {
      short_id: "ct-1",
      duplicate_of: "",
      status: "open",
    });
    expect((await c.row("ct-4")).blocked_by).toEqual(["ct-7", "ct-1"]);
    expect((await c.row("ct-7")).blocks).toEqual(["ct-4"]);
  });

  test("dropped again after a reopen, a duplicate moves its dependents to the canonical, not releases them", async () => {
    const c = await setup([
      task("ct-1", { blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-7"),
    ]);
    await c.actor.mutation(api.tasks.webUpdate, {
      short_id: "ct-1",
      duplicate_of: "ct-7",
      status: "dropped",
    });
    await c.actor.mutation(api.tasks.webUpdate, {
      short_id: "ct-1",
      status: "open",
    });
    expect([
      (await c.row("ct-1")).duplicate_of,
      (await c.row("ct-2")).blocked_by,
    ]).toEqual(["ct-7", ["ct-1"]]);
    await c.actor.mutation(api.tasks.webUpdate, {
      short_id: "ct-1",
      status: "dropped",
    });
    expect((await c.row("ct-2")).blocked_by).toEqual(["ct-7"]);
    expect((await c.row("ct-7")).blocks).toEqual(["ct-2"]);
    expect((await c.row("ct-1")).blocks).toEqual([]);
    expect(
      (await c.comments("ct-2")).filter((c: string) =>
        c.startsWith("Unblocked"),
      ),
    ).toEqual([]);
  });

  test("a dependent added after the mark moves to the canonical when the duplicate is dropped", async () => {
    const c = await setup([task("ct-1"), task("ct-3"), task("ct-7")]);
    await c.actor.mutation(api.tasks.webUpdate, {
      short_id: "ct-1",
      duplicate_of: "ct-7",
    });
    await c.t.run((ctx) =>
      addDepCore(ctx, c.owner, {
        short_id: "ct-3",
        blocked_by: "ct-1",
      }),
    );
    await c.actor.mutation(api.tasks.webUpdate, {
      short_id: "ct-1",
      status: "dropped",
    });
    expect((await c.row("ct-3")).blocked_by).toEqual(["ct-7"]);
    expect((await c.row("ct-7")).blocks).toEqual(["ct-3"]);
    expect(await c.comments("ct-3")).toEqual([]);
  });

  test("a duplicate dropped with its parent's cascade moves its dependents too", async () => {
    const c = await setup([
      task("ct-1"),
      task("ct-2", {
        parent_id: "task_ct-1",
        duplicate_of: "ct-7",
        blocks: ["ct-3"],
      }),
      task("ct-3", { blocked_by: ["ct-2"] }),
      task("ct-7"),
    ]);
    await c.actor.mutation(api.tasks.webUpdate, {
      short_id: "ct-1",
      status: "dropped",
      subtask_resolution: "cascade",
    });
    expect((await c.row("ct-2")).status).toBe("dropped");
    expect((await c.row("ct-3")).blocked_by).toEqual(["ct-7"]);
  });

  test("a duplicate whose canonical was dropped since releases its dependents on its own drop", async () => {
    const c = await setup([
      task("ct-1", { duplicate_of: "ct-7", blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-7", { status: "dropped" }),
    ]);
    await c.actor.mutation(api.tasks.webUpdate, {
      short_id: "ct-1",
      status: "dropped",
    });
    expect((await c.row("ct-2")).blocked_by).toEqual(["ct-1"]);
    expect(await c.comments("ct-2")).toEqual(["Unblocked: ct-1 dropped"]);
  });

  test("a dropped or replaced canonical is refused and nothing moves", async () => {
    const c = await setup([
      task("ct-1", { blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-7", { status: "dropped" }),
      task("ct-8", { superseded_by: "ct-9" }),
      task("ct-9"),
    ]);
    await expect(
      c.actor.mutation(api.tasks.webUpdate, {
        short_id: "ct-1",
        duplicate_of: "ct-7",
        status: "dropped",
      }),
    ).rejects.toThrow(/ct-7 is dropped/);
    await expect(
      c.actor.mutation(api.tasks.webUpdate, {
        short_id: "ct-1",
        duplicate_of: "ct-8",
      }),
    ).rejects.toThrow(/superseded by ct-9/);
    expect([
      (await c.row("ct-1")).duplicate_of,
      (await c.row("ct-2")).blocked_by,
    ]).toEqual([undefined, ["ct-1"]]);
  });

  test("a duplicate dropped by a line's move with a dependent that would loop completes and notes it", async () => {
    const c = await setup([
      task("ct-1", { duplicate_of: "ct-7", blocks: ["ct-3", "ct-4"] }),
      task("ct-3", { blocked_by: ["ct-1"], blocks: ["ct-7"] }),
      task("ct-4", { blocked_by: ["ct-1"] }),
      task("ct-7", { blocked_by: ["ct-3"] }),
    ]);
    await c.t.run(async (ctx) =>
      moveTaskStatus(ctx, (await ctx.db.get(c.id("ct-1")))!, "dropped", {
        actorUserId: c.owner,
      }),
    );
    expect((await c.row("ct-1")).status).toBe("dropped");
    expect([
      (await c.row("ct-3")).blocked_by,
      (await c.row("ct-4")).blocked_by,
    ]).toEqual([["ct-1"], ["ct-7"]]);
    expect([
      (await c.row("ct-1")).blocks,
      (await c.row("ct-7")).blocks,
    ]).toEqual([["ct-3"], ["ct-4"]]);
    const notes = await c.comments("ct-3");
    expect(notes[0]).toMatch(
      /^Released from ct-1 rather than moved to ct-7 \(ct-1 duplicate of ct-7\): ct-7 already waits on ct-3 .*loop/,
    );
    expect(notes[1]).toBe("Unblocked: ct-1 dropped");
  });

  test("a reopened canonical that still carries an old duplicate mark takes the dependents", async () => {
    const c = await setup([
      task("ct-1", { duplicate_of: "ct-7", blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-7", { duplicate_of: "ct-9" }),
      task("ct-9"),
    ]);
    await c.actor.mutation(api.tasks.webUpdate, {
      short_id: "ct-1",
      status: "dropped",
    });
    expect((await c.row("ct-2")).blocked_by).toEqual(["ct-7"]);
    expect(await c.comments("ct-2")).toEqual([]);
  });

  test("a canonical in another workspace is refused and nothing moves", async () => {
    const c = await setup([
      task("ct-1", { blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-9", {
        user_id: OTHER,
        team_id: "team_x",
        workspace: "team:team_x",
      }),
    ]);
    await c.join("team_x");
    await expect(
      c.actor.mutation(api.tasks.webUpdate, {
        short_id: "ct-1",
        duplicate_of: "ct-9",
        status: "dropped",
      }),
    ).rejects.toThrow(/another workspace/);
    expect([
      (await c.row("ct-1")).status,
      (await c.row("ct-1")).duplicate_of,
      (await c.row("ct-2")).blocked_by,
    ]).toEqual(["open", undefined, ["ct-1"]]);
  });
});

describe("status moves outside tasks.ts (TG5)", () => {
  const external = {
    provider: "linear",
    id: "issue_1",
    identifier: "LIN-1",
    url: "",
    synced_at: 1,
    remote_updated_at: 1,
  };
  const sync = async (
    c: Awaited<ReturnType<typeof setup>>,
    state?: { type: string; name: string },
  ) => {
    const issue = normalizeLinearIssue({
      id: "issue_1",
      identifier: "LIN-1",
      title: "Title ct-1",
      ...(state ? { state } : { trashed: true }),
    });
    await c.t.mutation(internal.issueSync.applyRemote, { issue });
  };

  test("a duplicate dropped by an issue sync moves its dependents to the canonical, as the system", async () => {
    const c = await setup([
      task("ct-1", { duplicate_of: "ct-7", blocks: ["ct-2"], external }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-7"),
    ]);
    await sync(c);
    expect((await c.row("ct-1")).status).toBe("dropped");
    expect([
      (await c.row("ct-2")).blocked_by,
      (await c.row("ct-7")).blocks,
    ]).toEqual([["ct-7"], ["ct-2"]]);
    expect(await c.comments("ct-2")).toEqual([]);
    expect(
      (await c.read("task_history")).find(
        (h: any) => h.task_id === c.id("ct-2") && h.field === "blocked_by",
      ),
    ).toMatchObject({ actor_type: "system" });
  });

  test("a superseded task reopened by an issue sync takes its dependents back", async () => {
    const c = await setup([
      task("ct-1", { blocks: ["ct-2"], external }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-5"),
    ]);
    await c.t.mutation(api.taskLinks.supersede, {
      api_token: TOKEN,
      short_id: "ct-1",
      by: "ct-5",
    });
    expect((await c.row("ct-2")).blocked_by).toEqual(["ct-5"]);
    await sync(c, { type: "unstarted", name: "Todo" });
    expect([
      (await c.row("ct-1")).status,
      (await c.row("ct-1")).superseded_by,
    ]).toEqual(["open", undefined]);
    expect((await c.row("ct-2")).blocked_by).toEqual(["ct-1"]);
  });

  test("a duplicate dropped by an org plan close moves its dependents to the canonical", async () => {
    const c = await setup([
      task("ct-1", {
        plan_id: "plan_1",
        duplicate_of: "ct-7",
        blocks: ["ct-2"],
      }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-7"),
    ]);
    await c.t.run((ctx) =>
      applyPlanStatus(
        ctx,
        c.owner,
        { scope_user_id: c.owner } as any,
        { plan: "pl-1", status: "abandoned" } as any,
        {} as any,
      ),
    );
    expect((await c.row("ct-1")).status).toBe("dropped");
    expect((await c.row("ct-2")).blocked_by).toEqual(["ct-7"]);
    expect(await c.comments("ct-2")).toEqual([]);
  });

  test("a drop whose canonical has too much upstream to check still completes and releases the dependent", async () => {
    const upstream = Array.from({ length: 2001 }, (_, i) =>
      task(`ct-${1000 + i}`, i ? {} : { blocked_by: ["ct-999"] }),
    );
    const c = await setup([
      task("ct-1", { duplicate_of: "ct-7", blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
      task("ct-7", { blocked_by: upstream.map((t) => t.short_id) }),
      task("ct-999"),
      ...upstream,
    ]);
    await c.t.run(async (ctx) =>
      moveTaskStatus(ctx, (await ctx.db.get(c.id("ct-1")))!, "dropped", {
        actorUserId: c.owner,
      }),
    );
    expect((await c.row("ct-1")).status).toBe("dropped");
    expect((await c.row("ct-2")).blocked_by).toEqual(["ct-1"]);
    const notes = await c.comments("ct-2");
    expect(notes[0]).toMatch(
      /^Released from ct-1 rather than moved to ct-7 .*: Cannot check ct-7's dependencies/,
    );
    expect(notes[1]).toBe("Unblocked: ct-1 dropped");
  });
});
