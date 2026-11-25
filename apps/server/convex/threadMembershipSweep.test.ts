// The retroactive membership sweep: legacy entity_subscriptions rows get a
// via stamp from the measured heuristics, task thread_reads rows survive only
// for participants under taskThreadParticipants, and rows pointing at deleted
// tasks go away. Dry run counts the same world a live run would leave behind
// and writes nothing.
import { describe, expect, test } from "bun:test";
import type { FunctionArgs } from "convex/server";
import { serverTest } from "../test-helpers/database.testkit";
import { fixtureRows, type NewRow } from "../test-helpers/rows.testkit";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

const taskFields = {
  source: "agent",
  status: "open",
} as const;

type SweepContext = {
  owner: Id<"users">;
  bob: Id<"users">;
  carol: Id<"users">;
  agent: Id<"tasks">;
  human: Id<"tasks">;
  promoted: Id<"tasks">;
  gone: Id<"tasks">;
  conversation: Id<"conversations">;
};

type SweepSeed = {
  tasks?: (Partial<NewRow<"tasks">> & { short_id: string })[];
  entity_subscriptions?: NewRow<"entity_subscriptions">[];
  task_comments?: NewRow<"task_comments">[];
  thread_reads?: NewRow<"thread_reads">[];
};

async function setup(seed: (ids: SweepContext) => SweepSeed) {
  const t = serverTest();
  const ids = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "thread membership sweep");
    const owner = await rows.user({
      name: "Ashot Petrosian",
      github_username: "ashot",
    });
    const bob = await rows.user({ name: "Bob Jones" });
    const carol = await rows.user({ name: "Carol Reed" });
    const conversation = await rows.conversation(owner);
    const agent = await rows.task(owner, { ...taskFields, short_id: "ct-1" });
    const human = await rows.task(owner, { source: "human", short_id: "ct-2" });
    const promoted = await rows.task(owner, {
      ...taskFields,
      promoted: true,
      short_id: "ct-3",
    });
    const gone = await rows.task(owner);
    await db.delete(gone);
    const ids = {
      owner,
      bob,
      carol,
      agent,
      human,
      promoted,
      gone,
      conversation,
    };
    const fields = seed(ids);
    if (fields.tasks) {
      for (const id of [agent, human, promoted]) await db.delete(id);
      for (const task of fields.tasks)
        await rows.task(owner, { ...taskFields, ...task });
    }
    for (const row of fields.entity_subscriptions ?? [])
      await db.insert("entity_subscriptions", row);
    for (const row of fields.task_comments ?? [])
      await db.insert("task_comments", row);
    for (const row of fields.thread_reads ?? [])
      await db.insert("thread_reads", row);
    return ids;
  });
  const page = (
    args: FunctionArgs<typeof internal.threadMembershipSweep.sweepPage>,
  ) => t.mutation(internal.threadMembershipSweep.sweepPage, args);
  return {
    ...ids,
    page,
    subscribeAssignee: (shortId: string, via: "human" | "agent") =>
      t.run(async ({ db }) => {
        const task = await db
          .query("tasks")
          .withIndex("by_short_id", (q) => q.eq("short_id", shortId))
          .unique();
        await db.insert(
          "entity_subscriptions",
          sub(ids.owner, task!._id, "assignee", via),
        );
      }),
    subscriptions: () =>
      t.run(({ db }) => db.query("entity_subscriptions").collect()),
    threadReads: () => t.run(({ db }) => db.query("thread_reads").collect()),
    tasks: () => t.run(({ db }) => db.query("tasks").collect()),
    sweep: () =>
      t.action(internal.threadMembershipSweep.sweep, { dryRun: false }),
    sweepAssignees: () =>
      t.action(internal.threadMembershipSweep.sweepAssignees, {
        dryRun: false,
      }),
  };
}

const sub = (
  user: Id<"users">,
  task: Id<"tasks">,
  reason: NewRow<"entity_subscriptions">["reason"],
  via?: NewRow<"entity_subscriptions">["via"],
): NewRow<"entity_subscriptions"> => ({
  user_id: user,
  entity_type: "task",
  entity_id: task,
  reason,
  muted: false,
  created_at: 1,
  via,
});
const read = (
  user: Id<"users">,
  task: Id<"tasks">,
): NewRow<"thread_reads"> => ({
  user_id: user,
  kind: "task",
  root_key: task,
  task_id: task,
  last_activity_at: 1,
  last_read_at: 0,
  updated_at: 1,
});
const comment = (
  task: Id<"tasks">,
  author: string,
  conversation?: Id<"conversations">,
): NewRow<"task_comments"> => ({
  task_id: task,
  author,
  text: "x",
  comment_type: "note",
  created_at: 1,
  conversation_id: conversation,
});
const subs = (world: Awaited<ReturnType<typeof setup>>, dryRun = false) =>
  world.page({ step: "subscriptions", dryRun });
