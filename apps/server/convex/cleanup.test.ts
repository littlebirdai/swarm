import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import {
  isGcableEmptyConversation,
  hasLiveDraft,
  shouldReapEmpty,
  conversationHasNoWork,
  reapEmptyConversation,
  cascadeHideToNestedChildren,
  applyHideTransition,
} from "./cleanup";
import { enqueuePendingMessage } from "./pendingMessages";

import { scheduledJobs, serverTest } from "../test-helpers/database.testkit";
import { fixtureRows, type NewRow } from "../test-helpers/rows.testkit";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

async function setup(fields: Partial<NewRow<"conversations">> = {}) {
  const t = serverTest();
  const { user, conversation } = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "conversation cleanup");
    const user = await rows.user();
    const conversation = await rows.conversation(user, {
      session_id: "s-1",
      ...fields,
    });
    return { user, conversation };
  });
  const read = () => t.run(({ db }) => db.get(conversation));
  return {
    t,
    user,
    conversation,
    read,
    commands: () => t.run(({ db }) => db.query("daemon_commands").collect()),
    reap: () =>
      t.mutation(async (ctx) =>
        reapEmptyConversation(ctx, (await ctx.db.get(conversation))!),
      ),
    noWork: () =>
      t.query(async (ctx) =>
        conversationHasNoWork(ctx, (await ctx.db.get(conversation))!),
      ),
    managed: (heartbeat: number) =>
      t.run(({ db }) =>
        fixtureRows(db, "managed cleanup session").session(user, {
          conversation_id: conversation,
          last_heartbeat: heartbeat,
        }),
      ),
    message: (fields: Partial<NewRow<"pending_messages">> = {}) =>
      t.run(({ db }) =>
        db.insert("pending_messages", {
          conversation_id: conversation,
          from_user_id: user,
          content: "Queued message",
          status: "pending",
          retry_count: 0,
          created_at: 1,
          ...fields,
        }),
      ),
    seedKill: () =>
      t.run(({ db }) =>
        db.insert("daemon_commands", {
          user_id: user,
          command: "kill_session",
          args: JSON.stringify({ conversation_id: conversation }),
          created_at: Date.now(),
        }),
      ),
    trigger: () =>
      t.run(({ db }) =>
        db.insert("agent_tasks", {
          user_id: user,
          originating_conversation_id: conversation,
          title: "Check CI",
          prompt: "Check CI",
          status: "scheduled",
          schedule_type: "recurring",
          interval_ms: 3600000,
          mode: "apply",
          retry_count: 0,
          run_count: 0,
          created_at: 1,
        }),
      ),
    hide: (
      patch: { inbox_dismissed_at?: number; inbox_stashed_at?: number },
      options?: Parameters<typeof applyHideTransition>[3],
    ) =>
      t.mutation(async (ctx) => {
        const before = (await ctx.db.get(conversation))!;
        await ctx.db.patch(conversation, patch);
        return applyHideTransition(ctx, before, patch, options);
      }),
  };
}

