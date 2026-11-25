import { expect, test } from "bun:test";
import { HEARTBEAT_ALIVE_MS } from "@codecast/sessions/agentStatus";
import { api } from "./_generated/api";
import { asUser, serverTest } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";

test("CLI watch rank can depend on a message outside the raw page", async () => {
  const t = serverTest();
  const now = Math.floor(Date.now() / 60_000) * 60_000;
  const { owner, newer, older, olderMessage } = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "watch-rank");
    const owner = await rows.user();
    const newer = await rows.conversation(owner, {
      session_id: "newer",
      title: "Newer",
      updated_at: now - 1000,
      message_count: 1,
      last_message_role: "assistant",
    });
    const older = await rows.conversation(owner, {
      session_id: "older",
      title: "Older",
      updated_at: now - 2000,
      message_count: 1,
      last_message_role: "assistant",
    });
    await rows.session(owner, {
      conversation_id: newer,
      last_heartbeat: now,
      agent_status: "working",
    });
    await rows.session(owner, {
      conversation_id: older,
      last_heartbeat: now,
      agent_status: "working",
    });
    const olderMessage = await rows.message(older, {
      role: "assistant",
      timestamp: now - 2000,
      tool_calls: [{ id: "question", name: "AskUserQuestion", input: "{}" }],
    });
    return { owner, newer, older, olderMessage };
  });
  const read = () =>
    asUser(t, owner).query(api.conversations.inboxForCLI, {
      api_token: "unused",
      limit: 1,
    });
  const [first] = (await read()).sessions!;
  expect({
    id: first.id,
    session_id: first.session_id,
    title: first.title,
    work_state: first.work_state,
    is_killed: first.is_killed,
    is_pinned: first.is_pinned,
    is_live: first.is_live,
    label: first.label,
  }).toEqual({
    id: older,
    session_id: "older",
    title: "Older",
    work_state: "needs_input",
    is_killed: false,
    is_pinned: false,
    is_live: true,
    label: null,
  });
  await t.run(({ db }) => db.patch(olderMessage, { tool_calls: undefined }));
  expect((await read()).sessions).toEqual([
    expect.objectContaining({ id: newer, work_state: "working" }),
  ]);
});

test("CLI label watch includes recent sessions beyond the named hydration cap", async () => {
  const t = serverTest();
  const now = Date.now();
  const { owner, recent } = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "watch-label");
    const owner = await rows.user();
    const bucket = await db.insert("inbox_buckets", {
      user_id: owner,
      name: "Filed",
      created_at: now,
      updated_at: now,
    });
    const archivedAt = now - 60 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < 200; i++) {
      const archived = await rows.conversation(owner, {
        title: `Archive ${i}`,
        status: "completed",
        started_at: archivedAt,
        updated_at: archivedAt,
        message_count: 0,
      });
      await db.insert("bucket_assignments", {
        user_id: owner,
        bucket_id: bucket,
        conversation_id: archived,
        updated_at: now,
      });
    }
    const recent = await rows.conversation(owner, {
      title: "Recent",
      updated_at: now,
    });
    await db.insert("bucket_assignments", {
      user_id: owner,
      bucket_id: bucket,
      conversation_id: recent,
      updated_at: now,
    });
    return { owner, recent };
  });
  const result = await asUser(t, owner).query(api.conversations.inboxForCLI, {
    api_token: "unused",
    limit: 200,
    label: "Filed",
  });
  expect(result.sessions).toEqual([
    expect.objectContaining({ id: recent, title: "Recent", label: "Filed" }),
  ]);
});

test("CLI liveness includes a legacy daemon beat outside the session heartbeat range", async () => {
  const t = serverTest();
  const now = Math.floor(Date.now() / 60_000) * 60_000;
  const { owner, watched, daemonSession } = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "watch-liveness");
    const owner = await rows.user();
    const watched = await rows.conversation(owner, {
      title: "Watched",
      updated_at: now - 1000,
    });
    const daemonSession = await rows.session(owner, {
      last_heartbeat: now - HEARTBEAT_ALIVE_MS - 1,
    });
    return { owner, watched, daemonSession };
  });
  const read = () =>
    asUser(t, owner).query(api.conversations.inboxForCLI, {
      api_token: "unused",
      limit: 1,
    });
  expect((await read()).sessions).toEqual([
    expect.objectContaining({ id: watched, is_live: true }),
  ]);
  await t.run(({ db }) =>
    db.patch(daemonSession, { last_heartbeat: now - 10 * 60_000 }),
  );
  expect((await read()).sessions).toEqual([
    expect.objectContaining({ id: watched, is_live: false }),
  ]);
});