const reads = (world: Awaited<ReturnType<typeof setup>>, dryRun = false) =>
  world.page({ step: "threadReads", dryRun });

describe("creator stamps follow task origin", () => {
  test("agent origin stamps agent; human origin and promotion stamp human", async () => {
    const c = await setup((ids) => ({
      entity_subscriptions: [
        sub(ids.owner, ids.agent, "creator"),
        sub(ids.owner, ids.human, "creator"),
        sub(ids.owner, ids.promoted, "creator"),
      ],
    }));
    const res = await subs(c);
    expect(res.stamped?.creator).toEqual({ human: 2, agent: 1 });
    const byTask = Object.fromEntries(
      (await c.subscriptions()).map((s) => [s.entity_id, s.via]),
    );
    expect(byTask).toEqual({
      [c.agent]: "agent",
      [c.human]: "human",
      [c.promoted]: "human",
    });
  });
});

describe("assignee stamps: an agent's self-claim for its owner is an agent act", () => {
  test("owner on an agent task is agent; anyone else, or a human task, is human", async () => {
    const c = await setup((ids) => ({
      entity_subscriptions: [
        sub(ids.owner, ids.agent, "assignee"),
        sub(ids.bob, ids.agent, "assignee"),
        sub(ids.owner, ids.human, "assignee"),
      ],
    }));
    const res = await subs(c);
    expect(res.stamped?.assignee).toEqual({ human: 2, agent: 1 });
    const actor = (await c.subscriptions()).find(
      (s) => s.user_id === c.owner && s.entity_id === c.agent,
    );
    expect(actor?.via).toBe("agent");
  });
});

describe("commenter stamps from the originating comment", () => {
  test("a terminal comment whose author loosely matches the user is human", async () => {
    const c = await setup((ids) => ({
      entity_subscriptions: [sub(ids.owner, ids.agent, "commenter")],
      task_comments: [comment(ids.agent, "ashot")],
    }));
    const res = await subs(c);
    expect(res.stamped?.commenter).toEqual({ human: 1, agent: 0 });
  });

  test("a session comment is agent even under the user's full name", async () => {
    const c = await setup((ids) => ({
      entity_subscriptions: [sub(ids.owner, ids.agent, "commenter")],
      task_comments: [comment(ids.agent, "Ashot Petrosian", ids.conversation)],
    }));
    const res = await subs(c);
    expect(res.stamped?.commenter).toEqual({ human: 0, agent: 1 });
  });

  test("agent author labels and non-matching names stamp agent", async () => {
    const c = await setup((ids) => ({
      entity_subscriptions: [
        sub(ids.owner, ids.agent, "commenter"),
        sub(ids.bob, ids.human, "commenter"),
      ],
      task_comments: [
        comment(ids.agent, "Claude"),
        comment(ids.human, "Zed Wilson"),
      ],
    }));
    const res = await subs(c);
    expect(res.stamped?.commenter).toEqual({ human: 0, agent: 2 });
  });
});

describe("stored via and via-independent reasons are untouched", () => {
  test("a stored via survives even when the heuristic disagrees", async () => {
    const c = await setup((ids) => ({
      // Human task: the creator heuristic would say human, but the row says agent.
      entity_subscriptions: [sub(ids.owner, ids.human, "creator", "agent")],
    }));
    const res = await subs(c);
    expect(res.keptStored).toBe(1);
    expect((await c.subscriptions())[0].via).toBe("agent");
  });

  test("mentioned rows keep no via — membership never reads it", async () => {
    const c = await setup((ids) => ({
      entity_subscriptions: [sub(ids.bob, ids.agent, "mentioned")],
    }));
    const res = await subs(c);
    expect(res.viaIndependent).toBe(1);
    expect((await c.subscriptions())[0].via).toBeUndefined();
  });
});

