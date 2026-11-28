import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import { STEER_BATON_CAPABILITY } from "@codecast/edge-contract";
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
    const rows = fixtureRows(db, "late join prompts");
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
    const privateAnchorMsg = await rows.message(privateConv, {
      role: "user",
      content: "Private start",
      nav_prompt: true,
      timestamp: BASE_TIME,
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
    };
  });

  return {
    t,
    ...ids,
    asTeammate: asUser(t, ids.teammate),
    asOwner: asUser(t, ids.owner),
    asOutsider: asUser(t, ids.outsider),
  };
}

async function setupFencedTurn(
  f: Awaited<ReturnType<typeof setup>>,
  promptDetails: Array<{
    prompt_id: string;
    kind: "question" | "permission";
  }>,
) {
  return f.t.run(async ({ db }) => {
    const conv = await db.insert("conversations", {
      user_id: f.owner,
      team_id: f.team,
      is_private: false,
      team_visibility: "full",
      session_id: `fenced-${Math.random()}`,
      agent_type: "claude_code",
      started_at: BASE_TIME,
      updated_at: BASE_TIME + 20_000,
      message_count: 2,
      status: "active",
      execution_protocol_state: "fenced",
      owner_device_id: "dev-1",
    });
    const anchorMsg = await db.insert("messages", {
      conversation_id: conv,
      message_uuid: "fenced-anchor",
      role: "user",
      nav_prompt: true,
      content: "Start",
      timestamp: BASE_TIME,
    });
    await db.insert("conversation_read_anchors", {
      conversation_id: conv,
      user_id: f.owner,
      anchor: {
        message_id: anchorMsg,
        offset: 0,
        changed_at: BASE_TIME + 100,
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
      created_at: BASE_TIME,
      updated_at: BASE_TIME + 10_000,
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
      created_at: BASE_TIME,
      updated_at: BASE_TIME + 10_000,
    });
    const leaseId = await db.insert("run_leases", {
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
        prompt_ids: promptDetails.map((p) => p.prompt_id),
        prompt_details: promptDetails,
      },
      received_at: BASE_TIME + 15_000,
    });
    return { conv, leaseId, anchorMsg };
  });
}

test("detects an open AskUserQuestion prompt and suppresses answered plain AskUserQuestion", async () => {
  const f = await setup();
  const askMsgId = await f.t.run(({ db }) =>
    db.insert("messages", {
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
    }),
  );

  const openSummary = await f.asTeammate.query(lateJoinSummary.get, {
    conversation_id: f.teamConv,
  });

  expect(openSummary?.open_prompt).toEqual({
    kind: "question",
    source: "message",
    label: "Which target should ship first?",
    created_at: BASE_TIME + 30_000,
    message_id: askMsgId,
    timestamp: BASE_TIME + 30_000,
  });

  const pendingId = await f.t.run(({ db }) =>
    db.insert("pending_messages", {
      conversation_id: f.teamConv,
      from_user_id: f.owner,
      owner_user_id: f.owner,
      content: "Ship web first",
      status: "pending",
      created_at: BASE_TIME + 35_000,
      retry_count: 0,
      client_id: "auq-answer-1",
    }),
  );

  const queuedAnswerSummary = await f.asTeammate.query(lateJoinSummary.get, {
    conversation_id: f.teamConv,
  });
  expect(queuedAnswerSummary?.open_prompt).toBeNull();

  await f.t.run(async ({ db }) => {
    await db.delete(pendingId);
    await db.insert("messages", {
      conversation_id: f.teamConv,
      message_uuid: "ask-1-result",
      role: "user",
      content: "",
      tool_results: [{ tool_use_id: "call-1", content: "Ship web first" }],
      timestamp: BASE_TIME + 36_000,
    });
  });

  const transcriptAnswerSummary = await f.asTeammate.query(
    lateJoinSummary.get,
    { conversation_id: f.teamConv },
  );
  expect(transcriptAnswerSummary?.open_prompt).toBeNull();
});