// Row-level qualification for the abandoned empty-conversation GC. Anything
// signaling user intent or attached work must disqualify — these rows get
// HARD-DELETED, so the predicate errs closed.
describe("isGcableEmptyConversation", () => {
  test("a plain abandoned blank row qualifies", () => {
    expect(isGcableEmptyConversation({ message_count: 0 })).toBe(true);
    expect(isGcableEmptyConversation({})).toBe(true);
  });

  test("anything with messages or pending sends is kept", () => {
    expect(isGcableEmptyConversation({ message_count: 1 })).toBe(false);
    expect(
      isGcableEmptyConversation({
        message_count: 0,
        has_pending_messages: true,
      }),
    ).toBe(false);
  });

  test("user intent keeps the row: drafts, pins, favorites, custom titles, shares", () => {
    expect(
      isGcableEmptyConversation({ draft_message: "half-typed thought" }),
    ).toBe(false);
    expect(isGcableEmptyConversation({ draft_message: "   " })).toBe(true); // whitespace ≠ intent
    expect(isGcableEmptyConversation({ inbox_pinned_at: 123 })).toBe(false);
    expect(isGcableEmptyConversation({ inbox_snoozed_until: 123 })).toBe(false);
    expect(isGcableEmptyConversation({ is_favorite: true })).toBe(false);
    expect(isGcableEmptyConversation({ title_is_custom: true })).toBe(false);
    expect(isGcableEmptyConversation({ share_token: "tok" })).toBe(false);
  });

  test("attached work keeps the row: tasks, plans, workflows, forks, subagents", () => {
    expect(isGcableEmptyConversation({ active_task_id: "t" })).toBe(false);
    expect(isGcableEmptyConversation({ active_plan_id: "p" })).toBe(false);
    expect(isGcableEmptyConversation({ plan_ids: ["p"] })).toBe(false);
    expect(isGcableEmptyConversation({ workflow_run_id: "w" })).toBe(false);
    expect(isGcableEmptyConversation({ is_workflow_primary: true })).toBe(
      false,
    );
    expect(isGcableEmptyConversation({ forked_from: "c" })).toBe(false);
    // A fork mid-copy legitimately has 0 messages — never sweep it.
    expect(isGcableEmptyConversation({ fork_status: "copying" })).toBe(false);
    expect(isGcableEmptyConversation({ is_subagent: true })).toBe(false);
    expect(isGcableEmptyConversation({ parent_conversation_id: "c" })).toBe(
      false,
    );
  });
});

// The narrow exception to the daemon's "dismissal isn't a worker lifecycle
// signal" rule: a live heartbeat protects an empty pre-warm ONLY while it's still
// active. A dismissed empty pre-warm is cruft — its idle agent gets reaped.
describe("shouldReapEmpty", () => {
  test("an undismissed empty with a live agent is protected (fresh pre-warm / open terminal)", () => {
    expect(shouldReapEmpty({}, true)).toBe(false);
  });
  test("a DISMISSED empty with a live agent is reaped — this is the zombie-agent fix", () => {
    expect(shouldReapEmpty({ inbox_dismissed_at: 123 }, true)).toBe(true);
  });
  test("an empty with no live agent is always reaped, dismissed or not", () => {
    expect(shouldReapEmpty({}, false)).toBe(true);
    expect(shouldReapEmpty({ inbox_dismissed_at: 123 }, false)).toBe(true);
  });
  test("a STASHED empty with a live agent is reaped — an empty blank has nothing worth keeping alive", () => {
    expect(shouldReapEmpty({ inbox_stashed_at: 123 }, true)).toBe(true);
    expect(shouldReapEmpty({ inbox_stashed_at: 123 }, false)).toBe(true);
  });
});

describe("reapEmptyConversation", () => {
  test("a LIVE agent → enqueue kill_session and DEFER deletion (deleting first orphans the tmux)", async () => {
    const c = await setup();
    const managed = await c.managed(Date.now());
    await c.t.run(({ db }) =>
      db.insert("conversation_git_diffs", {
        conversation_id: c.conversation,
        updated_at: 1,
      }),
    );
    expect(await c.reap()).toBe("kill_enqueued");
    const commands = await c.commands();
    expect(commands).toHaveLength(1);
    expect(commands[0].command).toBe("kill_session");
    expect(JSON.parse(commands[0].args!).conversation_id).toBe(c.conversation);
    expect(await c.read()).not.toBeNull();
    expect(await c.t.run(({ db }) => db.get(managed))).not.toBeNull();
  });

  test("no live agent (stale managed row) → delete the conversation + stale row + diffs, no kill", async () => {
    const c = await setup();
    const managed = await c.managed(Date.now() - 2 * 60 * 60 * 1000);
    const diff = await c.t.run(({ db }) =>
      db.insert("conversation_git_diffs", {
        conversation_id: c.conversation,
        updated_at: 1,
      }),
    );
    expect(await c.reap()).toBe("deleted");
    expect(await c.commands()).toEqual([]);
    expect(await c.read()).toBeNull();
    const remaining = await c.t.run(async ({ db }) => [
      await db.get(managed),
      await db.get(diff),
    ]);
    expect(remaining).toEqual([null, null]);
  });

  test("no managed session at all → delete the empty conversation, no kill", async () => {
    const c = await setup();
    expect(await c.reap()).toBe("deleted");
    expect(await c.commands()).toEqual([]);
    expect(await c.read()).toBeNull();
  });

  test("a live agent with a kill already pending → no duplicate command (dedup)", async () => {
    const c = await setup();
    await c.managed(Date.now());
    const queued = await c.seedKill();
    expect(await c.reap()).toBe("kill_enqueued");
    expect((await c.commands()).map((command) => command._id)).toEqual([
      queued,
    ]);
  });
});