describe("orphans: rows pointing at deleted tasks go away", () => {
  test("subscriptions on a missing task are deleted and counted by reason", async () => {
    const c = await setup((ids) => ({
      entity_subscriptions: [
        sub(ids.owner, ids.gone, "creator"),
        sub(ids.bob, ids.gone, "commenter"),
        sub(ids.owner, ids.agent, "creator"),
      ],
    }));
    const res = await subs(c);
    expect(res.orphans).toEqual({ creator: 1, commenter: 1 });
    expect((await c.subscriptions()).map((s) => s.entity_id)).toEqual([
      c.agent,
    ]);
  });

  test("thread_reads on a missing task are deleted", async () => {
    const c = await setup((ids) => ({
      thread_reads: [read(ids.owner, ids.gone)],
    }));
    const res = await reads(c);
    expect(res.orphans).toBe(1);
    expect((await c.threadReads()).length).toBe(0);
  });
});

describe("thread_reads purge respects taskThreadParticipants", () => {
  const seed = () =>
    setup((ids) => ({
      entity_subscriptions: [
        sub(ids.owner, ids.agent, "creator"), // legacy, stamps agent
        sub(ids.bob, ids.agent, "mentioned"), // enrolls regardless of via
        sub(ids.carol, ids.agent, "commenter", "human"), // own web comment
      ],
      thread_reads: [
        read(ids.owner, ids.agent),
        read(ids.bob, ids.agent),
        read(ids.carol, ids.agent),
      ],
    }));

  test("the owner's identity-only row is purged; mentioned and human commenter survive", async () => {
    const c = await seed();
    await subs(c);
    const res = await reads(c);
    expect(res).toMatchObject({ kept: 2, purged: 1, orphans: 0 });
    expect((await c.threadReads()).map((r) => r.user_id).sort()).toEqual(
      [c.carol, c.bob].sort(),
    );
    expect(res.perUser["Ashot Petrosian"]).toEqual({ purged: 1 });
    expect(res.perUser["Carol Reed"]).toEqual({ kept: 1 });
  });

  test("dry run answers for the post-stamp world: a heuristic-human commenter row is kept", async () => {
    // Pre-stamp, a legacy commenter row on an agent task grants nothing; the
    // stamp it will earn (matching terminal comment) grants membership. The
    // dry run must count the latter.
    const c = await setup((ids) => ({
      entity_subscriptions: [sub(ids.owner, ids.agent, "commenter")],
      task_comments: [comment(ids.agent, "ashot")],
      thread_reads: [read(ids.owner, ids.agent)],
    }));
    const res = await reads(c, true);
    expect(res).toMatchObject({ kept: 1, purged: 0 });
    expect((await c.threadReads()).length).toBe(1);
  });
});

describe("dry run mutates nothing", () => {
  test("both steps report counts and leave the tables alone", async () => {
    const c = await setup((ids) => ({
      entity_subscriptions: [
        sub(ids.owner, ids.agent, "creator"),
        sub(ids.owner, ids.gone, "creator"),
      ],
      thread_reads: [read(ids.owner, ids.agent), read(ids.owner, ids.gone)],
    }));
    const before = [await c.subscriptions(), await c.threadReads()];
    const a = await subs(c, true);
    const b = await reads(c, true);
    expect(a.stamped?.creator.agent).toBe(1);
    expect(a.orphans).toEqual({ creator: 1 });
    expect(b).toMatchObject({ purged: 1, orphans: 1 });
    expect([await c.subscriptions(), await c.threadReads()]).toEqual(before);
    expect(await c.subscriptions()).toHaveLength(2);
    expect((await c.threadReads()).length).toBe(2);
  });

  test("omitting dryRun defaults to dry", async () => {
    const c = await setup((ids) => ({
      entity_subscriptions: [sub(ids.owner, ids.agent, "creator")],
    }));
    const before = await c.subscriptions();
    await c.page({ step: "subscriptions" });
    expect(await c.subscriptions()).toEqual(before);
  });
});

