import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import { sessionMachine } from "@codecast/session-contract";
import { api } from "./_generated/api";
import { provisionStandingAgent } from "./anchors";
import { reviveConversationOnDelivery } from "./pendingMessageWrites";
import { asUser, serverTest } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";

const now = 1_750_000_000_000;
const earlier = now - 1000;
const path = "/work/status";
const unset = { $undefined: null };
let limiterShard: ReturnType<typeof spyOn>;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(now);
  limiterShard = spyOn(Math, "random").mockReturnValue(0.5);
});

afterEach(() => {
  limiterShard.mockRestore();
  jest.clearAllTimers();
  jest.useRealTimers();
});

type AsyncSyscall = (operation: string, args: string) => Promise<string>;
type Write = {
  table: string;
  id: string;
  operation: "insert" | "patch";
  fields: Record<string, unknown>;
};

async function recordWrites<T>(run: () => Promise<T>) {
  const runtime = (globalThis as unknown as { Convex: object }).Convex;
  const original = Object.getOwnPropertyDescriptor(runtime, "asyncSyscall")!;
  const writes: Write[] = [];
  const tracked = [
    "anchors",
    "conversations",
    "pending_messages",
    "daemon_commands",
    "tasks",
  ];
  Object.defineProperty(runtime, "asyncSyscall", {
    ...original,
    get() {
      const call: AsyncSyscall = original.get!.call(runtime);
      return async (operation: string, json: string) => {
        const result = await call(operation, json);
        if (operation !== "1.0/insert" && operation !== "1.0/shallowMerge")
          return result;
        const { table, id, value } = JSON.parse(json);
        const target = tracked.find(
          (name) => table === name || id?.endsWith(name),
        );
        if (target)
          writes.push({
            table: target,
            id: id ?? JSON.parse(result)._id,
            operation: operation === "1.0/insert" ? "insert" : "patch",
            fields: value,
          });
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

async function seed() {
  const t = serverTest();
  const ids = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "session creation status replay");
    const user = await rows.user({ name: "Owner" });
    await rows.device(user, { device_id: "trace-machine", last_seen: now });
    const task = await rows.task(user, {
      workspace: `user:${user}`,
      short_id: "ct-trace",
      title: "Status trace task",
      project_path: path,
    });
    return { user, task };
  });
  return { t, viewer: asUser(t, ids.user), ...ids };
}

const creationOrder = {
  anchor: [
    "insert anchors provisioning",
    "insert conversations active",
    "patch conversations short_id",
    "patch conversations owner_device_id",
    "insert daemon_commands start_session",
    "patch anchors active",
    "insert pending_messages pending",
    "patch conversations has_pending_messages,updated_at",
  ],
  task: [
    "insert conversations active",
    "patch conversations short_id",
    "patch tasks conversation_ids,first_linked_conversation",
    "insert pending_messages pending",
    "patch conversations has_pending_messages,updated_at",
    "patch conversations owner_device_id",
    "insert daemon_commands start_session",
  ],
  user: [
    "insert conversations active",
    "patch conversations short_id",
    "patch conversations owner_device_id",
    "insert daemon_commands start_session",
  ],
};

for (const kind of ["anchor", "task", "user"] as const) {
  test(`${kind} creation preserves the row and start order`, async () => {
    const { t, viewer, user, task } = await seed();
    const { result: id, writes } = await recordWrites(async () => {
      if (kind === "anchor") {
        const result = await t.run((ctx) =>
          provisionStandingAgent(ctx, user, {
            scope_type: "user",
            name: "Standing trace",
            project_path: path,
          }),
        );
        return result.conversation_id!;
      }
      if (kind === "task") {
        const result = await viewer.mutation(api.tasks.assignToAgent, {
          short_id: "ct-trace",
          agent_type: "claude_code",
        });
        return result.conversationId;
      }
      const result = await viewer.mutation(api.users.startSession, {
        agent_type: "claude",
        project_path: path,
        prompt: "Start trace",
      });
      return result.conversation_id;
    });
    const { row, cmd, taskRow } = await t.run(async ({ db }) => ({
      row: await db.get(id),
      cmd: await db.query("daemon_commands").first(),
      taskRow: await db.get(task),
    }));
    expect(row).toMatchObject({
      user_id: user,
      agent_type: "claude_code",
      status: "active",
      started_at: now,
      updated_at: now,
      message_count: 0,
      short_id: id.slice(0, 7),
      owner_device_id: "trace-machine",
      project_path: path,
    });
    expect(row?.status).toBe(
      sessionMachine.initial({ session: row!.session_id, run: 1 }).status,
    );
    expect(row?.persistent).toBe(kind === "anchor" ? true : undefined);
    expect(row?.active_task_id).toBe(kind === "task" ? task : undefined);
    expect(taskRow?.conversation_ids).toEqual(
      kind === "task" ? [id] : undefined,
    );
    expect(row?.has_pending_messages).toBe(kind === "user" ? undefined : true);
    expect(JSON.parse(cmd!.args!)).toMatchObject({
      conversation_id: id,
      agent_type: "claude",
      project_path: path,
    });
    expect(cmd?.target_device_id).toBe("trace-machine");
    expect(
      writes
        .filter((write) => write.table === "conversations")
        .every((write) => write.id === id),
    ).toBe(true);
    expect(
      writes.map(
        ({ table, operation, fields }) =>
          `${operation} ${table} ${fields.status ?? fields.command ?? Object.keys(fields).sort().join(",")}`,
      ),
    ).toEqual(creationOrder[kind]);
  });
}

const hidden = {
  status: "completed",
  inbox_killed_at: earlier,
  inbox_dismissed_at: earlier,
  inbox_stashed_at: earlier,
  inbox_stash_hidden: true,
  inbox_snoozed_until: now + 1000,
  thread_state: "Done",
  thread_state_at: earlier,
  thread_state_status: "done",
  thread_state_msg_count: 4,
  thread_state_result: "Report",
  thread_state_result_at: earlier,
  reported_to_parent_at: earlier,
} as const;

async function seedRevival() {
  const t = serverTest();
  const { user, id } = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "session revival status replay");
    const user = await rows.user();
    const id = await rows.conversation(user, {
      session_id: "revival-trace",
      owner_device_id: "trace-machine",
      ...hidden,
    });
    return { user, id };
  });
  return { t, viewer: asUser(t, user), user, id };
}