test("ignores fenced permission answered in edge_prompt_answers while pending_permissions is still pending", async () => {
  const f = await setup();
  const { conv, leaseId } = await setupFencedTurn(f, [
    { prompt_id: "perm-1", kind: "permission" },
  ]);

  await f.t.run(async ({ db }) => {
    await db.insert("pending_permissions", {
      conversation_id: conv,
      session_id: "fenced-sess",
      fenced_prompt_id: "perm-1",
      fenced_prompt_turn_id: "turn-1",
      tool_name: "Bash",
      arguments_preview: "rm -rf build",
      intent: "Clean build output",
      status: "pending",
      created_at: BASE_TIME + 50_000,
      owner_user_id: f.owner,
    });
  });

  const beforeAnswer = await f.asOwner.query(lateJoinSummary.get, {
    conversation_id: conv,
  });
  expect(beforeAnswer?.open_prompt).toMatchObject({
    kind: "permission",
    source: "pending_permission",
    label: "Clean build output",
  });

  await f.t.run(({ db }) =>
    db.insert("edge_prompt_answers", {
      conversation_id: conv,
      owner_user_id: f.owner,
      actor_user_id: f.owner,
      device_id: "dev-1",
      boot: "boot-1",
      run: 1,
      lease_id: leaseId,
      turn_id: "turn-1",
      prompt_id: "perm-1",
      answer: { behavior: "allow" },
    }),
  );

  const afterAnswer = await f.asOwner.query(lateJoinSummary.get, {
    conversation_id: conv,
  });
  expect(afterAnswer?.open_prompt).toBeNull();
});

test("ignores fenced question answered in edge_prompt_answers and does not fall back to message scan", async () => {
  const f = await setup();
  const { conv, leaseId } = await setupFencedTurn(f, [
    { prompt_id: "q-1", kind: "question" },
  ]);

  const askMsgId = await f.t.run(({ db }) =>
    db.insert("messages", {
      conversation_id: conv,
      message_uuid: "ask-json-1",
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "q-1",
          name: "AskUserQuestion",
          input: JSON.stringify({
            questions: [{ question: "Which strategy?" }],
          }),
        },
      ],
      timestamp: BASE_TIME + 16_000,
    }),
  );

  const beforeAnswer = await f.asOwner.query(lateJoinSummary.get, {
    conversation_id: conv,
  });
  expect(beforeAnswer?.open_prompt).toEqual({
    kind: "question",
    source: "fenced_turn",
    label: "Which strategy?",
    created_at: BASE_TIME + 16_000,
    message_id: askMsgId,
    timestamp: BASE_TIME + 16_000,
  });

  await f.t.run(({ db }) =>
    db.insert("edge_prompt_answers", {
      conversation_id: conv,
      owner_user_id: f.owner,
      actor_user_id: f.owner,
      device_id: "dev-1",
      boot: "boot-1",
      run: 1,
      lease_id: leaseId,
      turn_id: "turn-1",
      prompt_id: "q-1",
      answer: { answers: { q: { answers: ["Option A"] } } },
    }),
  );

  const afterAnswer = await f.asOwner.query(lateJoinSummary.get, {
    conversation_id: conv,
  });
  expect(afterAnswer?.open_prompt).toBeNull();
});

test("withholds permission details from share-link viewers and redacts secrets for non-runners", async () => {
  const f = await setup();
  await f.t.run(async ({ db }) => {
    await db.patch(f.privateConv, { share_token: "share-secret-1" });
    await db.insert("share_redemptions", {
      user_id: f.outsider,
      conversation_id: f.privateConv,
      token: "share-secret-1",
      created_at: BASE_TIME,
    });
    await db.insert("pending_permissions", {
      conversation_id: f.privateConv,
      session_id: "priv-sess",
      tool_name: "Bash",
      arguments_preview: "export KEY=sk-ant-api03-secret1234567890",
      intent: "Run curl with sk-ant-api03-secret12345678901234567890",
      status: "pending",
      created_at: BASE_TIME + 50_000,
      owner_user_id: f.owner,
    });
    await db.insert("pending_permissions", {
      conversation_id: f.teamConv,
      session_id: "team-sess",
      tool_name: "Bash",
      arguments_preview: "Use token sk-ant-api03-abcdefghijklmnopqrstuvwx",
      intent: "Owner private intent text",
      status: "pending",
      created_at: BASE_TIME + 50_000,
      owner_user_id: f.owner,
    });
  });

  const sharedSummary = await f.asOutsider.query(lateJoinSummary.get, {
    conversation_id: f.privateConv,
  });
  expect(sharedSummary?.open_prompt).toBeNull();

  const teamSummary = await f.asTeammate.query(lateJoinSummary.get, {
    conversation_id: f.teamConv,
  });
  expect(teamSummary?.open_prompt?.kind).toBe("permission");
  expect(teamSummary?.open_prompt?.tool_name).toBe("Bash");
  expect(teamSummary?.open_prompt?.label).not.toContain(
    "sk-ant-api03-abcdefghijklmnopqrstuvwx",
  );
  expect(teamSummary?.open_prompt?.label).not.toContain(
    "Owner private intent text",
  );
  expect(teamSummary?.open_prompt?.label).toContain("[REDACTED_API_KEY]");

  const ownerSummary = await f.asOwner.query(lateJoinSummary.get, {
    conversation_id: f.privateConv,
  });
  expect(ownerSummary).toBeNull();
});

