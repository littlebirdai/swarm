import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { decommissionAnchorRow } from "./anchors";
import { sessionMachine } from "@codecast/session-contract";
import { settleRunConversation } from "./agentTasks";
import { applyFileSession } from "./lib/orgSessionFiling";
import { api, internal } from "./_generated/api";
import { restoreToInbox } from "./inboxFilters";
import { resumeConversationSession } from "./daemonCommandUtils";
import { asUser, serverTest } from "../test-helpers/database.testkit";
import { fixtureRows, type NewRow } from "../test-helpers/rows.testkit";

const now = 1_750_000_000_000;
const old = now - 10 * 86_400_000;
const unset = { $undefined: null };
const token = "p".repeat(64);
const pin = {
  thread_state: "Done",
  thread_state_status: "done",
  thread_state_at: old,
  thread_state_msg_count: 1,
  thread_state_result: "Result",
  thread_state_result_at: old,
} as const;
const clearPin = Object.fromEntries(
  Object.keys(pin).map((key) => [key, unset]),
);

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(now);
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

type Fields = Record<string, unknown>;
type AsyncSyscall = (op: string, args: string) => Promise<string>;

async function conversationPatches<T>(run: () => Promise<T>) {
  const runtime = (globalThis as unknown as { Convex: object }).Convex;
  const original = Object.getOwnPropertyDescriptor(runtime, "asyncSyscall")!;
  const patches: { id: string; fields: Fields }[] = [];
  Object.defineProperty(runtime, "asyncSyscall", {
    ...original,
    get() {
      const call: AsyncSyscall = original.get!.call(runtime);
      return async (op: string, args: string) => {
        const result = await call(op, args);
        if (op === "1.0/shallowMerge") {
          const { id, value } = JSON.parse(args);
          if (id.endsWith("conversations")) patches.push({ id, fields: value });
        }
        return result;
      };
    },
  });
  try {
    return { result: await run(), patches };
  } finally {
    Object.defineProperty(runtime, "asyncSyscall", original);
  }
}

async function seed(fields: Partial<NewRow<"conversations">> = {}) {
  const t = serverTest();
  const ids = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "pin and inbox placement replay");
    const user = await rows.user();
    await rows.token(user, token);
    const parent = await rows.conversation(user, {
      session_id: "parent-trace",
      started_at: now,
      updated_at: now,
    });
    const id = await rows.conversation(user, {
      session_id: "pin-trace",
      started_at: old,
      updated_at: now,
      message_count: 1,
      ...fields,
    });
    return { user, id, parent };
  });
  return { t, viewer: asUser(t, ids.user), ...ids };
}

test("empty thread state clears the declaration and result in one patch", async () => {
  const { viewer, id } = await seed(pin);
  const { patches } = await conversationPatches(() =>
    viewer.mutation(api.sessionThreadState.setThreadState, {
      session: id,
      text: "",
    }),
  );
  expect(patches).toEqual([{ id, fields: clearPin }]);
});

for (const favorite of [false, true]) {
  test(`generic ${favorite ? "favorite" : "conversation"} patch keeps placement and other fields together`, async () => {
    const { t, viewer, id } = await seed();
    const fields = {
      inbox_stashed_at: now - 2,
      title: "Revised",
      ...(favorite ? { is_favorite: true } : {}),
    };
    const { patches } = await conversationPatches(() =>
      viewer.mutation(api.dispatch.dispatch, {
        action: "closeSession",
        args: [id],
        patches: { conversations: { [id]: fields } },
      }),
    );
    expect(patches).toEqual([{ id, fields }]);
    expect(await t.run(({ db }) => db.get(id))).toMatchObject(fields);
  });
}

test("dismissal sets only the placement stamp", async () => {
  const { viewer, id, t } = await seed();
  const { patches } = await conversationPatches(() =>
    viewer.mutation(api.inboxShelves.dismissFromInbox, {
      conversation_id: id,
    }),
  );
  expect(patches).toEqual([{ id, fields: { inbox_dismissed_at: now } }]);
  expect((await t.run(({ db }) => db.get(id)))?.status).toBe(
    sessionMachine.initial({ session: "pin-trace", run: 1 }).status,
  );
});

test("the stale dismiss job skips fresh conversations", async () => {
  const { t, id, user } = await seed({ updated_at: old });
  const { patches } = await conversationPatches(() =>
    t.mutation(internal.inboxShelves.drainStaleDismiss, {
      userId: user,
      cutoff: now - 1,
      cursor: null,
      attempt: 0,
    }),
  );
  expect(patches).toEqual([{ id, fields: { inbox_dismissed_at: now } }]);
});

