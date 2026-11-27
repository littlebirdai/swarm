import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { asUser, serverTest } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { api } from "./_generated/api";
import {
  _resetChildAuqProbeCacheForTests,
  buildAskingParents,
} from "./conversations";
import { readCliWatchLiveness } from "./lib/sessionHeartbeat";

const now = 1_750_000_020_000;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(now);
  _resetChildAuqProbeCacheForTests();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  _resetChildAuqProbeCacheForTests();
});

test("the child question probe cap returns the same result on a cold and warm isolate", async () => {
  const t = serverTest({});
  const { childrenByParent, children, questionParent } = await t.run(
    async ({ db }) => {
      const rows = fixtureRows(db, "watch-auq-cache");
      const user = await rows.user();
      const childrenByParent = [];
      const children = [];
      let questionParent = "";
      for (const open of [false, true]) {
        const parent = await rows.conversation(user, { updated_at: now });
        const child = await rows.conversation(user, {
          parent_conversation_id: parent,
          is_subagent: true,
          message_count: 1,
          updated_at: now,
        });
        await rows.message(child, {
          role: "assistant",
          ...(open
            ? {
                tool_calls: [
                  { id: "ask", name: "AskUserQuestion", input: "{}" },
                ],
              }
            : {}),
        });
        if (open) questionParent = parent;
        children.push(child);
        childrenByParent.push([parent, [await db.get(child)]] as const);
      }
      return { childrenByParent, children, questionParent };
    },
  );
  const maps = {
    liveConvIds: new Set<string>(children),
    agentStatusMap: new Map(
      children.map((child) => [child, "working"] as const),
    ),
    openTasksMap: new Map(),
  };
  const run = (cap?: number) =>
    t.run(async (ctx) => [
      ...(
        await buildAskingParents(
          ctx,
          new Map(childrenByParent.map(([id, rows]) => [id, [...rows]])),
          maps,
          now,
          undefined,
          undefined,
          cap,
        )
      ).asking,
    ]);
  expect(await run(1)).toEqual([]);
  expect(await run()).toEqual([questionParent]);
  expect(await run(1)).toEqual([]);
});

test("a pinned parent's question is found ahead of the cold transcript budget", async () => {
  const t = serverTest({});
  const { user, pinned } = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "watch-prioritizes-child-question");
    const user = await rows.user();
    const pinned = await rows.conversation(user, {
      message_count: 1,
      last_message_role: "assistant",
      updated_at: now - 60_000,
      inbox_pinned_at: now - 60_000,
    });
    for (let i = 0; i <= 129; i++) {
      const parent =
        i < 129
          ? await rows.conversation(user, {
              updated_at: now - i,
              message_count: 1,
              last_message_role: "assistant",
            })
          : pinned;
      const child = await rows.conversation(user, {
        updated_at: now - i,
        message_count: 1,
        is_subagent: true,
        parent_conversation_id: parent,
      });
      await rows.session(user, {
        conversation_id: child,
        agent_status: "working",
        last_heartbeat: now,
      });
      await rows.message(child, {
        role: "assistant",
        ...(parent === pinned
          ? {
              tool_calls: [{ id: "ask", name: "AskUserQuestion", input: "{}" }],
            }
          : {}),
      });
    }
    return { user, pinned };
  });
  const result = await asUser(t, user).query(api.conversations.inboxForCLI, {
    api_token: "fixture",
    watch: true,
  });
  expect(result.sessions?.find(({ id }) => id === pinned)).toMatchObject({
    bucket: "questions",
  });
});

