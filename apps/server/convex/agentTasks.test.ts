import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { serverTest } from "../test-helpers/database.testkit";
import { fixtureRows, type NewRow } from "../test-helpers/rows.testkit";
import type { Id } from "./_generated/dataModel";
import {
  applyTaskUpdate,
  cancelTasksBoundToConversation,
  reactivateTasksCanceledOnKill,
} from "./agentTasks";

const HOUR = 60 * 60 * 1000;

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

async function setup() {
  const t = serverTest();
  const people = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "trigger owners");
    const user = await rows.user();
    const teammate = await rows.user();
    const home = await rows.conversation(user, {
      armed_trigger_kind: "standing",
    });
    const other = await rows.conversation(user, { armed_trigger_kind: "none" });
    return { user, teammate, home, other };
  });
  const seed = (...overrides: Partial<NewRow<"agent_tasks">>[]) =>
    t.run(async ({ db }) => {
      const ids = [];
      for (const fields of overrides)
        ids.push(
          await db.insert("agent_tasks", {
            user_id: people.user,
            title: "Check CI",
            prompt: "Check if CI is green",
            schedule_type: "recurring",
            status: "scheduled",
            mode: "apply",
            interval_ms: HOUR,
            run_at: 1000,
            retry_count: 0,
            run_count: 0,
            created_at: 1,
            originating_conversation_id: people.home,
            ...fields,
          }),
        );
      return ids;
    });
  const read = <T extends "agent_tasks" | "conversations">(id: Id<T>) =>
    t.run(async ({ db }) => (await db.get(id))!);
  return {
    ...people,
    t,
    seed,
    read,
    cancel: () =>
      t.mutation((ctx) =>
        cancelTasksBoundToConversation(ctx, people.user, people.home),
      ),
    restore: () =>
      t.mutation((ctx) =>
        reactivateTasksCanceledOnKill(ctx, people.user, people.home),
      ),
    edit: (
      id: Id<"agent_tasks">,
      fields: Parameters<typeof applyTaskUpdate>[2],
      web = false,
    ) =>
      t.mutation(async (ctx) =>
        applyTaskUpdate(ctx, (await ctx.db.get(id))!, fields, {
          userId: web ? people.teammate : people.user,
          source: web ? "web" : "cli",
        }),
      ),
    revisions: () =>
      t.run(({ db }) => db.query("agent_task_revisions").collect()),
  };
}

describe("cancelTasksBoundToConversation", () => {
  test("completes armed inject schedules and stamps canceled_on_kill_at", async () => {
    const c = await setup();
    const tasks = await c.seed({}, { status: "paused" });
    expect(await c.cancel()).toBe(2);
    expect((await c.read(c.home)).armed_trigger_kind).toBe("none");
    for (const id of tasks) {
      const row = await c.read(id);
      expect(row.status).toBe("completed");
      expect(row.canceled_on_kill_at).toBeGreaterThan(0);
    }
  });

  test("leaves other conversations' schedules and spawn schedules alone", async () => {
    const c = await setup();
    const ids = await c.seed(
      { originating_conversation_id: c.other },
      { originating_conversation_id: undefined },
    );
    const before = await Promise.all(ids.map(c.read));
    expect(await c.cancel()).toBe(0);
    expect(await Promise.all(ids.map(c.read))).toEqual(before);
  });
});

describe("reactivateTasksCanceledOnKill", () => {
  test("re-arms exactly the stamped tasks and clears the stamp", async () => {
    const c = await setup();
    const [killed, natural, other] = await c.seed(
      { status: "completed", canceled_on_kill_at: 111 },
      { status: "completed" },
      {
        status: "completed",
        canceled_on_kill_at: 111,
        originating_conversation_id: c.other,
      },
    );
    expect(await c.restore()).toBe(1);
    const row = await c.read(killed);
    expect(row.status).toBe("scheduled");
    expect(row.canceled_on_kill_at).toBeUndefined();
    expect(row.run_at).toBeGreaterThan(Date.now() + HOUR / 2);
    expect((await c.read(natural)).status).toBe("completed");
    expect((await c.read(other)).status).toBe("completed");
  });

  test("kill → restore round-trip is idempotent (second restore is a no-op)", async () => {
    const c = await setup();
    const [id] = await c.seed({});
    await c.cancel();
    expect((await c.read(id)).status).toBe("completed");
    expect(await c.restore()).toBe(1);
    expect((await c.read(id)).status).toBe("scheduled");
    expect(await c.restore()).toBe(0);
  });
});