describe("conversationHasNoWork", () => {
  test("a truly empty conversation has no work", async () => {
    const c = await setup();
    expect(await c.noWork()).toBe(true);
  });

  test("an actual message keeps it (denormalized count can lag)", async () => {
    const c = await setup();
    await c.t.run(({ db }) =>
      fixtureRows(db, "message keeps session").message(c.conversation),
    );
    expect(await c.noWork()).toBe(false);
  });

  test("a pending send keeps it", async () => {
    const c = await setup();
    await c.message();
    expect(await c.noWork()).toBe(false);
  });

  test("a live per-user draft for this conversation keeps it", async () => {
    const c = await setup();
    await c.t.run(({ db }) =>
      db.insert("client_state", {
        user_id: c.user,
        drafts: { [c.conversation]: { draft_message: "wip" } },
        updated_at: 1,
      }),
    );
    expect(await c.noWork()).toBe(false);
  });

  test("row-level intent (custom title) keeps it without touching the source tables", async () => {
    const c = await setup({ title_is_custom: true });
    await c.t.query(async (ctx) => {
      const doc = (await ctx.db.get(c.conversation))!;
      expect(await conversationHasNoWork(ctx, doc)).toBe(false);
      expect((await ctx.meta.getTransactionMetrics()).documentsRead.used).toBe(
        1,
      );
    });
  });
});

describe("hasLiveDraft", () => {
  test("non-empty text or attachments count as a live draft", () => {
    expect(hasLiveDraft({ draft_message: "wip" })).toBe(true);
    expect(hasLiveDraft({ draft_message: "", draft_images: ["s1"] })).toBe(
      true,
    );
  });

  test("cleared or empty entries do not", () => {
    expect(hasLiveDraft(null)).toBe(false);
    expect(hasLiveDraft(undefined)).toBe(false);
    expect(hasLiveDraft({ draft_message: "" })).toBe(false);
    expect(hasLiveDraft({ draft_message: "   " })).toBe(false);
    expect(hasLiveDraft({})).toBe(false);
  });
});