test("unmanaged children cannot displace a cold top-level session", async () => {
  const t = serverTest({});
  const { user, target } = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "watch-cold-top-level");
    const user = await rows.user();
    const target = await rows.conversation(user, {
      updated_at: now - 100_000,
      message_count: 1,
      last_message_role: "assistant",
    });
    await rows.session(user, {
      conversation_id: target,
      last_heartbeat: now - 24 * 60 * 60_000,
      hibernated_at: now - 5000,
      agent_status: "hibernated",
    });
    for (let i = 0; i < 18; i++) {
      const parent = await rows.conversation(user, {
        updated_at: now - 1000,
        message_count: 1,
        last_message_role: "assistant",
      });
      for (let c = 0; c < 16; c++)
        await rows.conversation(user, {
          parent_conversation_id: parent,
          is_subagent: true,
          updated_at: now - 1000,
        });
    }
    return { user, target };
  });
  const result = await asUser(t, user).query(api.conversations.inboxForCLI, {
    api_token: "fixture",
    watch: true,
  });
  expect(result.sessions?.find(({ id }) => id === target)).toMatchObject({
    agent_status: "hibernated",
  });
});

test("a partial watch page prefers waiting and working to idle pins and excludes killed pins", async () => {
  const t = serverTest({});
  const { user, working, waiting, idle } = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "watch-page-priority");
    const user = await rows.user();
    const conversation = () =>
      rows.conversation(user, {
        updated_at: now - 1000,
        message_count: 1,
        last_message_role: "assistant",
      });
    const idle = await rows.conversation(user, {
      updated_at: now,
      inbox_pinned_at: now,
    });
    await rows.conversation(user, {
      updated_at: now,
      inbox_pinned_at: now,
      inbox_killed_at: now,
      inbox_dismissed_at: now,
    });
    const working = await conversation();
    const waiting = await conversation();
    await rows.session(user, {
      conversation_id: working,
      agent_status: "working",
      last_heartbeat: now,
    });
    await rows.session(user, {
      conversation_id: waiting,
      agent_status: "permission_blocked",
      last_heartbeat: now,
    });
    return { user, working, waiting, idle };
  });
  const read = (limit: number) =>
    asUser(t, user).query(api.conversations.inboxForCLI, {
      api_token: "fixture",
      watch: true,
      limit,
    });
  const partial = await read(2);
  expect(partial.sessions?.map(({ id }) => id)).toEqual([waiting, working]);
  expect(partial.watch_truncation).toEqual({
    shown: 2,
    matching: 3,
    windows: [],
  });
  const complete = await read(10);
  expect(complete.sessions?.map(({ id }) => id)).toEqual([
    waiting,
    working,
    idle,
  ]);
  expect(complete.watch_truncation).toBeUndefined();
});

test("the displayed watch page breaks equal times by id", async () => {
  const t = serverTest({});
  const { user, ids } = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "watch-equal-times");
    const user = await rows.user();
    return {
      user,
      ids: [
        await rows.conversation(user, { updated_at: now }),
        await rows.conversation(user, { updated_at: now }),
      ],
    };
  });
  const result = await asUser(t, user).query(api.conversations.inboxForCLI, {
    api_token: "fixture",
    watch: true,
    limit: 1,
  });
  expect(result.sessions?.map(({ id }) => id)).toEqual([ids.sort()[0]]);
});

test("cold watch lookups break equal times by id at the cap", async () => {
  const t = serverTest({});
  const { user, ids } = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "watch-equal-cold-times");
    const user = await rows.user();
    const ids = [];
    for (let i = 0; i < 257; i++) {
      const id = await rows.conversation(user, { updated_at: now - 1000 });
      ids.push(id);
      if (i === 0 || i === 256)
        await rows.session(user, {
          conversation_id: id,
          last_heartbeat: now - 24 * 60 * 60_000,
        });
    }
    return { user, ids };
  });
  ids.sort();
  const included = await t.run(async ({ db }) => {
    const rows = await Promise.all([...ids].reverse().map((id) => db.get(id)));
    const liveness = await readCliWatchLiveness(
      db,
      user,
      rows.filter((row) => row !== null),
      [],
      now,
    );
    return liveness.sessions.map(({ conversation_id }) => conversation_id);
  });
  expect(included).toEqual([ids[0]]);
});
