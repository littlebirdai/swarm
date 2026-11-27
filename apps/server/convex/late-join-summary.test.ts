import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { asUser, serverTest } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";
import { api } from "./_generated/api";
import { NAV_PROMPT_LIVE_SINCE } from "./userMessagesFilter";

const lateJoinSummary = api.lateJoinSummary;
const BASE_TIME = NAV_PROMPT_LIVE_SINCE + 10_000;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(BASE_TIME + 100_000);
});

afterEach(() => {
  jest.useRealTimers();
});

async function setup() {
  const t = serverTest();
  const ids = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "late join summary");
    const team = await rows.team();
    const owner = await rows.user({ name: "Ana" });
    const teammate = await rows.user({ name: "Ben" });
    const outsider = await rows.user({ name: "Eve" });
    await rows.membership(owner, team, { visibility: "full" });
    await rows.membership(teammate, team);

    const teamConv = await rows.conversation(owner, {
      team_id: team,
      is_private: false,
      team_visibility: "full",
      updated_at: BASE_TIME + 50_000,
    });
    const privateConv = await rows.conversation(owner, {
      team_id: team,
      is_private: true,
      updated_at: BASE_TIME + 50_000,
    });

    const anchorMsg = await rows.message(teamConv, {
      role: "user",
      content: "Initial prompt",
      nav_prompt: true,
      timestamp: BASE_TIME,
    });
    const secondPrompt = await rows.message(teamConv, {
      role: "user",
      content: "Second turn",
      nav_prompt: true,
      timestamp: BASE_TIME + 10_000,
    });
    const toolResultUserMsg = await rows.message(teamConv, {
      role: "user",
      content: "",
      tool_results: [{ tool_use_id: "t1", content: "ok" }],
      timestamp: BASE_TIME + 15_000,
    });
    const thirdPrompt = await rows.message(teamConv, {
      role: "user",
      content: "Third turn",
      nav_prompt: true,
      timestamp: BASE_TIME + 20_000,
    });

    const privateAnchorMsg = await rows.message(privateConv, {
      role: "user",
      content: "Private start",
      nav_prompt: true,
      timestamp: BASE_TIME,
    });
    await rows.message(privateConv, {
      role: "user",
      content: "Private follow-up",
      nav_prompt: true,
      timestamp: BASE_TIME + 5_000,
    });

    await db.insert("conversation_read_anchors", {
      conversation_id: teamConv,
      user_id: teammate,
      anchor: {
        message_id: anchorMsg,
        offset: 0.25,
        changed_at: BASE_TIME + 1_000,
      },
    });
    await db.insert("conversation_read_anchors", {
      conversation_id: privateConv,
      user_id: outsider,
      anchor: {
        message_id: privateAnchorMsg,
        offset: 0,
        changed_at: BASE_TIME + 1_000,
      },
    });

    return {
      team,
      owner,
      teammate,
      outsider,
      teamConv,
      privateConv,
      anchorMsg,
      privateAnchorMsg,
      secondPrompt,
      toolResultUserMsg,
      thirdPrompt,
    };
  });

  const asTeammate = asUser(t, ids.teammate);
  const asOwner = asUser(t, ids.owner);
  const asOutsider = asUser(t, ids.outsider);
  return { t, ...ids, asTeammate, asOwner, asOutsider };
}