test("kill and restore read only the conversation's own tasks and leave the teammate's task alone", async () => {
  const c = await setup();
  const [mine, teammate] = await c.seed(
    {},
    { user_id: c.teammate },
    ...Array.from({ length: 100 }, () => ({
      originating_conversation_id: c.other,
    })),
  );
  const before = await c.read(teammate);
  const result = await c.t.mutation(async (ctx) => {
    const canceled = await cancelTasksBoundToConversation(ctx, c.user, c.home);
    const restored = await reactivateTasksCanceledOnKill(ctx, c.user, c.home);
    return {
      canceled,
      restored,
      reads: (await ctx.meta.getTransactionMetrics()).documentsRead.used,
    };
  });
  expect(result).toMatchObject({ canceled: 1, restored: 1 });
  expect(result.reads).toBe(12);
  expect((await c.read(mine)).status).toBe("scheduled");
  expect(await c.read(teammate)).toEqual(before);
});

describe("applyTaskUpdate", () => {
  test("records a revision with the pre-edit snapshot and the audit fields", async () => {
    const c = await setup();
    const [id] = await c.seed({});
    expect(await c.edit(id, { prompt: "Check CI and the deploy" })).toEqual({
      ok: true,
      changed: ["prompt"],
    });
    expect((await c.read(id)).prompt).toBe("Check CI and the deploy");
    const revisions = await c.revisions();
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      revision: 1,
      actor_user_id: c.user,
      source: "cli",
      changed_fields: ["prompt"],
      before: { prompt: "Check if CI is green", title: "Check CI" },
    });
  });

  test("a prompt edit resets the stale distillation without auditing it as a change", async () => {
    const c = await setup();
    const [id] = await c.seed({
      display_title: "Old distilled name",
      display_summary: "Old gist",
    });
    await c.edit(id, { prompt: "New prompt" });
    const row = await c.read(id);
    expect(row.display_title).toBeUndefined();
    expect(row.display_summary).toBeUndefined();
    expect((await c.revisions())[0].changed_fields).toEqual(["prompt"]);
  });

  test("no-op edit writes neither a patch nor a revision", async () => {
    const c = await setup();
    const [id] = await c.seed({});
    const result = await c.t.mutation(async (ctx) => {
      const task = (await ctx.db.get(id))!;
      const result = await applyTaskUpdate(
        ctx,
        task,
        { prompt: task.prompt, title: task.title },
        { userId: c.user, source: "cli" },
      );
      return {
        ...result,
        writes: (await ctx.meta.getTransactionMetrics()).documentsWritten.used,
      };
    });
    expect(result).toEqual({ ok: true, changed: [], writes: 0 });
    expect(await c.revisions()).toHaveLength(0);
  });

  test("revision numbers are monotonic across edits", async () => {
    const c = await setup();
    const [id] = await c.seed({});
    await c.edit(id, { title: "First rename" });
    await c.edit(id, { title: "Second rename" }, true);
    const revisions = await c.revisions();
    expect(revisions.map((r) => r.revision)).toEqual([1, 2]);
    expect(revisions.map((r) => r.before.title)).toEqual([
      "Check CI",
      "First rename",
    ]);
    expect((await c.read(id)).title).toBe("Second rename");
    expect(revisions[1]).toMatchObject({
      actor_user_id: c.teammate,
      source: "web",
    });
  });

  test("switching recurring to once clears the interval and audits both fields", async () => {
    const c = await setup();
    const [id] = await c.seed({});
    const runAt = Date.now() + 60_000;
    expect(await c.edit(id, { schedule_type: "once", run_at: runAt })).toEqual({
      ok: true,
      changed: ["schedule_type", "run_at", "interval_ms"],
    });
    const row = await c.read(id);
    expect(row).toMatchObject({ schedule_type: "once", run_at: runAt });
    expect(row.interval_ms).toBeUndefined();
    expect((await c.revisions())[0].before).toMatchObject({
      schedule_type: "recurring",
      interval_ms: HOUR,
    });
  });

  describe("routing", () => {
    test("rebinding moves the trigger and refreshes BOTH homes", async () => {
      const c = await setup();
      const [id] = await c.seed({});
      await c.edit(id, { originating_conversation_id: c.other });
      expect((await c.read(id)).originating_conversation_id).toBe(c.other);
      expect((await c.read(c.home)).armed_trigger_kind).toBe("none");
      expect((await c.read(c.other)).armed_trigger_kind).toBe("standing");
    });

    test("the result thread and the wake flag are editable and audited", async () => {
      const c = await setup();
      const [id] = await c.seed({});
      const result = await c.edit(id, {
        target_conversation_id: c.other,
        wake_creator: true,
      });
      expect(result.changed).toEqual([
        "target_conversation_id",
        "wake_creator",
      ]);
      expect(await c.read(id)).toMatchObject({
        target_conversation_id: c.other,
        wake_creator: true,
      });
      expect(
        (await c.revisions())[0].before.target_conversation_id,
      ).toBeUndefined();
    });

    test("clearing the thread and the wake flag drops them rather than storing false", async () => {
      const c = await setup();
      const [id] = await c.seed({
        target_conversation_id: c.other,
        wake_creator: true,
      });
      await c.edit(id, { target_conversation_id: null, wake_creator: false });
      const row = await c.read(id);
      expect(row.target_conversation_id).toBeUndefined();
      expect(row.wake_creator).toBeUndefined();
    });

    test("rebinding to the same session is a no-op edit", async () => {
      const c = await setup();
      const [id] = await c.seed({});
      expect(await c.edit(id, { originating_conversation_id: c.home })).toEqual(
        { ok: true, changed: [] },
      );
      expect(await c.revisions()).toHaveLength(0);
    });
  });

  test("rejects a finished task, and a running one for fields the live run reads", async () => {
    const c = await setup();
    for (const [status, edit] of [
      ["running", { model: "opus" }],
      ["completed", { title: "Nope" }],
      ["failed", { title: "Nope" }],
    ] as const) {
      const [id] = await c.seed({ status });
      expect((await c.edit(id, edit)).ok).toBe(false);
      const row = await c.read(id);
      expect(row.title).toBe("Check CI");
      expect(row.model).toBeUndefined();
      expect(await c.revisions()).toHaveLength(0);
    }
  });

  test("takes a title and prompt edit on a running task", async () => {
    const c = await setup();
    const [id] = await c.seed({ status: "running" });
    expect(
      (
        await c.edit(id, {
          title: "Check CI twice",
          prompt: "Check CI on main twice",
        })
      ).ok,
    ).toBe(true);
    expect(await c.read(id)).toMatchObject({
      title: "Check CI twice",
      prompt: "Check CI on main twice",
      status: "running",
    });
  });

  test("setting, changing and clearing the precheck is versioned like any edit", async () => {
    const c = await setup();
    const [id] = await c.seed({});
    expect(await c.edit(id, { precheck: "make check" })).toEqual({
      ok: true,
      changed: ["precheck"],
    });
    expect((await c.read(id)).precheck).toBe("make check");
    expect((await c.revisions())[0].before.precheck).toBeUndefined();
    expect((await c.edit(id, { precheck: "  make check  " })).changed).toEqual(
      [],
    );
    expect(await c.revisions()).toHaveLength(1);
    expect((await c.edit(id, { precheck: "" })).changed).toEqual(["precheck"]);
    expect((await c.read(id)).precheck).toBeUndefined();
    expect((await c.revisions())[1].before.precheck).toBe("make check");
  });
});