// Server-side hide cascade: killing a session takes the whole nested group
// (Task subagents + agent-team teammates) — the same set the inbox renders
// beneath the card; stashing one stamps its teammates. Bug history: cast kill
// on a team lead stranded its teammates as loose top-level needs-input cards
// (only the web store's optimistic sweep cascaded, and only over
// parent_conversation_id).
describe("cascadeHideToNestedChildren", () => {
  async function group(additional = 0) {
    const c = await setup({
      agent_team_name: "session-team",
      agent_name: "team-lead",
      message_count: 10,
    });
    const group = await c.t.run(async ({ db }) => {
      const rows = fixtureRows(db, "nested conversations");
      const sub = await rows.conversation(c.user, {
        parent_conversation_id: c.conversation,
        is_subagent: true,
        message_count: 5,
      });
      const mate = await rows.conversation(c.user, {
        spawned_by_conversation_id: c.conversation,
        agent_team_name: "session-team",
        agent_name: "review-worker",
        message_count: 5,
      });
      const spawn = await rows.conversation(c.user, {
        spawned_by_conversation_id: c.conversation,
        message_count: 5,
      });
      const fork = await rows.conversation(c.user, {
        forked_from: c.conversation,
        message_count: 5,
      });
      for (let i = 0; i < additional; i++)
        await rows.conversation(c.user, {
          parent_conversation_id: c.conversation,
          is_subagent: true,
          message_count: 5,
        });
      return { sub, mate, spawn, fork };
    });
    return {
      ...c,
      ...group,
      child: (id: Id<"conversations">) =>
        c.t.run(async ({ db }) => (await db.get(id))!),
      cascade: (
        patch: Parameters<typeof cascadeHideToNestedChildren>[2],
        opts?: Parameters<typeof cascadeHideToNestedChildren>[3],
      ) =>
        c.t.mutation(async (ctx) =>
          cascadeHideToNestedChildren(
            ctx,
            (await ctx.db.get(c.conversation))!,
            patch,
            opts,
          ),
        ),
    };
  }

  test("kill cascade dismisses Task subagents AND teammates, with full kill side effects", async () => {
    const c = await group();
    expect(await c.cascade({ inbox_dismissed_at: 111 })).toBe(2);
    expect(await c.child(c.sub)).toMatchObject({
      inbox_dismissed_at: 111,
      status: "completed",
    });
    expect(await c.child(c.mate)).toMatchObject({ inbox_dismissed_at: 111 });
    expect((await c.child(c.mate)).inbox_killed_at).toBeGreaterThan(0);
    expect(await c.commands()).toHaveLength(2);
    expect((await c.child(c.spawn)).inbox_dismissed_at).toBeUndefined();
    expect((await c.child(c.fork)).inbox_dismissed_at).toBeUndefined();
  });

  test("a FORCED kill re-tears-down already-hidden children (group comes down as one unit)", async () => {
    const c = await group();
    await c.cascade({ inbox_dismissed_at: 111 });
    const commands = await c.commands();
    expect(commands).toHaveLength(2);
    await c.t.run(async ({ db }) => {
      for (const command of commands)
        await db.patch(command._id, { executed_at: 1 });
    });
    const firstKilledAt = (await c.child(c.sub)).inbox_killed_at;
    expect(
      await c.cascade({ inbox_dismissed_at: 222 }, { forceKill: true }),
    ).toBe(2);
    expect(await c.commands()).toHaveLength(4);
    expect(await c.child(c.sub)).toMatchObject({
      inbox_dismissed_at: 111,
      inbox_killed_at: firstKilledAt,
    });
  });

  test("already-hidden children are skipped — a re-asserted hide never re-kills", async () => {
    const c = await group();
    await c.cascade({ inbox_dismissed_at: 111 });
    expect(await c.cascade({ inbox_dismissed_at: 222 })).toBe(0);
    expect((await c.child(c.sub)).inbox_dismissed_at).toBe(111);
    expect(await c.commands()).toHaveLength(2);
  });

  test("a big group hides one batch inline and schedules the rest", async () => {
    const c = await group(50);
    expect(await c.cascade({ inbox_dismissed_at: 444 })).toBe(52);
    const hidden = (
      await c.t.run(({ db }) => db.query("conversations").collect())
    ).filter((row) => row.inbox_dismissed_at === 444);
    expect(hidden).toHaveLength(20);
    const jobs = await scheduledJobs(c.t, internal.cleanup.continueCascadeHide);
    expect(jobs).toHaveLength(1);
    const args = jobs[0].args[0];
    expect(args.child_ids).toHaveLength(32);
    expect(args).toMatchObject({
      lead_id: c.conversation,
      field: "inbox_dismissed_at",
      stamp: 444,
    });
    expect(
      args.child_ids.some((id: string) => hidden.some((row) => row._id === id)),
    ).toBe(false);
  });

  test("stash cascade stamps teammates only — Task subagents stay unstamped, agents stay alive", async () => {
    const c = await group();
    const before = await c.child(c.sub);
    expect(await c.cascade({ inbox_stashed_at: 333 })).toBe(1);
    expect(await c.child(c.mate)).toMatchObject({ inbox_stashed_at: 333 });
    expect((await c.child(c.mate)).inbox_killed_at).toBeUndefined();
    expect(await c.child(c.sub)).toEqual(before);
    expect(await c.commands()).toHaveLength(0);
  });

  test("applyHideTransition cascades to the nested group by default", async () => {
    const c = await group();
    expect((await c.hide({ inbox_dismissed_at: 444 })).cascaded).toBe(2);
    expect((await c.child(c.sub)).inbox_dismissed_at).toBe(444);
    expect((await c.child(c.mate)).inbox_dismissed_at).toBe(444);
  });

  test("a stash through applyHideTransition also takes the group (action is 'none')", async () => {
    const c = await group();
    expect(await c.hide({ inbox_stashed_at: 555 })).toMatchObject({
      action: "none",
      cascaded: 1,
    });
    expect((await c.child(c.mate)).inbox_stashed_at).toBe(555);
    expect((await c.child(c.sub)).inbox_stashed_at).toBeUndefined();
  });

  test("cascade: false keeps the per-child transition single-level", async () => {
    const c = await group();
    expect(
      (await c.hide({ inbox_dismissed_at: 666 }, { cascade: false })).cascaded,
    ).toBe(0);
    expect((await c.child(c.sub)).inbox_dismissed_at).toBeUndefined();
  });
});