test("returns new turns, changed files, decisions, and open prompt since the viewer's anchor", async () => {
  const f = await setup();
  await f.t.run(async ({ db }) => {
    await db.insert("file_changes", {
      conversation_id: f.teamConv,
      change_key: "old-edit",
      message_id: f.anchorMsg,
      seq: 1,
      file_path: "src/old.ts",
      change_type: "edit",
      timestamp: BASE_TIME - 500,
    });
    await db.insert("file_changes", {
      conversation_id: f.teamConv,
      change_key: "commit-1",
      message_id: f.secondPrompt,
      seq: 2,
      file_path: "src/committed.ts",
      change_type: "commit",
      timestamp: BASE_TIME + 12_000,
    });
    await db.insert("file_changes", {
      conversation_id: f.teamConv,
      change_key: "edit-1",
      message_id: f.secondPrompt,
      seq: 3,
      file_path: "src/app.ts",
      change_type: "edit",
      timestamp: BASE_TIME + 13_000,
    });
    await db.insert("file_changes", {
      conversation_id: f.teamConv,
      change_key: "edit-2",
      message_id: f.thirdPrompt,
      seq: 4,
      file_path: "src/app.ts",
      change_type: "write",
      timestamp: BASE_TIME + 21_000,
    });
    await db.insert("tree_snapshots", {
      conversation_id: f.teamConv,
      sha: "snap-1",
      tree_sha: "tree-1",
      base_sha: "base-1",
      depth: 1,
      changed_paths: ["src/app.ts", "src/schema.ts"],
      changed_count: 2,
      dirty: true,
      checkout_key: "chk-1",
      source: "turn",
      taken_at: BASE_TIME + 22_000,
    });

    await db.insert("session_decisions", {
      conversation_id: f.teamConv,
      session_id: "sess-1",
      user_id: f.owner,
      short_id: "sd-1",
      question: "Old resolved decision",
      options: [{ label: "Yes" }],
      blocking: true,
      status: "answered",
      answer_index: 0,
      created_at: BASE_TIME - 5_000,
      resolved_at: BASE_TIME - 1_000,
    });
    await db.insert("session_decisions", {
      conversation_id: f.teamConv,
      session_id: "sess-1",
      user_id: f.owner,
      short_id: "sd-2",
      question: "Keep public signature?",
      options: [{ label: "Keep it" }, { label: "Split it" }],
      blocking: true,
      status: "answered",
      answer_index: 0,
      created_at: BASE_TIME + 5_000,
      resolved_at: BASE_TIME + 18_000,
    });
    await db.insert("session_decisions", {
      conversation_id: f.teamConv,
      session_id: "sess-1",
      user_id: f.owner,
      short_id: "sd-3",
      question: "Add retry backoff?",
      options: [{ label: "Yes" }, { label: "No" }],
      blocking: false,
      status: "pending",
      created_at: BASE_TIME + 25_000,
    });

    await db.insert("pending_permissions", {
      conversation_id: f.teamConv,
      session_id: "sess-1",
      tool_name: "Bash",
      arguments_preview: "bun test",
      intent: "Run unit tests",
      status: "pending",
      created_at: BASE_TIME + 90_000,
      owner_user_id: f.owner,
    });
  });

  const summary = await f.asTeammate.query(lateJoinSummary.get, {
    conversation_id: f.teamConv,
  });

  expect(summary).toEqual({
    anchor: {
      message_id: f.anchorMsg,
      offset: 0.25,
      timestamp: BASE_TIME,
      changed_at: BASE_TIME + 1_000,
    },
    new_turns: 2,
    turns_truncated: false,
    changed_files: [
      { path: "src/app.ts", count: 2 },
      { path: "src/schema.ts", count: 1 },
    ],
    changed_files_total: 2,
    changed_files_truncated: false,
    decisions: [
      {
        _id: expect.any(String),
        short_id: "sd-3",
        title: "Add retry backoff?",
        state: "pending",
      },
      {
        _id: expect.any(String),
        short_id: "sd-2",
        title: "Keep public signature?",
        state: "answered",
        answer: "Keep it",
      },
    ],
    decisions_total: 2,
    decisions_truncated: false,
    can_open_decisions: true,
    open_prompt: {
      kind: "permission",
      source: "pending_permission",
      label: "Run unit tests",
      tool_name: "Bash",
      created_at: BASE_TIME + 90_000,
    },
  });
});

