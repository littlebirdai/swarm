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
    await rows.membership(owner, team);
    await rows.membership(teammate, team);

    const teamConv = await rows.conversation(owner, {
      team_id: team,
      is_private: false,
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
    open_prompt: {
      kind: "permission",
      label: "Run unit tests",
      tool_name: "Bash",
      created_at: BASE_TIME + 90_000,
    },
  });
});

test("detects an open AskUserQuestion prompt on the latest assistant message", async () => {
  const f = await setup();
  await f.t.run(async ({ db }) => {
    await db.insert("messages", {
      conversation_id: f.teamConv,
      message_uuid: "ask-1",
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call-1",
          name: "AskUserQuestion",
          input: JSON.stringify({
            questions: [{ question: "Which target should ship first?" }],
          }),
        },
      ],
      timestamp: BASE_TIME + 30_000,
    });
  });

  const summary = await f.asTeammate.query(lateJoinSummary.get, {
    conversation_id: f.teamConv,
  });

  expect(summary?.open_prompt).toEqual({
    kind: "question",
    label: "Which target should ship first?",
    created_at: BASE_TIME + 30_000,
  });
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
    decisions: [],
    decisions_total: 0,
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

test("counts pre-cutoff turns via role index fallback and detects fenced open-turn prompts", async () => {
  const f = await setup();
  const earlyBase = 10_000;
  const earlyConv = await f.t.run(async ({ db }) => {
    const conv = await db.insert("conversations", {
      user_id: f.owner,
      team_id: f.team,
      is_private: false,
      session_id: "fenced-early-sess",
      agent_type: "claude_code",
      started_at: earlyBase,
      updated_at: earlyBase + 20_000,
      message_count: 3,
      status: "active",
      execution_protocol_state: "fenced",
      owner_device_id: "dev-1",
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
    await db.insert("conversation_execution_heads", {
      conversation_id: conv,
      owner_user_id: f.owner,
      protocol_state: "fenced",
      protocol_version: 1,
      current_epoch: 1,
      admission_epoch: 1,
      next_conversation_sequence: 2,
      next_nonterminal_sequence: 1,
      created_at: earlyBase,
      updated_at: earlyBase + 10_000,
    });
    const bindingId = await db.insert("execution_bindings", {
      conversation_id: conv,
      owner_user_id: f.owner,
      owner_device_id: "dev-1",
      daemon_boot_id: "boot-1",
      epoch: 1,
      state: "ready",
      claim_id: "claim-1",
      requested_agent: "codex",
      transport: "app-server",
      project_path: "/fixture",
      configuration_revision: 1,
      protocol_version: 1,
      required_capabilities: [],
      requires_run_lease: true,
      created_at: earlyBase,
      updated_at: earlyBase + 10_000,
    });
    await db.insert("run_leases", {
      conversation_id: conv,
      owner_user_id: f.owner,
      binding_id: bindingId,
      claim_id: "claim-1",
      boot: "boot-1",
      fencing_token: "fence-1",
      expires_at: BASE_TIME + 500_000,
      retain_until: BASE_TIME + 600_000,
    });
    await db.insert("run_turn_projections", {
      conversation_id: conv,
      owner_user_id: f.owner,
      binding_id: bindingId,
      run: 1,
      status: "active",
      projection_version: 2,
      turn_ids: ["turn-1"],
      open_turn: {
        id: "turn-1",
        prompt_ids: ["prompt-1"],
        prompt_details: [{ prompt_id: "prompt-1", kind: "question" }],
      },
      received_at: earlyBase + 15_000,
    });
    return conv;
  });

  const summary = await f.asTeammate.query(lateJoinSummary.get, {
    conversation_id: earlyConv,
  });

  expect(summary?.new_turns).toBe(1);
  expect(summary?.open_prompt).toEqual({
    kind: "question",
    label: "Question",
    created_at: earlyBase + 20_000,
  });
});
