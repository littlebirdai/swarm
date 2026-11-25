import { describe, expect, test } from "bun:test";
import {
  OTHER,
  TOKEN,
  USER,
  setup,
  task,
} from "../test-helpers/taskLinks.testkit";
import { api, internal } from "./_generated/api";

describe("related (TG5)", () => {
  test("relate and unrelate write both rows and their history", async () => {
    const c = await setup([task("ct-1"), task("ct-2")]);
    await c.t.mutation(api.taskLinks.relate, {
      api_token: TOKEN,
      short_id: "ct-1",
      other: "ct-2",
    });
    await c.t.mutation(api.taskLinks.relate, {
      api_token: TOKEN,
      short_id: "ct-2",
      other: "ct-1",
    });
    expect([
      (await c.row("ct-1")).related,
      (await c.row("ct-2")).related,
    ]).toEqual([["ct-2"], ["ct-1"]]);
    expect(await c.history("ct-1", "related")).toEqual([["", "ct-2"]]);
    await c.t.mutation(api.taskLinks.unrelate, {
      api_token: TOKEN,
      short_id: "ct-2",
      other: "ct-1",
    });
    expect([
      (await c.row("ct-1")).related,
      (await c.row("ct-2")).related,
    ]).toEqual([[], []]);
  });

  test("unrelate removes a link whose far side is gone; relate refuses self and missing", async () => {
    const c = await setup([task("ct-1", { related: ["ct-404"] })]);
    await c.t.mutation(api.taskLinks.unrelate, {
      api_token: TOKEN,
      short_id: "ct-1",
      other: "ct-404",
    });
    expect((await c.row("ct-1")).related).toEqual([]);
    await expect(
      c.t.mutation(api.taskLinks.relate, {
        api_token: TOKEN,
        short_id: "ct-1",
        other: "ct-1",
      }),
    ).rejects.toThrow(/itself/);
    await expect(
      c.t.mutation(api.taskLinks.relate, {
        api_token: TOKEN,
        short_id: "ct-1",
        other: "ct-404",
      }),
    ).rejects.toThrow(/not found/i);
    await expect(
      c.t.mutation(api.taskLinks.unrelate, {
        api_token: TOKEN,
        short_id: "ct-1",
        other: c.id("ct-404"),
      }),
    ).rejects.toThrow(`ct-1 is not related to ${c.id("ct-404")}`);
  });

  test("unrelate clears the far row's mirror after it moved to a workspace the caller cannot read", async () => {
    const c = await setup([
      task("ct-1", { related: ["ct-2"] }),
      task("ct-2", {
        related: ["ct-1"],
        user_id: OTHER,
        workspace: `user:${OTHER}`,
      }),
    ]);
    await c.t.mutation(api.taskLinks.unrelate, {
      api_token: TOKEN,
      short_id: "ct-1",
      other: "ct-2",
    });
    expect([
      (await c.row("ct-1")).related,
      (await c.row("ct-2")).related,
    ]).toEqual([[], []]);
  });

  test("relate refuses a row already holding the cap", async () => {
    const full = Array.from({ length: 50 }, (_, i) => `ct-${200 + i}`);
    const c = await setup([task("ct-1", { related: full }), task("ct-2")]);
    await expect(
      c.t.mutation(api.taskLinks.relate, {
        api_token: TOKEN,
        short_id: "ct-2",
        other: "ct-1",
      }),
    ).rejects.toThrow(/ct-1 already has 50 related tasks/);
    expect((await c.row("ct-2")).related).toBeUndefined();
  });
});

describe("web side effects (dispatch)", () => {
  test("relateTasks and unrelateTasks take the tuples the store sends", async () => {
    const c = await setup([task("ct-5"), task("ct-6")]);
    await c.actor.mutation(api.dispatch.dispatch, {
      action: "relateTasks",
      args: ["ct-5", "ct-6"],
    });
    expect([
      (await c.row("ct-5")).related,
      (await c.row("ct-6")).related,
    ]).toEqual([["ct-6"], ["ct-5"]]);
    await c.actor.mutation(api.dispatch.dispatch, {
      action: "unrelateTasks",
      args: ["ct-6", "ct-5"],
    });
    expect([
      (await c.row("ct-5")).related,
      (await c.row("ct-6")).related,
    ]).toEqual([[], []]);
    expect(
      (await c.read("task_history"))
        .filter((h: any) => h.field === "related")
        .map((h: any) => h.actor_type),
    ).toEqual(["user", "user", "user", "user"]);
  });
});