test("finds older decisions resolved after the anchor and sets truncation flags when caps are hit", async () => {
  const f = await setup();
  await f.t.run(async ({ db }) => {
    const oldResolved = await db.insert("session_decisions", {
      conversation_id: f.teamConv,
      session_id: "sess-1",
      user_id: f.owner,
      short_id: "sd-old",
      question: "Older decision resolved late",
      options: [{ label: "Done" }],
      blocking: true,
      status: "answered",
      answer_index: 0,
      created_at: BASE_TIME - 50_000,
      resolved_at: BASE_TIME + 30_000,
    });
    for (let i = 0; i < 55; i++) {
      await db.insert("session_decisions", {
        conversation_id: f.teamConv,
        session_id: "sess-1",
        user_id: f.owner,
        short_id: `sd-hist-${i}`,
        question: `Historical decision ${i}`,
        options: [{ label: "Ok" }],
        blocking: false,
        status: "answered",
        answer_index: 0,
        created_at: BASE_TIME - 40_000 + i,
        resolved_at: BASE_TIME - 10_000 + i,
      });
    }
    await db.insert("tree_snapshots", {
      conversation_id: f.teamConv,
      sha: "snap-clipped",
      tree_sha: "tree-clipped",
      base_sha: "base-clipped",
      depth: 1,
      changed_paths: ["src/clipped.ts"],
      changed_count: 250,
      dirty: true,
      checkout_key: "chk-clipped",
      source: "turn",
      taken_at: BASE_TIME + 40_000,
    });
    expect(oldResolved).toBeTruthy();
  });

  const summary = await f.asTeammate.query(lateJoinSummary.get, {
    conversation_id: f.teamConv,
  });

  expect(summary?.decisions_total).toBe(1);
  expect(summary?.decisions_truncated).toBe(false);
  expect(summary?.decisions[0]).toMatchObject({
    short_id: "sd-old",
    title: "Older decision resolved late",
    state: "answered",
    answer: "Done",
  });
  expect(summary?.changed_files_truncated).toBe(true);

  await f.t.run(async ({ db }) => {
    for (let i = 0; i < 55; i++) {
      await db.insert("session_decisions", {
        conversation_id: f.teamConv,
        session_id: "sess-1",
        user_id: f.owner,
        short_id: `sd-late-${i}`,
        question: `Post-anchor decision ${i}`,
        options: [{ label: "Ok" }],
        blocking: false,
        status: "answered",
        answer_index: 0,
        created_at: BASE_TIME + 31_000 + i,
        resolved_at: BASE_TIME + 40_000 + i,
      });
    }
  });

  const truncatedLate = await f.asTeammate.query(lateJoinSummary.get, {
    conversation_id: f.teamConv,
  });
  expect(truncatedLate?.decisions_truncated).toBe(true);
});

test("returns zero updates when nothing happened since the viewer's anchor", async () => {
  const f = await setup();
  await f.t.run(async ({ db }) => {
    const anchor = await db
      .query("conversation_read_anchors")
      .withIndex("by_user", (q) =>
        q.eq("user_id", f.teammate).eq("conversation_id", f.teamConv),
      )
      .unique();
    await db.patch(anchor!._id, {
      anchor: {
        message_id: f.thirdPrompt,
        offset: 0.9,
        changed_at: BASE_TIME + 25_000,
      },
    });
  });

  const summary = await f.asTeammate.query(lateJoinSummary.get, {
    conversation_id: f.teamConv,
  });

  expect(summary).toEqual({
    anchor: {
      message_id: f.thirdPrompt,
      offset: 0.9,
      timestamp: BASE_TIME + 20_000,
      changed_at: BASE_TIME + 25_000,
    },
    new_turns: 0,
    turns_truncated: false,
    changed_files: [],
    changed_files_total: 0,
    changed_files_truncated: false,
    decisions: [],
    decisions_total: 0,
    decisions_truncated: false,
    can_open_decisions: true,
    open_prompt: null,
  });
});

test("returns null when unauthenticated, lacking access, or missing an anchor", async () => {
  const f = await setup();

  expect(
    await f.t.query(lateJoinSummary.get, { conversation_id: f.teamConv }),
  ).toBeNull();
  expect(
    await f.asOutsider.query(lateJoinSummary.get, {
      conversation_id: f.teamConv,
    }),
  ).toBeNull();
  expect(
    await f.asOutsider.query(lateJoinSummary.get, {
      conversation_id: f.privateConv,
    }),
  ).toBeNull();
  expect(
    await f.asOwner.query(lateJoinSummary.get, {
      conversation_id: f.teamConv,
    }),
  ).toBeNull();

  await f.t.run(async ({ db }) => {
    await db.patch(f.privateConv, { share_token: "share-1" });
    await db.insert("share_redemptions", {
      user_id: f.outsider,
      conversation_id: f.privateConv,
      token: "share-1",
      created_at: BASE_TIME,
    });
  });

  const sharedSummary = await f.asOutsider.query(lateJoinSummary.get, {
    conversation_id: f.privateConv,
  });
  expect(sharedSummary?.new_turns).toBe(1);
});