test("does not return a generic fenced_turn Question prompt to a share-link viewer", async () => {
  const f = await setup();
  const { conv } = await setupFencedTurn(f, [
    { prompt_id: "q-shared-1", kind: "question" },
  ]);
  await f.t.run(async ({ db }) => {
    await db.patch(conv, { is_private: true, share_token: "share-fenced-q" });
    await db.insert("share_redemptions", {
      user_id: f.outsider,
      conversation_id: conv,
      token: "share-fenced-q",
      created_at: BASE_TIME,
    });
    const anchorMsg = await db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q) =>
        q.eq("conversation_id", conv),
      )
      .first();
    await db.insert("conversation_read_anchors", {
      conversation_id: conv,
      user_id: f.outsider,
      anchor: {
        message_id: anchorMsg!._id,
        offset: 0,
        changed_at: BASE_TIME + 100,
      },
    });
  });

  const shared = await f.asOutsider.query(lateJoinSummary.get, {
    conversation_id: conv,
  });
  expect(shared?.open_prompt).toBeNull();
});

test("skips non-permission tools in pending_permissions and suppresses expired or owned-closed questions", async () => {
  const f = await setup();
  await f.t.run(async ({ db }) => {
    for (const toolName of [
      "AskUserQuestion",
      "EnterPlanMode",
      "ExitPlanMode",
      "TaskCreate",
      "TaskUpdate",
      "TaskList",
      "TaskGet",
    ]) {
      await db.insert("pending_permissions", {
        conversation_id: f.teamConv,
        session_id: "team-sess",
        tool_name: toolName,
        arguments_preview: "{}",
        intent: `Skip ${toolName}`,
        status: "pending",
        created_at: BASE_TIME + 95_000,
        owner_user_id: f.owner,
      });
    }
    await db.insert("messages", {
      conversation_id: f.teamConv,
      message_uuid: "expired-ask",
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call-expired",
          name: "AskUserQuestion",
          input: JSON.stringify({
            deniesAt: BASE_TIME + 90_000,
            questions: [{ question: "Too late?" }],
          }),
        },
      ],
      timestamp: BASE_TIME + 80_000,
    });
  });

  const expiredSummary = await f.asTeammate.query(lateJoinSummary.get, {
    conversation_id: f.teamConv,
  });
  expect(expiredSummary?.open_prompt).toBeNull();

  await f.t.run(async ({ db }) => {
    await db.insert("messages", {
      conversation_id: f.teamConv,
      message_uuid: "owned-prompt:p-closed",
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call-closed",
          name: "AskUserQuestion",
          input: JSON.stringify({
            questions: [{ question: "Already closed?" }],
          }),
        },
      ],
      timestamp: BASE_TIME + 85_000,
    });
    await db.insert("messages", {
      conversation_id: f.teamConv,
      message_uuid: "owned-prompt:p-closed-closed",
      role: "assistant",
      content: "",
      timestamp: BASE_TIME + 86_000,
    });
  });

  const closedSummary = await f.asTeammate.query(lateJoinSummary.get, {
    conversation_id: f.teamConv,
  });
  expect(closedSummary?.open_prompt).toBeNull();

  const { conv, leaseId } = await setupFencedTurn(f, []);
  await f.t.run(async ({ db }) => {
    await db.insert("messages", {
      conversation_id: conv,
      message_uuid: "owned-prompt:p-answered",
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call-owned-ans",
          name: "AskUserQuestion",
          input: JSON.stringify({
            fencedTurnId: "turn-owned",
            questions: [{ question: "Answered via edge?" }],
          }),
        },
      ],
      timestamp: BASE_TIME + 87_000,
    });
    await db.insert("edge_prompt_answers", {
      conversation_id: conv,
      owner_user_id: f.owner,
      actor_user_id: f.owner,
      device_id: "dev-1",
      boot: "boot-1",
      run: 1,
      lease_id: leaseId,
      turn_id: "turn-owned",
      prompt_id: "call-owned-ans",
      answer: { answers: {} },
    });
  });

  const answeredOwnedSummary = await f.asOwner.query(lateJoinSummary.get, {
    conversation_id: conv,
  });
  expect(answeredOwnedSummary?.open_prompt).toBeNull();
});