function endedSession(session: string) {
  const scope = { session, run: 1 };
  return sessionMachine.apply(sessionMachine.initial(scope), {
    kind: "provider.event",
    event: {
      ...scope,
      v: 1,
      seq: 1,
      at: earlier,
      source: "provider",
      turn: null,
      kind: "session.ended",
      body: { reason: "completed" },
    },
  }).state;
}

for (const human of [true, false]) {
  test(`${human ? "human enqueue" : "scheduler enqueue"} revives in the original write order`, async () => {
    const { t, viewer, user, id } = await seedRevival();
    const { result, writes } = await recordWrites(() =>
      viewer.mutation(api.pendingMessages.sendMessageToSession, {
        conversation_id: id,
        content: "New input",
        ...(human ? { human: true } : { origin: "scheduler" }),
      }),
    );
    expect(writes).toEqual([
      {
        table: "pending_messages",
        id: result,
        operation: "insert",
        fields: expect.objectContaining({
          conversation_id: id,
          from_user_id: user,
          content: "New input",
          status: "pending",
        }),
      },
      {
        table: "conversations",
        id,
        operation: "patch",
        fields: {
          updated_at: now,
          status: "active",
          has_pending_messages: true,
          inbox_dismissed_at: unset,
          inbox_killed_at: unset,
          reported_to_parent_at: unset,
          ...(human
            ? {
                inbox_stashed_at: unset,
                inbox_snoozed_until: unset,
                thread_state: unset,
                thread_state_at: unset,
                thread_state_status: unset,
                thread_state_msg_count: unset,
              }
            : {}),
        },
      },
    ]);
    const row = await t.run(({ db }) => db.get(id));
    expect(row?.status).toBe("active");
    expect(row?.inbox_stashed_at).toBe(human ? undefined : earlier);
    expect(row?.thread_state).toBe(human ? undefined : hidden.thread_state);
    expect(row?.thread_state_result).toBe(hidden.thread_state_result);

    const ended = endedSession(row!.session_id);
    const submitted = sessionMachine.apply(ended, {
      session: ended.session,
      run: ended.run,
      kind: "inbox.submitted",
      delivery_id: "new-input",
      intent: "steer",
      seq: 1,
      expectedTurn: null,
    }).state;
    expect(submitted.status).toBe("completed");
  });
}

for (const ownerDevice of [true, false]) {
  test(`${ownerDevice ? "daemon delivery" : "unbound delivery report"} preserves the revival trace`, async () => {
    const { t, viewer, user, id } = await seedRevival();
    const message = await t.run(({ db }) =>
      db.insert("pending_messages", {
        conversation_id: id,
        from_user_id: user,
        content: "Old input",
        status: "pending",
        created_at: earlier,
        retry_count: 0,
      }),
    );
    const { result, writes } = await recordWrites(() =>
      viewer.mutation(api.pendingMessages.updateMessageStatus, {
        message_id: message,
        status: "injected",
        paste_verified: true,
        ...(ownerDevice ? { device_id: "trace-machine" } : {}),
      }),
    );
    expect(result).toEqual({ success: true, skipped: false });
    expect(writes).toEqual([
      {
        table: "pending_messages",
        id: message,
        operation: "patch",
        fields: {
          status: "injected",
          delivered_at: unset,
          paste_verified_at: now,
        },
      },
      ...(ownerDevice
        ? [
            {
              table: "conversations",
              id,
              operation: "patch",
              fields: {
                status: "active",
                inbox_killed_at: unset,
                inbox_dismissed_at: unset,
              },
            },
          ]
        : []),
    ]);
    const row = await t.run(({ db }) => db.get(id));
    expect(row?.status).toBe(ownerDevice ? "active" : "completed");
    expect(row?.inbox_stashed_at).toBe(earlier);
    expect(row?.thread_state).toBe(hidden.thread_state);

    if (ownerDevice) {
      const ended = endedSession(row!.session_id);
      const receipt = sessionMachine.apply(ended, {
        kind: "provider.event",
        event: {
          session: ended.session,
          run: ended.run,
          v: 1,
          seq: 2,
          at: now,
          source: "provider",
          turn: null,
          kind: "receipt",
          body: { delivery_id: "old-input" },
        },
      }).state;
      expect(receipt.status).toBe("completed");

      const retry = await recordWrites(() =>
        t.run((ctx) => reviveConversationOnDelivery(ctx, id)),
      );
      expect(retry).toEqual({ result: false, writes: [] });
    }
  });
}
