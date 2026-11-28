import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import { sessionMachine } from "@codecast/session-contract";
import { api, internal } from "./_generated/api";
import {
  asUser,
  scheduledJobs,
  serverTest,
} from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";

const now = 1_750_000_000_000;
const before = now - 1000;
const sessionKey = "inference-trace";
let rateShard: ReturnType<typeof spyOn>;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(now);
  rateShard = spyOn(Math, "random").mockReturnValue(0.5);
});
afterEach(() => {
  rateShard.mockRestore();
  jest.clearAllTimers();
  jest.useRealTimers();
});

type AsyncSyscall = (op: string, args: string) => Promise<string>;
type Write = {
  table: string;
  id: string;
  fields: Record<string, unknown>;
  inserted?: true;
};

async function recordWrites<T>(run: () => Promise<T>) {
  const runtime = (globalThis as unknown as { Convex: object }).Convex;
  const original = Object.getOwnPropertyDescriptor(runtime, "asyncSyscall")!;
  const writes: Write[] = [];
  const tables = [
    "managed_sessions",
    "conversations",
    "pending_messages",
    "messages",
    "users",
  ];
  Object.defineProperty(runtime, "asyncSyscall", {
    ...original,
    get() {
      const call: AsyncSyscall = original.get!.call(runtime);
      return async (op: string, args: string) => {
        const result = await call(op, args);
        if (op === "1.0/shallowMerge" || op === "1.0/insert") {
          const { table, id, value } = JSON.parse(args);
          const target = table ?? tables.find((name) => id?.endsWith(name));
          if (tables.includes(target)) {
            writes.push({
              table: target,
              id: id ?? JSON.parse(result)._id,
              fields: value,
              ...(op === "1.0/insert" ? { inserted: true } : {}),
            });
          }
        }
        return result;
      };
    },
  });
  try {
    return { result: await run(), writes };
  } finally {
    Object.defineProperty(runtime, "asyncSyscall", original);
  }
}

async function seed(
  agent_status: "idle" | "permission_blocked" | "working",
  hosted = false,
) {
  const t = serverTest();
  const { user, conversation, session } = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "transcript status replay");
    const user = await rows.user();
    const conversation = await rows.conversation(user, {
      session_id: sessionKey,
      skip_title_generation: true,
    });
    const session = await rows.session(user, {
      conversation_id: conversation,
      session_id: sessionKey,
      agent_status,
      agent_status_updated_at: before,
      agent_status_write_at: before,
      last_heartbeat: before,
      ...(hosted ? { hosted: true } : {}),
    });
    return { user, conversation, session };
  });
  return { t, viewer: asUser(t, user), conversation, session };
}

function inference(id: string, at = now): Write {
  return {
    table: "managed_sessions",
    id,
    fields: { agent_status: "working", agent_status_updated_at: at },
  };
}

const assistant = {
  role: "assistant",
  message_uuid: "assistant-trace",
  content: "Checking",
  timestamp: before,
} as const;
const toolReply = {
  role: "user",
  message_uuid: "tool-trace",
  content: "",
  timestamp: before + 1,
  tool_results: [{ tool_use_id: "read-trace", content: "Tool output" }],
} as const;

function tallies(id: string): Write {
  return {
    table: "conversations",
    id,
    fields: { session_tallies: { commits: 0, failed_tools: 0 } },
  };
}

for (const kind of ["assistant", "tool result"] as const) {
  test(`single ${kind} writes the transcript before inferred status`, async () => {
    const { t, viewer, conversation, session } = await seed(
      kind === "assistant" ? "idle" : "permission_blocked",
    );
    const message =
      kind === "assistant"
        ? assistant
        : { ...toolReply, tool_results: [...toolReply.tool_results] };
    const { writes } = await recordWrites(() =>
      viewer.mutation(api.messages.addMessage, {
        conversation_id: conversation,
        ...message,
      }),
    );
    expect(writes).toEqual([
      expect.objectContaining({
        table: "messages",
        inserted: true,
        fields: expect.objectContaining({
          role: message.role,
          conversation_id: conversation,
        }),
      }),
      tallies(conversation),
      expect.objectContaining({
        table: "conversations",
        id: conversation,
        fields: expect.objectContaining({ message_count: 1 }),
      }),
      inference(session),
    ]);
    const row = await t.run(({ db }) => db.get(session));
    expect(row).toMatchObject({
      agent_status: "working",
      agent_status_write_at: before,
      last_heartbeat: before,
    });
    const scope = { session: sessionKey, run: 1 };
    const initial = sessionMachine.initial(scope);
    const event = {
      ...scope,
      v: 1,
      at: before,
      source: "provider",
      turn: "turn-trace",
    } as const;
    const fence = { ...scope, fencing_token: "inference-fence" };
    const claimed = sessionMachine.apply(initial, {
      ...fence,
      kind: "run.claimed",
      claimNumber: 1,
      expires_at: now + 1000,
    }).state;
    const ready = sessionMachine.apply(claimed, {
      ...fence,
      kind: "run.runtimeReady",
    }).state;
    const started = sessionMachine.apply(ready, {
      kind: "provider.event",
      event: { ...event, seq: 1, kind: "turn.started", body: {} },
    }).state;
    const blocked = sessionMachine.apply(started, {
      kind: "provider.event",
      event: {
        ...event,
        seq: 2,
        kind: "prompt.opened",
        body: { prompt_id: "permission-trace", kind: "permission" },
      },
    }).state;
    const contract = kind === "assistant" ? initial : blocked;
    expect([row?.agent_status, contract.turn.status]).toEqual(
      kind === "assistant" ? ["working", "none"] : ["working", "blocked"],
    );
  });
}

