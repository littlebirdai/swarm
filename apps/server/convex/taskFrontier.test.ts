// Claiming the frontier, execution hints and ephemeral tasks
// (docs/architecture/task-graph.md TG7-TG9): the ready list reads in the order
// work should be taken and flags what has gone stale, a claim starts the first
// row it may start, model/effort/ephemeral write through update, and an
// ephemeral task stays off the default list and out of the bell.
import { describe, expect, test } from "bun:test";
import { STALE_TASK_MS } from "@codecast/tasks/frontier";
import type { FunctionArgs } from "convex/server";
import { serverTest, type ServerTest } from "../test-helpers/database.testkit";
import { fixtureRows, type NewRow } from "../test-helpers/rows.testkit";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { claimFrontier } from "./lib/claimFrontier";

const TOKEN = "task-frontier-test-token";
const NOW = Date.now();

type Options = {
  planOrder?: string[];
  sessions?: boolean;
  ephemeralFrom?: string;
  linkedToOther?: string;
  assignedToMate?: string[];
  assignedToOwner?: string;
  assignedToRole?: string;
  held?: string;
};

async function setup(
  tasks: (Partial<NewRow<"tasks">> & { short_id: string })[],
  options: Options = {},
) {
  const t = serverTest();
  const ids = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "task frontier");
    const owner = await rows.user();
    const other = await rows.user();
    const teammate = await rows.user({ name: "Teammate" });
    await rows.token(owner, TOKEN);
    const taskIds: Record<string, Id<"tasks">> = {};
    for (const fields of tasks) {
      taskIds[fields.short_id] = await rows.task(owner, {
        created_at: NOW - 1000,
        updated_at: NOW - 1000,
        ...fields,
      });
    }

    if (options.planOrder) {
      const task_ids = options.planOrder.map((key) => taskIds[key]);
      const plan_id = await rows.plan(owner, { short_id: "pl-1", task_ids });
      for (const task of task_ids) await db.patch(task, { plan_id });
    }
    for (const shortId of options.assignedToMate ?? [])
      await db.patch(taskIds[shortId], { assignee: teammate });
    if (options.assignedToOwner)
      await db.patch(taskIds[options.assignedToOwner], { assignee: owner });
    const role = options.assignedToRole ? await rows.role(owner) : undefined;
    if (options.assignedToRole)
      await db.patch(taskIds[options.assignedToRole], { assignee: role });

    let mySession: Id<"conversations"> | undefined;
    let otherSession: Id<"conversations"> | undefined;
    if (options.sessions) {
      mySession = await rows.conversation(owner, {
        session_id: "sess-me",
        short_id: "jme0001",
        is_private: true,
        updated_at: NOW,
        org_role_id: role,
      });
      otherSession = await rows.conversation(owner, {
        session_id: "sess-other",
        short_id: "jot0001",
        is_private: true,
        updated_at: NOW,
        active_task_id: options.linkedToOther
          ? taskIds[options.linkedToOther]
          : undefined,
      });
      if (options.ephemeralFrom)
        await db.patch(taskIds[options.ephemeralFrom], {
          created_from_conversation: otherSession,
        });
      if (options.linkedToOther)
        await db.patch(taskIds[options.linkedToOther], {
          conversation_ids: [otherSession],
        });
    }
    if (options.held) {
      const conversation = await rows.conversation(owner, {
        session_id: "decision-session",
      });
      await db.insert("session_decisions", {
        short_id: "sd-3",
        user_id: owner,
        conversation_id: conversation,
        session_id: "decision-session",
        task_id: taskIds[options.held],
        question: "Start?",
        options: [{ label: "Start" }],
        status: "pending",
        blocking: true,
        station: "open",
        created_at: NOW,
      });
    }
    return { owner, other, teammate, taskIds, mySession, otherSession };
  });
  return {
    t,
    ...ids,
    row: (shortId: string) =>
      t.run(
        async ({ db }) =>
          (await db
            .query("tasks")
            .withIndex("by_short_id", (q) => q.eq("short_id", shortId))
            .unique())!,
      ),
    notifications: () => t.run(({ db }) => db.query("notifications").collect()),
  };
}

const list = (
  t: ServerTest,
  args: Partial<FunctionArgs<typeof api.tasks.list>>,
) => t.query(api.tasks.list, { api_token: TOKEN, ...args });
const order = (rows: { short_id: string }[]) => rows.map((t) => t.short_id);