test("timestamp repair keeps its rewind and dismissal in one patch", async () => {
  const { viewer, id } = await seed();
  const { patches } = await conversationPatches(() =>
    viewer.mutation(api.conversationPrivacy.healHistoricalUpdatedAt, {}),
  );
  expect(patches).toEqual([
    { id, fields: { updated_at: old, inbox_dismissed_at: now } },
  ]);
});

for (const admin of [false, true]) {
  test(`${admin ? "admin" : "owner"} linking dismisses the child in the same patch`, async () => {
    const { viewer, id, parent } = await seed();
    const { patches } = await conversationPatches(async () => {
      if (admin) {
        return viewer.mutation(
          api.sessionHierarchy.adminLinkChildrenBySessionId,
          {
            parent_session_id: "parent-trace",
            child_session_ids: ["pin-trace"],
            api_token: token,
          },
        );
      }
      return viewer.mutation(api.sessionHierarchy.linkSessions, {
        parent_conversation_id: parent,
        child_conversation_id: id,
      });
    });
    expect(patches).toEqual([
      {
        id,
        fields: {
          parent_conversation_id: parent,
          is_subagent: true,
          inbox_dismissed_at: now,
        },
      },
    ]);
  });
}

for (const selfParented of [false, true]) {
  test(`${selfParented ? "self-parent repair" : "admin unlink"} clears nesting and dismissal together`, async () => {
    const { viewer, t, id, parent } = await seed({
      inbox_dismissed_at: old,
      is_subagent: true,
    });
    await t.run(({ db }) =>
      db.patch(id, { parent_conversation_id: selfParented ? id : parent }),
    );
    const { patches } = await conversationPatches(async () => {
      if (selfParented)
        return t.mutation(internal.debugTmp.unnestSelfParented, {
          ids: [id],
          dryRun: false,
        });
      return viewer.mutation(api.sessionHierarchy.adminUnlinkSession, {
        session_id: "pin-trace",
        api_token: token,
      });
    });
    expect(patches).toEqual([
      {
        id,
        fields: {
          parent_conversation_id: unset,
          is_subagent: unset,
          inbox_dismissed_at: unset,
          ...(selfParented
            ? { subagent_description: unset, cli_flags: unset }
            : {}),
        },
      },
    ]);
  });
}

test("restore clears placement without writes for a killed row", async () => {
  const { t, id, parent } = await seed({
    inbox_dismissed_at: old,
    inbox_stashed_at: old,
  });
  await t.run(({ db }) =>
    db.patch(parent, { inbox_dismissed_at: old, inbox_killed_at: old }),
  );
  const { result, patches } = await conversationPatches(() =>
    t.run(async (ctx) => [
      await restoreToInbox(ctx, (await ctx.db.get(id))!),
      await restoreToInbox(ctx, (await ctx.db.get(parent))!),
    ]),
  );
  expect(result).toEqual([true, false]);
  expect(patches).toEqual([
    { id, fields: { inbox_dismissed_at: unset, inbox_stashed_at: unset } },
  ]);
});

test("resume removes dismissal and leaves the close stamp", async () => {
  const { t, id, user } = await seed({
    inbox_closed_at: old,
    inbox_dismissed_at: old,
  });
  const { patches } = await conversationPatches(() =>
    t.run((ctx) => resumeConversationSession(ctx, user, id)),
  );
  expect(patches).toEqual([{ id, fields: { inbox_dismissed_at: unset } }]);
  expect((await t.run(({ db }) => db.get(id)))?.inbox_closed_at).toBe(old);
});

test("copied child stash repair clears the stamp and hidden flag", async () => {
  const { t, id, parent, user } = await seed({
    inbox_stashed_at: old,
    inbox_stash_hidden: true,
    is_subagent: true,
  });
  await t.run(async ({ db }) => {
    await db.patch(id, { parent_conversation_id: parent });
    await db.patch(parent, { inbox_stashed_at: old });
  });
  const { patches } = await conversationPatches(() =>
    t.mutation(internal.migrations.clearCopiedChildStashStamps, {
      user_id: user,
      dry_run: false,
    }),
  );
  expect(patches).toEqual([
    { id, fields: { inbox_stashed_at: unset, inbox_stash_hidden: unset } },
  ]);
});