test("batches fold both kinds of evidence into one probe and schedule one check", async () => {
  const { t, viewer, conversation, session } = await seed("idle");
  const append = (message: typeof assistant | typeof toolReply) =>
    viewer.mutation(api.messages.addMessages, {
      conversation_id: conversation,
      messages: [
        message.role === "assistant"
          ? message
          : { ...message, tool_results: [...message.tool_results] },
      ],
    });
  for (const [index, message] of [assistant, toolReply].entries()) {
    jest.setSystemTime(now + index);
    const { writes } = await recordWrites(() => append(message));
    expect(writes).toEqual([
      expect.objectContaining({
        table: "messages",
        inserted: true,
        fields: expect.objectContaining({
          role: message.role,
          conversation_id: conversation,
        }),
      }),
      ...(index === 0 ? [tallies(conversation)] : []),
      {
        table: "conversations",
        id: conversation,
        fields: expect.objectContaining({
          message_count: index + 1,
          agent_status_probe: {
            at: now + index,
            due_at: now + 10_000,
            has_assistant_message: true,
            has_tool_result_reply: index === 1,
          },
        }),
      },
    ]);
  }
  const jobs = await scheduledJobs(
    t,
    internal.messages.projectAgentStatusOnAddMessages,
  );
  expect(
    jobs.map(({ args, scheduledTime }) => ({ args, scheduledTime })),
  ).toEqual([
    { args: [{ conversation_id: conversation }], scheduledTime: now + 10_000 },
  ]);
  expect((await t.run(({ db }) => db.get(session)))?.agent_status).toBe("idle");
  jest.setSystemTime(now + 10_000);
  const { writes } = await recordWrites(() =>
    t.mutation(internal.messages.projectAgentStatusOnAddMessages, {
      conversation_id: conversation,
    }),
  );
  expect(writes).toEqual([inference(session, now + 10_000)]);
});

test("a batch on a working session writes no probe or deferred check", async () => {
  const { t, viewer, conversation } = await seed("working");
  const { writes } = await recordWrites(() =>
    viewer.mutation(api.messages.addMessages, {
      conversation_id: conversation,
      messages: [assistant],
    }),
  );
  expect(writes.map((write) => write.table)).toEqual([
    "messages",
    "conversations",
    "conversations",
  ]);
  expect(writes[2].fields.agent_status_probe).toBeUndefined();
  expect(
    await scheduledJobs(t, internal.messages.projectAgentStatusOnAddMessages),
  ).toEqual([]);
});

for (const path of [
  "legacy arguments",
  "stale evidence",
  "hosted registry",
] as const) {
  test(`${path} preserves the deferred inference write trace`, async () => {
    const { t, conversation, session } = await seed(
      "idle",
      path === "hosted registry",
    );
    const { writes } = await recordWrites(() =>
      t.mutation(internal.messages.projectAgentStatusOnAddMessages, {
        conversation_id: conversation,
        scheduled_at: path === "stale evidence" ? before - 1 : before,
        has_assistant_message: true,
      }),
    );
    expect(writes).toEqual(
      path === "legacy arguments" ? [inference(session)] : [],
    );
    expect((await t.run(({ db }) => db.get(session)))?.agent_status).toBe(
      path === "legacy arguments" ? "working" : "idle",
    );
  });
}

for (const path of ["plain", "handoff", "fork"] as const) {
  test(`${path} transcript ingest preserves creation and parent writes`, async () => {
    const handoff = path === "handoff";
    const fork = path === "fork";
    const t = serverTest();
    const { user, parent } = await t.run(async ({ db }) => {
      const user = await db.insert("users", {});
      const parent = await db.insert("conversations", {
        user_id: user,
        agent_type: "claude_code",
        session_id: "parent-trace",
        status: "active",
        started_at: before,
        updated_at: before,
        message_count: 0,
        is_private: true,
      });
      return { user, parent };
    });
    const { result: id, writes } = await recordWrites(() =>
      asUser(t, user).mutation(api.conversationLifecycle.createConversation, {
        user_id: user,
        session_id: "ingest-trace",
        agent_type: "claude_code",
        started_at: before,
        ...(fork
          ? { fork: { from: parent, at_uuid: "fork-point", copied: 3 } }
          : {}),
        ...(handoff
          ? {
              parent_conversation_id: parent,
              parent_message_uuid: "plan-handoff",
            }
          : {}),
      }),
    );
    expect(writes).toEqual([
      {
        table: "conversations",
        id,
        inserted: true,
        fields: expect.objectContaining({
          status: "active",
          user_id: user,
          session_id: "ingest-trace",
          started_at: before,
          ...(fork
            ? {
                forked_from: parent,
                fork_copied: 3,
                parent_message_uuid: "fork-point",
                inbox_stashed_at: now,
              }
            : {}),
          ...(handoff
            ? {
                parent_conversation_id: parent,
                parent_message_uuid: "plan-handoff",
              }
            : {}),
        }),
      },
      { table: "conversations", id, fields: { short_id: id.slice(0, 7) } },
      ...(fork
        ? [{ table: "conversations", id: parent, fields: { fork_count: 1 } }]
        : []),
      { table: "users", id: user, fields: { first_session_synced_at: now } },
      ...(handoff
        ? [
            {
              table: "conversations",
              id: parent,
              fields: { inbox_dismissed_at: now, status: "completed" },
            },
          ]
        : []),
    ]);
    const parentRow = await t.run(({ db }) => db.get(parent));
    expect(parentRow?.status).toBe(handoff ? "completed" : "active");
    expect(
      sessionMachine.initial({ session: "parent-trace", run: 1 }).status,
    ).toBe("active");
  });
}