describe("applyHideTransition — explicit kill forces teardown", () => {
  const dismissed = { inbox_dismissed_at: 222 };
  const forced = { forceKill: true };
  const killed = (fields: Partial<NewRow<"conversations">> = {}) =>
    setup({
      message_count: 12,
      inbox_dismissed_at: 111,
      inbox_killed_at: 111,
      status: "completed",
      ...fields,
    });

  test("a cutoff continuation cancels old generations and preserves later queued intent", async () => {
    const c = await killed({
      pending_kill_generation: 2,
      has_pending_messages: true,
    });
    const foreign = await c.t.run(({ db }) =>
      fixtureRows(db, "unrelated queued session").conversation(c.user),
    );
    const later = await c.message({ kill_generation: 2 });
    const legacy = await c.message();
    const zero = await c.message({ kill_generation: 0 });
    const one = await c.message({ kill_generation: 1 });
    const other = await c.message({
      conversation_id: foreign,
      kill_generation: 0,
    });
    expect(
      await c.t.mutation(internal.pendingMessages.continueKillCancellation, {
        conversation_id: c.conversation,
        cutoff_generation: 1,
      }),
    ).toEqual({ cancelled: 3 });
    await c.t.run(async ({ db }) => {
      for (const id of [legacy, zero, one])
        expect((await db.get(id))?.status).toBe("cancelled");
      for (const id of [later, other])
        expect((await db.get(id))?.status).toBe("pending");
    });
    expect(await c.read()).toMatchObject({
      pending_kill_generation: 2,
      has_pending_messages: true,
      inbox_killed_at: 111,
    });
  });

  test("the kill command carries the cause its caller named", async () => {
    const c = await killed();
    await c.hide(dismissed, { ...forced, cause: "web:killSession" });
    const [command] = await c.commands();
    expect(JSON.parse(command.args!)).toMatchObject({
      conversation_id: c.conversation,
      cause: "web:killSession",
    });
  });

  test("a re-asserted EXPLICIT kill enqueues teardown again", async () => {
    const c = await killed();
    expect(await c.hide(dismissed, forced)).toMatchObject({
      action: "kill",
      teardownEnqueued: true,
    });
    const commands = await c.commands();
    expect(commands).toHaveLength(1);
    expect(commands[0].command).toBe("kill_session");
    expect(JSON.parse(commands[0].args!)).toMatchObject({
      conversation_id: c.conversation,
      session_id: "s-1",
    });
    expect((await c.read())?.inbox_killed_at).toBe(111);
  });

  test("a re-asserted quiet DISMISS still does not re-kill", async () => {
    const c = await killed();
    expect(await c.hide(dismissed)).toMatchObject({
      action: "none",
      teardownEnqueued: false,
    });
    expect(await c.commands()).toHaveLength(0);
  });

  test("forceKill never turns a STASH into a kill", async () => {
    const c = await killed({
      inbox_dismissed_at: undefined,
      inbox_killed_at: undefined,
      status: "active",
    });
    expect((await c.hide({ inbox_stashed_at: 333 }, forced)).action).toBe(
      "none",
    );
    expect(await c.commands()).toHaveLength(0);
    expect((await c.read())?.status).toBe("active");
  });

  test("a kill still queued for the daemon reports no new command, but the state holds", async () => {
    const c = await killed();
    const queued = await c.seedKill();
    expect(await c.hide(dismissed, forced)).toMatchObject({
      action: "kill",
      teardownEnqueued: false,
    });
    expect((await c.commands()).map((command) => command._id)).toEqual([
      queued,
    ]);
    expect((await c.read())?.inbox_killed_at).toBe(111);
  });

  test("a forced kill on a persistent anchor keeps anchor semantics: schedules AND queued messages", async () => {
    const c = await killed({
      persistent: true,
      status: "active",
      has_pending_messages: true,
    });
    const trigger = await c.trigger();
    const queued = await c.message();
    expect(await c.hide(dismissed, forced)).toMatchObject({
      action: "kill",
      teardownEnqueued: true,
      canceledSchedules: 0,
      canceledMessages: 0,
    });
    expect((await c.t.run(({ db }) => db.get(trigger)))?.status).toBe(
      "scheduled",
    );
    expect((await c.t.run(({ db }) => db.get(queued)))?.status).toBe("pending");
    expect(await c.read()).toMatchObject({
      has_pending_messages: true,
      status: "active",
      inbox_killed_at: 111,
    });
  });

  test("a kill cancels the messages already queued and clears has_pending_messages", async () => {
    const c = await killed({
      inbox_dismissed_at: undefined,
      inbox_killed_at: undefined,
      status: "active",
      has_pending_messages: true,
    });
    const pending = await c.message();
    const undeliverable = await c.message({
      status: "undeliverable",
      retry_count: 9,
    });
    const delivered = await c.message({ status: "delivered", retry_count: 1 });
    expect(await c.hide(dismissed)).toMatchObject({
      action: "kill",
      canceledMessages: 2,
    });
    const statuses = await c.t.run(async ({ db }) =>
      Promise.all(
        [pending, undeliverable, delivered].map(
          async (id) => (await db.get(id))?.status,
        ),
      ),
    );
    expect(statuses).toEqual(["cancelled", "cancelled", "delivered"]);
    expect((await c.read())?.has_pending_messages).toBe(false);
  });

  test("a forced re-kill cancels what was queued since the first kill", async () => {
    const c = await killed({ has_pending_messages: true });
    const queued = await c.message();
    expect((await c.hide(dismissed, forced)).canceledMessages).toBe(1);
    expect((await c.t.run(({ db }) => db.get(queued)))?.status).toBe(
      "cancelled",
    );
    expect((await c.read())?.has_pending_messages).toBe(false);
  });

  test("a later send still revives the killed session; the pre-kill queue stays dead", async () => {
    const c = await killed({ has_pending_messages: true });
    const previous = await c.message();
    await c.hide(dismissed, forced);
    expect((await c.t.run(({ db }) => db.get(previous)))?.status).toBe(
      "cancelled",
    );
    const id = await c.t.mutation(async (ctx) =>
      enqueuePendingMessage(ctx, (await ctx.db.get(c.conversation))!, c.user, {
        content: "back to work",
      }),
    );
    expect((await c.t.run(({ db }) => db.get(id)))?.status).toBe("pending");
    const session = await c.read();
    expect(session?.inbox_dismissed_at).toBeUndefined();
    expect(session?.inbox_killed_at).toBeUndefined();
    expect(session).toMatchObject({
      status: "active",
      has_pending_messages: true,
    });
    expect((await c.t.run(({ db }) => db.get(previous)))?.status).toBe(
      "cancelled",
    );
  });

  test("a forced kill re-cancels a schedule re-armed since the first kill", async () => {
    const c = await killed();
    const trigger = await c.trigger();
    expect((await c.hide(dismissed, forced)).canceledSchedules).toBe(1);
    const task = await c.t.run(({ db }) => db.get(trigger));
    expect(task?.status).toBe("completed");
    expect(task?.canceled_on_kill_at).toBeGreaterThan(0);
  });
});

describe("applyHideTransition — hiding an empty pre-warm keeps the row", () => {
  for (const field of ["inbox_dismissed_at", "inbox_stashed_at"] as const) {
    test(`${field}: kill enqueued, conversation not deleted`, async () => {
      const c = await setup();
      expect(await c.hide({ [field]: Date.now() })).toMatchObject({
        action: "reap",
        teardownEnqueued: true,
      });
      expect(await c.read()).not.toBeNull();
      expect(await c.commands()).toHaveLength(1);
    });
  }
});