describe("assignee sweep: self-claims leave the human board, real assignments stay", () => {
  const task = (short_id: string, fields: Partial<NewRow<"tasks">> = {}) => ({
    short_id,
    ...fields,
  });

  test("a CLI self-claim on an agent task loses its assignee", async () => {
    const c = await setup((ids) => ({
      tasks: [
        task("ct-10", { assignee: ids.owner }),
        // The live CLI path since ct-44836 still stamps via:"agent" — that row
        // must not protect the assignee.
        task("ct-11", { assignee: ids.owner }),
      ],
    }));
    await c.subscribeAssignee("ct-11", "agent");
    const res = await c.page({
      step: "assignees",
      dryRun: false,
    });
    expect(res).toMatchObject({
      selfAssigned: 2,
      cleared: 2,
      keptHuman: 0,
      keptExplicit: 0,
    });
    expect(res.perUser["Ashot Petrosian"]).toEqual({ cleared: 2 });
    for (const t of await c.tasks()) {
      expect(t.assignee).toBeUndefined();
      expect(t.updated_at).toBeGreaterThan(0);
    }
  });

  test("an explicit web self-assign (via human) is kept", async () => {
    const c = await setup((ids) => ({
      tasks: [task("ct-12", { assignee: ids.owner })],
    }));
    await c.subscribeAssignee("ct-12", "human");
    const res = await c.page({
      step: "assignees",
      dryRun: false,
    });
    expect(res).toMatchObject({ selfAssigned: 1, keptExplicit: 1, cleared: 0 });
    expect((await c.tasks())[0].assignee).toBe(c.owner);
  });

  test("human-origin and promoted tasks keep the owner's assignment", async () => {
    const c = await setup((ids) => ({
      tasks: [
        task("ct-13", { source: "human", assignee: ids.owner }),
        task("ct-14", { promoted: true, assignee: ids.owner }),
      ],
    }));
    const res = await c.page({
      step: "assignees",
      dryRun: false,
    });
    expect(res).toMatchObject({ selfAssigned: 2, keptHuman: 2, cleared: 0 });
    expect((await c.tasks()).map((t) => t.assignee)).toEqual([
      c.owner,
      c.owner,
    ]);
  });

  test("an assignee who is not the owner is not a candidate", async () => {
    const c = await setup((ids) => ({
      tasks: [
        task("ct-15", { assignee: ids.bob }),
        task("ct-16", { assignee: "agent:claude" }),
        task("ct-17", {}),
      ],
    }));
    const res = await c.page({
      step: "assignees",
      dryRun: false,
    });
    expect(res).toMatchObject({ scanned: 3, selfAssigned: 0, cleared: 0 });
    expect((await c.tasks()).map((task) => task.assignee)).toEqual([
      c.bob,
      "agent:claude",
      undefined,
    ]);
  });

  test("dry run counts but writes nothing (and is the default)", async () => {
    const c = await setup((ids) => ({
      tasks: [task("ct-10", { assignee: ids.owner })],
    }));
    const res = await c.page({ step: "assignees" });
    expect(res).toMatchObject({ cleared: 1 });
    expect((await c.tasks())[0].assignee).toBe(c.owner);
  });

  test("the driver pages through and a second live run finds nothing", async () => {
    const c = await setup(({ owner, bob }) => ({
      tasks: [
        ...Array.from({ length: 450 }, (_, i) =>
          task(`ct-${i + 100}`, {
            assignee: i % 2 ? owner : bob,
            user_id: i % 2 ? owner : bob,
          }),
        ),
        task("ct-13", { source: "human", assignee: owner }),
      ],
    }));
    const first = await c.sweepAssignees();
    expect(first.assignees).toMatchObject({
      scanned: 451,
      selfAssigned: 451,
      keptHuman: 1,
      cleared: 450,
    });
    const again = await c.sweepAssignees();
    expect(again.assignees).toMatchObject({
      selfAssigned: 1,
      keptHuman: 1,
      cleared: 0,
    });
  });
});

describe("the driver action pages through everything and is idempotent", () => {
  test("totals merge across pages; a second live run finds nothing to do", async () => {
    const c = await setup(({ owner, bob, agent, gone }) => ({
      entity_subscriptions: [
        ...Array.from({ length: 450 }, (_, i) =>
          sub(i % 2 ? owner : bob, agent, "creator"),
        ),
        sub(owner, gone, "commenter"),
      ],
      thread_reads: [read(owner, agent), read(bob, agent)],
    }));
    const first = await c.sweep();
    expect(first.subscriptions.scanned).toBe(451);
    expect(first.subscriptions.stamped.creator.agent).toBe(450);
    expect(first.subscriptions.orphans).toEqual({ commenter: 1 });
    // Neither the owner (identity-only creator) nor Bob (agent-stamped creator)
    // is a participant, so both rows go.
    expect(first.threadReads).toMatchObject({ kept: 0, purged: 2 });

    const again = await c.sweep();
    expect(again.subscriptions.keptStored).toBe(450);
    expect(again.subscriptions.stamped).toEqual({});
    expect(again.threadReads.scanned).toBe(0);
  });
});