test("counts pre-cutoff turns via role index fallback", async () => {
  const f = await setup();
  const earlyBase = 10_000;
  const earlyConv = await f.t.run(async ({ db }) => {
    const conv = await db.insert("conversations", {
      user_id: f.owner,
      team_id: f.team,
      is_private: false,
      team_visibility: "full",
      session_id: "early-sess",
      agent_type: "claude_code",
      started_at: earlyBase,
      updated_at: earlyBase + 20_000,
      message_count: 3,
      status: "active",
    });
    const earlyAnchor = await db.insert("messages", {
      conversation_id: conv,
      message_uuid: "early-1",
      role: "user",
      content: "Early prompt",
      timestamp: earlyBase,
    });
    await db.insert("messages", {
      conversation_id: conv,
      message_uuid: "early-2",
      role: "user",
      content: "Early follow-up",
      timestamp: earlyBase + 5_000,
    });
    await db.insert("messages", {
      conversation_id: conv,
      message_uuid: "early-tool",
      role: "user",
      content: "",
      tool_results: [{ tool_use_id: "t-early", content: "done" }],
      timestamp: earlyBase + 6_000,
    });
    await db.insert("conversation_read_anchors", {
      conversation_id: conv,
      user_id: f.teammate,
      anchor: {
        message_id: earlyAnchor,
        offset: 0,
        changed_at: earlyBase + 100,
      },
    });
    return conv;
  });

  const summary = await f.asTeammate.query(lateJoinSummary.get, {
    conversation_id: earlyConv,
  });
  expect(summary?.new_turns).toBe(1);
});

test("withholds decisions and tree_snapshots from share-link viewers", async () => {
  const f = await setup();
  await f.t.run(async ({ db }) => {
    await db.patch(f.privateConv, { share_token: "share-gate-1" });
    await db.insert("share_redemptions", {
      user_id: f.outsider,
      conversation_id: f.privateConv,
      token: "share-gate-1",
      created_at: BASE_TIME,
    });
    await db.insert("session_decisions", {
      conversation_id: f.privateConv,
      session_id: "priv-sess",
      user_id: f.owner,
      short_id: "sd-priv",
      question: "Private team decision?",
      options: [{ label: "Yes" }],
      blocking: true,
      status: "pending",
      created_at: BASE_TIME + 5_000,
    });
    await db.insert("tree_snapshots", {
      conversation_id: f.privateConv,
      sha: "snap-priv",
      tree_sha: "tree-priv",
      base_sha: "base-priv",
      depth: 1,
      changed_paths: ["src/secret-only-in-snapshot.ts"],
      changed_count: 1,
      dirty: true,
      checkout_key: "chk-priv",
      source: "turn",
      taken_at: BASE_TIME + 6_000,
    });
    await db.insert("file_changes", {
      conversation_id: f.privateConv,
      change_key: "fc-priv-1",
      message_id: f.privateAnchorMsg,
      seq: 1,
      file_path: "src/public-file.ts",
      change_type: "edit",
      timestamp: BASE_TIME + 7_000,
    });
  });

  const shared = await f.asOutsider.query(lateJoinSummary.get, {
    conversation_id: f.privateConv,
  });
  expect(shared?.can_open_decisions).toBe(false);
  expect(shared?.decisions).toEqual([]);
  expect(shared?.decisions_total).toBe(0);
  expect(shared?.decisions_truncated).toBe(false);
  expect(shared?.changed_files).toEqual([
    { path: "src/public-file.ts", count: 1 },
  ]);
  expect(shared?.new_turns).toBe(1);
});