describe("edges across workspaces", () => {
  test("a task that changed workspace loses its edges into the old one, and a dependent it held is released", async () => {
    const team = { team_id: "team_t", workspace: "team:team_t" };
    const c = await setup([
      task("ct-1", {
        workspace: `user:${USER}`,
        blocks: ["ct-2"],
        blocked_by: ["ct-3"],
      }),
      task("ct-2", { ...team, blocked_by: ["ct-1"] }),
      task("ct-3", { ...team, blocks: ["ct-1"] }),
    ]);
    await c.t.mutation(internal.taskLinks.cutCrossedEdges, {
      task_ids: [c.id("ct-1")],
    });
    expect((await c.row("ct-2")).blocked_by).toEqual([]);
    expect((await c.row("ct-1")).blocks).toEqual([]);
    expect((await c.row("ct-1")).blocked_by).toEqual([]);
    expect((await c.row("ct-3")).blocks).toEqual([]);
    expect(await c.history("ct-2", "blocked_by")).toEqual([["ct-1", ""]]);
    expect(await c.comments("ct-2")).toEqual([
      "No longer waits on ct-1: the two tasks are in different workspaces now, so this one could never see it finish.",
      "Unblocked: the blocker ct-1 was removed",
    ]);
  });

  test("a parent link that now crosses workspaces is cut both ways, and the subtask returns to the top level", async () => {
    const team = { team_id: "team_t", workspace: "team:team_t" };
    const c = await setup([
      task("ct-1", { workspace: `user:${USER}`, parent_id: "task_ct-5" }),
      task("ct-5", team),
      task("ct-6", { ...team, parent_id: "task_ct-1" }),
      task("ct-7", { workspace: `user:${USER}`, parent_id: "task_ct-1" }),
    ]);
    await c.t.mutation(internal.taskLinks.cutCrossedEdges, {
      task_ids: [c.id("ct-1")],
    });
    expect((await c.row("ct-1")).parent_id).toBeUndefined();
    expect((await c.row("ct-6")).parent_id).toBeUndefined();
    expect((await c.row("ct-7")).parent_id).toBe(c.id("ct-1"));
    expect(await c.history("ct-1", "parent")).toEqual([[c.id("ct-5"), ""]]);
    expect(await c.comments("ct-6")).toEqual([
      "No longer a subtask of ct-1: the two tasks are in different workspaces now, so this one could never be ready under it.",
    ]);
  });

  test("a reparent checks the parent against the child's access key, never its routing team", async () => {
    const routed = { team_id: "team_t", workspace: `user:${USER}` };
    const c = await setup([
      task("ct-1", routed),
      task("ct-2", routed),
      task("ct-5", { team_id: "team_t", workspace: "team:team_t" }),
      task("ct-6", routed),
    ]);
    await c.join("team_t");
    await expect(
      c.t.mutation(api.tasks.update, {
        api_token: TOKEN,
        short_id: "ct-1",
        parent: "ct-5",
      }),
    ).rejects.toThrow(/another workspace/);
    await expect(
      c.actor.mutation(api.tasks.webUpdate, {
        short_id: "ct-2",
        parent: "ct-5",
      }),
    ).rejects.toThrow(/another workspace/);
    await c.t.mutation(api.tasks.update, {
      api_token: TOKEN,
      short_id: "ct-1",
      parent: "ct-6",
    });
    await c.actor.mutation(api.tasks.webUpdate, {
      short_id: "ct-2",
      parent: "ct-6",
    });
    expect([
      (await c.row("ct-1")).parent_id,
      (await c.row("ct-2")).parent_id,
    ]).toEqual([c.id("ct-6"), c.id("ct-6")]);
  });

  test("edges inside one workspace are left alone", async () => {
    const c = await setup([
      task("ct-1", { blocks: ["ct-2"] }),
      task("ct-2", { blocked_by: ["ct-1"] }),
    ]);
    await c.t.mutation(internal.taskLinks.cutCrossedEdges, {
      task_ids: [c.id("ct-1")],
    });
    expect((await c.row("ct-2")).blocked_by).toEqual(["ct-1"]);
    expect(await c.read("task_history")).toEqual([]);
  });
});