describe("the ready frontier's order (TG7)", () => {
  test("priority, then plan order, then oldest; stale rows last and flagged", async () => {
    const stale = NOW - STALE_TASK_MS - 1;
    const { t } = await setup(
      [
        { short_id: "ct-1", priority: "low" },
        {
          short_id: "ct-2",
          priority: "urgent",
          updated_at: stale,
          created_at: stale,
        },
        { short_id: "ct-3", priority: "high" },
        { short_id: "ct-4", priority: "high" },
        { short_id: "ct-5", priority: "high", created_at: NOW - 5000 },
        { short_id: "ct-6", priority: "high", created_at: NOW - 9000 },
      ],
      { planOrder: ["ct-4", "ct-3"] },
    );
    const rows = await list(t, { ready: true });
    expect(order(rows)).toEqual([
      "ct-4",
      "ct-3",
      "ct-6",
      "ct-5",
      "ct-1",
      "ct-2",
    ]);
    expect(rows.filter((r) => r.stale).map((r) => r.short_id)).toEqual([
      "ct-2",
    ]);
  });

  test("a list that is not the frontier stays newest first and carries no stale flag", async () => {
    const { t } = await setup([
      { short_id: "ct-1", updated_at: NOW - 10 },
      { short_id: "ct-2", priority: "urgent", updated_at: NOW - 20 },
    ]);
    const rows = await list(t, {});
    expect(order(rows)).toEqual(["ct-1", "ct-2"]);
    expect(rows[0].stale).toBeUndefined();
  });
});

describe("ephemeral tasks (TG9)", () => {
  test("left off the default list, listed on request and in the owner's frontier", async () => {
    const { t } = await setup([
      { short_id: "ct-1" },
      { short_id: "ct-2", ephemeral: true },
    ]);
    expect(order(await list(t, {}))).toEqual(["ct-1"]);
    expect(order(await list(t, { include_ephemeral: true })).sort()).toEqual([
      "ct-1",
      "ct-2",
    ]);
    expect(order(await list(t, { ready: true })).sort()).toEqual([
      "ct-1",
      "ct-2",
    ]);
  });

  test("a session's ephemeral task is on its own frontier only, not its person's other sessions'", async () => {
    const { t } = await setup(
      [{ short_id: "ct-1" }, { short_id: "ct-2", ephemeral: true }],
      { sessions: true, ephemeralFrom: "ct-2" },
    );
    expect(
      order(await list(t, { ready: true, conversation_id: "sess-me" })),
    ).toEqual(["ct-1"]);
    expect(order(await list(t, { ready: true }))).toEqual(["ct-1"]);
    expect(
      order(
        await list(t, { ready: true, conversation_id: "sess-other" }),
      ).sort(),
    ).toEqual(["ct-1", "ct-2"]);
  });

  test("a notification about an ephemeral task rings nobody", async () => {
    const { t, owner, other, taskIds, notifications } = await setup([
      { short_id: "ct-1", ephemeral: true },
      { short_id: "ct-2" },
    ]);
    const emit = (taskId: string) =>
      t.mutation(internal.notificationRouter.emit, {
        event_type: "task_assigned",
        actor_user_id: other,
        entity_type: "task",
        entity_id: taskId,
        message: "assigned you",
        direct_recipient_id: owner,
      });
    expect(await emit(taskIds["ct-1"])).toEqual({ notified: 0 });
    expect(await notifications()).toHaveLength(0);
    await emit(taskIds["ct-2"]);
    expect(await notifications()).toHaveLength(1);
  });

  test("a machine assignment of an ephemeral task leaves the open fold row alone", async () => {
    const { t, owner, teammate, notifications } = await setup([]);
    const notification = await t.run(async ({ db }) => {
      await db.patch(owner, { is_bot: true });
      return db.insert("notifications", {
        recipient_user_id: teammate,
        actor_user_id: owner,
        type: "task_assigned",
        read: false,
        entity_type: "task",
        entity_id: "ct-9",
        message: "assigned you to ct-9: x",
        created_at: NOW - 1000,
      });
    });
    const open = await notifications();
    await t.mutation(api.tasks.create, {
      api_token: TOKEN,
      title: "probe",
      ephemeral: true,
      assignee: teammate,
    });
    expect(await notifications()).toEqual(open);
    // The same assignment of real work folds in.
    await t.mutation(api.tasks.create, {
      api_token: TOKEN,
      title: "real",
      assignee: teammate,
    });
    expect(await notifications()).toMatchObject([
      { _id: notification, fold_count: 2 },
    ]);
  });

  test("keep clears it; create and update write model and effort, and '' clears", async () => {
    const { t, row } = await setup([]);
    const { short_id } = await t.mutation(api.tasks.create, {
      api_token: TOKEN,
      title: "probe",
      ephemeral: true,
      effort: "high",
      model: "sonnet",
    });
    expect(await row(short_id)).toMatchObject({
      ephemeral: true,
      effort: "high",
      model: "sonnet",
    });
    await t.mutation(api.tasks.update, {
      api_token: TOKEN,
      short_id,
      ephemeral: false,
      effort: "max",
    });
    expect((await row(short_id)).ephemeral).toBeUndefined();
    expect((await row(short_id)).effort).toBe("max");
    await t.mutation(api.tasks.update, {
      api_token: TOKEN,
      short_id,
      effort: "",
      model: "",
    });
    expect((await row(short_id)).effort).toBeUndefined();
    expect((await row(short_id)).model).toBeUndefined();
  });
});