test("excludes bot-owned conversations from proposer view and honors sharedFenced gate", async () => {
  const f = await setup();
  const prevBaton = process.env.SWARM_TURN_BATON;
  try {
    process.env.SWARM_TURN_BATON = "1";
    const { conv, bindingId } = await f.t.run(async ({ db }) => {
      await db.patch(f.owner, { is_bot: true });
      const fenced = await db.insert("conversations", {
        user_id: f.owner,
        team_id: f.team,
        is_private: false,
        team_visibility: "full",
        session_id: "bot-fenced-sess",
        agent_type: "codex",
        started_at: BASE_TIME,
        updated_at: BASE_TIME + 30_000,
        message_count: 2,
        status: "active",
        execution_protocol_state: "fenced",
        owner_device_id: "dev-1",
      });
      const anchor = await db.insert("messages", {
        conversation_id: fenced,
        message_uuid: "bot-anchor",
        role: "user",
        nav_prompt: true,
        content: "Start",
        timestamp: BASE_TIME,
      });
      await db.insert("conversation_read_anchors", {
        conversation_id: fenced,
        user_id: f.teammate,
        anchor: {
          message_id: anchor,
          offset: 0,
          changed_at: BASE_TIME + 100,
        },
      });
      await db.insert("conversation_execution_heads", {
        conversation_id: fenced,
        owner_user_id: f.owner,
        protocol_state: "fenced",
        protocol_version: 1,
        current_epoch: 1,
        admission_epoch: 1,
        next_conversation_sequence: 2,
        next_nonterminal_sequence: 1,
        created_at: BASE_TIME,
        updated_at: BASE_TIME + 10_000,
      });
      const bindingId = await db.insert("execution_bindings", {
        conversation_id: fenced,
        owner_user_id: f.owner,
        owner_device_id: "dev-1",
        daemon_boot_id: "boot-1",
        epoch: 1,
        state: "ready",
        claim_id: "claim-bot",
        requested_agent: "codex",
        transport: "app-server",
        project_path: "/fixture",
        configuration_revision: 1,
        protocol_version: 1,
        required_capabilities: [],
        edge_capabilities: [STEER_BATON_CAPABILITY],
        requires_run_lease: true,
        created_at: BASE_TIME,
        updated_at: BASE_TIME + 10_000,
      });
      await db.insert("pending_permissions", {
        conversation_id: f.teamConv,
        session_id: "bot-non-fenced",
        tool_name: "Bash",
        arguments_preview: "ls",
        intent: "Secret bot command",
        status: "pending",
        created_at: BASE_TIME + 60_000,
        owner_user_id: f.owner,
      });
      await db.insert("pending_permissions", {
        conversation_id: fenced,
        session_id: "bot-fenced-sess",
        fenced_prompt_id: "fp-1",
        fenced_prompt_turn_id: "turn-1",
        tool_name: "Bash",
        arguments_preview: "npm test",
        intent: "Run suite for team",
        status: "pending",
        created_at: BASE_TIME + 60_000,
        owner_user_id: f.owner,
      });
      return { conv: fenced, bindingId };
    });

    const botNonFenced = await f.asTeammate.query(lateJoinSummary.get, {
      conversation_id: f.teamConv,
    });
    expect(botNonFenced?.open_prompt).toBeNull();

    const sharedFencedSummary = await f.asTeammate.query(lateJoinSummary.get, {
      conversation_id: conv,
    });
    expect(sharedFencedSummary?.open_prompt).toEqual({
      kind: "permission",
      source: "pending_permission",
      label: "Bash",
      tool_name: "Bash",
      created_at: BASE_TIME + 60_000,
    });

    await f.t.run(async ({ db }) => {
      await db.patch(bindingId, { edge_capabilities: [] });
    });
    const withoutCap = await f.asTeammate.query(lateJoinSummary.get, {
      conversation_id: conv,
    });
    expect(withoutCap?.open_prompt).toBeNull();
  } finally {
    if (prevBaton === undefined) delete process.env.SWARM_TURN_BATON;
    else process.env.SWARM_TURN_BATON = prevBaton;
  }
});
