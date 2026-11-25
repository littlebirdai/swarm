// Assigning a task to someone ELSE is a handoff: the assigner's follow of the
// task thread ends. The mutation mutes the assigner (the durable marker every
// membership leg respects) and deletes their thread_reads row, so the card
// leaves their Threads inbox at once. Human acts only — an agent assigning
// under its owner's token must not silently unfollow the owner — and
// re-engagement (ensureSubscribed) clears the mute.
import { describe, expect, test } from "bun:test";
import type { FunctionArgs } from "convex/server";
import { taskTest } from "../test-helpers/tasks.testkit";
import { api, internal } from "./_generated/api";

const TOKEN = "handoff-test-token";

async function setup(...shortIds: string[]) {
  const world = await taskTest(
    "assignment handoff",
    TOKEN,
    shortIds.map((short_id) => ({ short_id })),
  );
  await world.t.run(async ({ db }) => {
    for (const task of world.taskIds) {
      await db.insert("thread_reads", {
        user_id: world.owner,
        kind: "task",
        root_key: task,
        task_id: task,
        last_activity_at: 100,
        last_read_at: 0,
        updated_at: 100,
      });
    }
  });
  return {
    ...world,
    muted: async () => (await world.subscriptions()).filter((s) => s.muted),
    reads: () => world.t.run(({ db }) => db.query("thread_reads").collect()),
  };
}

describe("assigning to someone else hands the thread off", () => {
  test("webUpdate: the assigner is muted and their thread row is dropped", async () => {
    const { web, owner, taskIds, reads, muted } = await setup("ct-1");
    await web.mutation(api.tasks.webUpdate, {
      short_id: "ct-1",
      assignee: "bob",
    });
    expect(await muted()).toEqual([
      expect.objectContaining({
        user_id: owner,
        entity_type: "task",
        entity_id: taskIds[0],
        muted: true,
      }),
    ]);
    expect(await reads()).toEqual([]);
  });

  test("CLI update by hand hands off; the same call from inside a session does not", async () => {
    const { t, taskIds, reads, muted } = await setup("ct-1", "ct-2");
    await t.mutation(api.tasks.update, {
      api_token: TOKEN,
      short_id: "ct-1",
      assignee: "bob",
    });
    expect(await muted()).toHaveLength(1);
    expect((await reads()).map((r) => r.root_key)).toEqual([taskIds[1]]);

    await t.mutation(api.tasks.update, {
      api_token: TOKEN,
      short_id: "ct-2",
      assignee: "bob",
      conversation_id: "sess-1",
    });
    expect(await muted()).toHaveLength(1);
    expect((await reads()).map((r) => r.root_key)).toEqual([taskIds[1]]);
  });

  test("batchAssign hands off every task it assigns away", async () => {
    const { t, reads, muted } = await setup("ct-1", "ct-2");
    await t.mutation(api.tasks.batchAssign, {
      api_token: TOKEN,
      short_ids: ["ct-1", "ct-2"],
      assignee: "bob",
    });
    expect(await muted()).toHaveLength(2);
    expect(await reads()).toEqual([]);
  });

  test("create with an assignee mutes the creator, so the stream never files for them", async () => {
    const { t, owner, muted } = await setup();
    await t.mutation(api.tasks.create, {
      api_token: TOKEN,
      title: "for bob",
      assignee: "bob",
    });
    expect(await muted()).toEqual([
      expect.objectContaining({ user_id: owner, muted: true }),
    ]);
  });

  test("assigning yourself, or an agent label, is no handoff", async () => {
    const { web, reads, muted } = await setup("ct-1", "ct-2");
    await web.mutation(api.tasks.webUpdate, {
      short_id: "ct-1",
      assignee: "owner",
    });
    await web.mutation(api.tasks.webUpdate, {
      short_id: "ct-2",
      assignee: "agent:codex",
    });
    expect(await muted()).toEqual([]);
    expect(await reads()).toHaveLength(2);
  });
});

describe("the mute marker: written by setSubscriptionMuted, cleared by re-engagement", () => {
  async function provision(seed = false) {
    const world = await taskTest("task mute", TOKEN, [{ short_id: "ct-1" }]);
    const base = {
      user_id: world.owner,
      entity_type: "task",
      entity_id: world.taskIds[0],
    } as const;
    if (seed) {
      await world.t.run(({ db }) =>
        db.insert("entity_subscriptions", {
          ...base,
          reason: "creator",
          via: "human",
          muted: true,
          created_at: 1,
        }),
      );
    }
    return {
      ...world,
      setMuted: (muted: boolean) =>
        world.t.mutation(internal.notificationRouter.setSubscriptionMuted, {
          ...base,
          muted,
        }),
      subscribe: (
        args: Pick<
          FunctionArgs<typeof internal.notificationRouter.ensureSubscribed>,
          "reason" | "via"
        >,
      ) =>
        world.t.mutation(internal.notificationRouter.ensureSubscribed, {
          ...base,
          ...args,
        }),
    };
  }

  test("no subscription row: muting files a muted watching row; unmuting files nothing", async () => {
    const { owner, setMuted, subscriptions } = await provision();
    await setMuted(false);
    expect(await subscriptions()).toEqual([]);
    await setMuted(true);
    expect(await subscriptions()).toEqual([
      expect.objectContaining({
        user_id: owner,
        reason: "watching",
        muted: true,
      }),
    ]);
  });

  test("an existing row is patched in place, whatever its reason", async () => {
    const { setMuted, subscriptions } = await provision(true);
    await setMuted(false);
    const [before] = await subscriptions();
    await setMuted(true);
    expect(await subscriptions()).toEqual([{ ...before, muted: true }]);
    expect((await subscriptions())[0].reason).toBe("creator");
  });

  test("re-engagement unmutes: a human act of one's own, or being assigned or mentioned by anyone; an agent comment never", async () => {
    const drive = async (
      args: Parameters<Awaited<ReturnType<typeof provision>>["subscribe"]>[0],
    ) => {
      const { subscribe, subscriptions } = await provision(true);
      await subscribe(args);
      return (await subscriptions())[0].muted;
    };
    expect(await drive({ reason: "commenter", via: "human" })).toBe(false);
    expect(await drive({ reason: "assignee", via: "agent" })).toBe(false);
    expect(await drive({ reason: "mentioned", via: "agent" })).toBe(false);
    expect(await drive({ reason: "commenter", via: "agent" })).toBe(true);
    expect(await drive({ reason: "creator" })).toBe(true);
  });
});