test("starting a goal queues its input before clearing the goal outcome pin", async () => {
  const { viewer, id } = await seed({
    ...pin,
    thread_state: "Goal met: all checks passed",
  });
  const { patches } = await conversationPatches(() =>
    viewer.mutation(api.dispatch.dispatch, {
      action: "setSessionGoal",
      args: [id, "Verify the next release", "new-goal-trace"],
    }),
  );
  expect(patches).toEqual([
    { id, fields: { has_pending_messages: true, updated_at: now } },
    { id, fields: clearPin },
  ]);
});

test("giving a session an owner clears its triage before caching the owner", async () => {
  const { viewer, id, user } = await seed({
    inbox_dismissed_at: old,
    inbox_stashed_at: old,
    inbox_stash_hidden: true,
    inbox_snoozed_until: now + 1,
  });
  const { patches } = await conversationPatches(() =>
    viewer.mutation(api.sessionOwnership.setSessionOwner, {
      session_id: id,
      owner: "me",
    }),
  );
  expect(patches).toEqual([
    {
      id,
      fields: {
        inbox_dismissed_at: unset,
        inbox_stashed_at: unset,
        inbox_stash_hidden: unset,
        inbox_snoozed_until: unset,
      },
    },
    { id, fields: { owner_user_id: user } },
    {
      id,
      fields: {
        has_pending_messages: true,
        inbox_dismissed_at: unset,
        inbox_snoozed_until: unset,
        inbox_stashed_at: unset,
        updated_at: now,
      },
    },
  ]);
});

async function seedRun() {
  const seeded = await seed();
  const { t, user, parent } = seeded;
  const task = await t.run(({ db }) =>
    db.insert("agent_tasks", {
      user_id: user,
      title: "Verify deployment",
      prompt: "Verify it",
      schedule_type: "recurring",
      mode: "apply",
      status: "running",
      retry_count: 0,
      run_count: 1,
      created_at: old,
      last_run_conversation_id: parent,
    }),
  );
  return { ...seeded, task };
}

test("linking a recurring run stashes it before folding the previous run", async () => {
  const { t, id, parent, task } = await seedRun();
  const { result, patches } = await conversationPatches(() =>
    t.mutation(api.agentTasks.linkRunConversation, {
      api_token: token,
      task_id: task,
      run_session_uuid: "pin-trace",
    }),
  );
  expect(result).toEqual({ linked: true, retry: false });
  expect(patches).toEqual([
    { id, fields: { agent_task_id: task, inbox_stashed_at: now } },
    { id: parent, fields: { inbox_stashed_at: now } },
  ]);
});

test("settling a recurring run records the pin before stashing the run", async () => {
  const { t, id, task } = await seedRun();
  const { patches } = await conversationPatches(() =>
    t.run(async (ctx) =>
      settleRunConversation(
        ctx,
        (await ctx.db.get(task))!,
        (await ctx.db.get(id))!,
        { summary: "Verified" },
        now,
      ),
    ),
  );
  expect(patches).toEqual([
    {
      id,
      fields: {
        thread_state: "Verified",
        thread_state_at: now,
        thread_state_msg_count: 1,
        thread_state_status: "done",
        thread_state_result: unset,
        thread_state_result_at: unset,
      },
    },
    { id, fields: { inbox_stashed_at: now } },
  ]);
});

test("filing a session as done stamps dismissal once", async () => {
  const { t, id, user } = await seed();
  const { patches } = await conversationPatches(() =>
    t.run((ctx) =>
      applyFileSession(
        ctx,
        user,
        { scope_user_id: user },
        { kind: "file_session", session: id, to: "done" },
        { provision: false, human_decision: "accepted" },
      ),
    ),
  );
  expect(patches).toEqual([{ id, fields: { inbox_dismissed_at: now } }]);
});

test("retiring an anchor unpins its session before killing it", async () => {
  const { t, id, user } = await seed({
    persistent: true,
    inbox_pinned_at: old,
  });
  const anchor = await t.run(async ({ db }) => {
    const bot = await fixtureRows(db, "anchor pin replay").user({
      is_bot: true,
    });
    return db.insert("anchors", {
      scope_type: "user",
      scope_user_id: user,
      host_user_id: user,
      bot_user_id: bot,
      conversation_id: id,
      name: "Standing agent",
      status: "active",
      created_at: old,
    });
  });
  const { patches } = await conversationPatches(() =>
    t.run(async (ctx) => decommissionAnchorRow(ctx, await ctx.db.get(anchor))),
  );
  expect(patches).toEqual([
    { id, fields: { persistent: false, inbox_pinned_at: unset } },
    { id, fields: { status: "completed", inbox_killed_at: now } },
    { id, fields: { pending_kill_generation: 1 } },
    { id, fields: { has_pending_messages: false } },
  ]);
});