describe("claiming the frontier (TG7)", () => {
  const claim = (
    t: ServerTest,
    args: Partial<
      FunctionArgs<typeof internal.taskFrontier.claimCandidates>
    > = {},
  ) => t.action((ctx) => claimFrontier(ctx, { api_token: TOKEN, ...args }));

  test("starts the first frontier task, and the next claim takes the one after", async () => {
    const { t, row } = await setup([
      { short_id: "ct-1", priority: "low" },
      { short_id: "ct-2", priority: "high" },
      { short_id: "ct-3", blocked_by: ["ct-2"], priority: "urgent" },
    ]);
    expect((await claim(t)).task?.short_id).toBe("ct-2");
    expect((await row("ct-2")).status).toBe("in_progress");
    expect((await claim(t)).task?.short_id).toBe("ct-1");
    expect(await claim(t)).toMatchObject({ task: null, skipped: [] });
  });

  test("a candidate another claim started after the frontier was read is passed over", async () => {
    const { t, row } = await setup([
      { short_id: "ct-1", priority: "high" },
      { short_id: "ct-2" },
    ]);
    const { candidates } = await t.query(
      internal.taskFrontier.claimCandidates,
      {
        api_token: TOKEN,
      },
    );
    expect(candidates).toEqual(["ct-1", "ct-2"]);
    // The racing claim wins ct-1 between this claim's two steps.
    await t.mutation(api.tasks.update, {
      api_token: TOKEN,
      short_id: "ct-1",
      status: "in_progress",
    });
    const res = await t.mutation(internal.taskFrontier.claimNextReady, {
      api_token: TOKEN,
      candidates,
    });
    expect(res).toMatchObject({
      task: { short_id: "ct-2" },
      skipped: [{ short_id: "ct-1", reason: "already in_progress" }],
    });
    expect((await row("ct-2")).status).toBe("in_progress");
  });

  test("claimable work far down a frontier of other people's tasks is still found", async () => {
    const theirs = Array.from({ length: 60 }, (_, i) => ({
      short_id: `ct-${i + 10}`,
      priority: "urgent" as const,
    }));
    const { t } = await setup(
      [...theirs, { short_id: "ct-1", priority: "low" }],
      { assignedToMate: theirs.map((task) => task.short_id) },
    );
    expect(await claim(t)).toMatchObject({ task: { short_id: "ct-1" } });
  });

  test("an agent's task is a session's to claim, never a person's", async () => {
    const { t, row } = await setup(
      [{ short_id: "ct-1", assignee: "agent:claude" }],
      { sessions: true },
    );
    expect(await claim(t)).toMatchObject({ task: null });
    const direct = await t.mutation(internal.taskFrontier.claimNextReady, {
      api_token: TOKEN,
      candidates: ["ct-1"],
    });
    expect(direct.skipped).toEqual([
      { short_id: "ct-1", reason: "assigned to an agent" },
    ]);
    expect(
      (await claim(t, { conversation_id: "sess-me" })).task?.short_id,
    ).toBe("ct-1");
    expect((await row("ct-1")).status).toBe("in_progress");
  });

  test("a start refused partway leaves nothing behind and the claim takes the next row", async () => {
    const { t, row, taskIds, mySession, otherSession } = await setup(
      [{ short_id: "ct-1", priority: "urgent" }, { short_id: "ct-2" }],
      { sessions: true, linkedToOther: "ct-1" },
    );
    const res = await claim(t, { conversation_id: "sess-me" });
    expect(res.task?.short_id).toBe("ct-2");
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0]).toMatchObject({ short_id: "ct-1" });
    expect(res.skipped[0].reason).toMatch(/owned by session jot0001/);
    // The refused start had linked this session to ct-1 before ownership
    // refused it; the rollback undid that.
    const ct1 = await row("ct-1");
    expect(ct1).toMatchObject({
      status: "open",
      conversation_ids: [otherSession],
    });
    expect(
      (await t.run(({ db }) => db.query("entity_conversations").collect())).map(
        (link) => link.entity_id,
      ),
    ).toEqual([taskIds["ct-2"]]);
    expect(
      (await t.run(({ db }) => db.query("task_history").collect())).filter(
        (h) => h.task_id === taskIds["ct-1"],
      ),
    ).toHaveLength(0);
    expect((await t.run(({ db }) => db.get(mySession!)))?.active_task_id).toBe(
      taskIds["ct-2"],
    );
  });

  test("a teammate's task is never claimed; the caller's own and its role's are", async () => {
    const { t, row, teammate } = await setup(
      [
        { short_id: "ct-1", priority: "urgent" },
        { short_id: "ct-2", priority: "high" },
        { short_id: "ct-3" },
      ],
      {
        sessions: true,
        assignedToMate: ["ct-1"],
        assignedToOwner: "ct-2",
        assignedToRole: "ct-3",
      },
    );
    expect((await claim(t)).task?.short_id).toBe("ct-2");
    // The teammate's and the role's tasks are still on the ready list: counted.
    expect(await claim(t)).toMatchObject({ task: null, others_passed: 2 });
    expect(
      (await claim(t, { conversation_id: "sess-me" })).task?.short_id,
    ).toBe("ct-3");
    expect(await row("ct-1")).toMatchObject({
      status: "open",
      assignee: teammate,
    });
    // A candidate assigned away after the frontier was read is passed over by name.
    const direct = await t.mutation(internal.taskFrontier.claimNextReady, {
      api_token: TOKEN,
      candidates: ["ct-1"],
    });
    expect(direct).toEqual({
      task: null,
      skipped: [{ short_id: "ct-1", reason: "assigned to Teammate" }],
    });
  });

  test("a blocking decision holds a task against a person's claim too", async () => {
    const { t, row } = await setup(
      [{ short_id: "ct-1", priority: "urgent" }, { short_id: "ct-2" }],
      { held: "ct-1" },
    );
    expect((await claim(t)).task?.short_id).toBe("ct-2");
    expect((await row("ct-1")).status).toBe("open");
    const direct = await t.mutation(internal.taskFrontier.claimNextReady, {
      api_token: TOKEN,
      candidates: ["ct-1"],
    });
    expect(direct.skipped[0].reason).toMatch(/^Held at open by sd-3/);
  });

  test("a stale task is claimed only with stale; an ephemeral one only by the session that filed it", async () => {
    const stale = NOW - STALE_TASK_MS - 1;
    const { t } = await setup(
      [
        { short_id: "ct-1", updated_at: stale, created_at: stale },
        { short_id: "ct-2", ephemeral: true },
      ],
      { sessions: true, ephemeralFrom: "ct-2" },
    );
    expect(await claim(t, { conversation_id: "sess-me" })).toMatchObject({
      task: null,
      stale_passed: 1,
    });
    expect(
      (await claim(t, { conversation_id: "sess-me", stale: true })).task
        ?.short_id,
    ).toBe("ct-1");
    expect(
      (await claim(t, { conversation_id: "sess-other" })).task?.short_id,
    ).toBe("ct-2");
  });

  test("a session the server cannot find yet is refused, never a claim by nobody", async () => {
    const { t, row } = await setup([{ short_id: "ct-1" }], { sessions: true });
    await expect(
      claim(t, { conversation_id: "sess-unsynced" }),
    ).rejects.toThrow(/has not synced yet/);
    expect((await row("ct-1")).status).toBe("open");
  });

  test("the list's filters narrow what a claim may take", async () => {
    const { t } = await setup([
      { short_id: "ct-1", priority: "urgent" },
      { short_id: "ct-2", labels: ["queue"] },
    ]);
    expect((await claim(t, { label: "queue" })).task?.short_id).toBe("ct-2");
  });
});
