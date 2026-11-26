import { afterEach, beforeEach, expect, jest, spyOn, test } from "bun:test";
import { sessionMachine } from "@codecast/session-contract";
import { api, internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { asUser, serverTest } from "../test-helpers/database.testkit";
import { fixtureRows } from "../test-helpers/rows.testkit";

const now = 1_750_000_000_000;
const token = "w".repeat(64);
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

async function recordWrites<T>(run: () => Promise<T>) {
  const runtime = (globalThis as unknown as { Convex: object }).Convex;
  const original = Object.getOwnPropertyDescriptor(runtime, "asyncSyscall")!;
  const writes: (string | ReturnType<typeof conversationWrite>)[] = [];
  Object.defineProperty(runtime, "asyncSyscall", {
    ...original,
    get() {
      const call: AsyncSyscall = original.get!.call(runtime);
      return async (operation: string, json: string) => {
        const result = await call(operation, json);
        if (operation !== "1.0/insert" && operation !== "1.0/shallowMerge")
          return result;
        const { table, id, value } = JSON.parse(json);
        const target =
          table ??
          ["conversations", "workflow_runs", "messages"].find((name) =>
            id?.endsWith(name),
          );
        if (target === "conversations") {
          const {
            status,
            inbox_stashed_at,
            inbox_stash_hidden,
            message_count,
            last_message_role,
            updated_at,
          } = value;
          writes.push(
            conversationWrite(
              id ?? JSON.parse(result)._id,
              operation === "1.0/insert" ? "insert" : "patch",
              {
                status,
                inbox_stashed_at,
                inbox_stash_hidden,
                message_count,
                last_message_role,
                updated_at,
              },
            ),
          );
        } else if (target === "workflow_runs") {
          writes.push(
            value.status
              ? `workflow_runs ${value.status}`
              : "workflow_runs link",
          );
        } else if (target === "messages") {
          writes.push(`messages ${JSON.parse(value.content).__wf}`);
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

async function seed() {
  const t = serverTest();
  const ids = await t.run(async ({ db }) => {
    const rows = fixtureRows(db, "workflow log status replay");
    const user = await rows.user();
    await rows.token(user, token);
    const task = await rows.task(user, { workspace: `user:${user}` });
    const taskRow = (await db.get(task))!;
    const workflow = await db.insert("workflows", {
      user_id: user,
      name: "Trace flow",
      slug: "trace-flow",
      nodes: [],
      edges: [],
      created_at: now,
      updated_at: now,
    });
    const host = await rows.conversation(user, { message_count: 5 });
    return { user, task, workflow, host, taskRef: taskRow.short_id };
  });
  const viewer = asUser(t, ids.user);
  return { t, viewer, ...ids };
}

function conversationWrite(
  id: string,
  operation: "insert" | "patch",
  fields: Partial<
    Pick<
      Doc<"conversations">,
      | "status"
      | "inbox_stashed_at"
      | "inbox_stash_hidden"
      | "message_count"
      | "last_message_role"
      | "updated_at"
    >
  >,
) {
  return { target: "conversations", operation, id, ...fields };
}

for (const path of [
  "web",
  "web task",
  "web host",
  "cli",
  "cli task",
] as const) {
  test(`${path} matches its workflow log creation trace`, async () => {
    const { t, viewer, task, workflow, host, taskRef } = await seed();
    const taskBound = path === "web task" || path === "cli task";
    const existing = path === "web host";
    const { result, writes } = await recordWrites(async () => {
      if (path === "cli" || path === "cli task") {
        const created = await t.mutation(api.workflow_runs.createFromCli, {
          api_token: token,
          workflow_name: "Trace flow",
          workflow_id: workflow,
          task_id: taskBound ? taskRef : undefined,
        });
        return created.run_id;
      }
      return viewer.mutation(api.workflow_runs.create, {
        workflow_id: workflow,
        task_id: taskBound ? task : undefined,
        existing_conversation_id: existing ? host : undefined,
      });
    });

    expect(result).toBeTruthy();
    const log = await t.run(async ({ db }) => {
      const run = await db.get(result!);
      return db.get(run!.primary_conversation_id!);
    });
    expect(log).toBeTruthy();
    const id = log!._id;
    expect(log).toMatchObject({
      workflow_run_id: result,
      status: sessionMachine.initial({ session: log!.session_id, run: 1 })
        .status,
      message_count: existing ? 6 : 1,
    });
    expect(log!.is_workflow_primary).toBe(existing ? undefined : true);
    expect(log!.inbox_stashed_at).toBe(taskBound ? now : undefined);
    expect(log!.inbox_stash_hidden).toBe(taskBound ? true : undefined);
    if (existing) expect(id).toBe(host);
    expect(writes).toEqual([
      "workflow_runs pending",
      existing
        ? conversationWrite(id, "patch", { updated_at: now })
        : conversationWrite(id, "insert", {
            status: "active",
            ...(taskBound
              ? { inbox_stashed_at: now, inbox_stash_hidden: true }
              : {}),
            message_count: 0,
            updated_at: now,
          }),
      "workflow_runs link",
      "messages started",
      conversationWrite(id, "patch", {
        message_count: existing ? 6 : 1,
        last_message_role: "assistant",
      }),
    ]);
  });
}

for (const report of [
  { run: "running", node: "work", event: "node_start" },
  { run: "completed", node: "work", event: "node_done" },
  { run: "failed", node: "work", event: "node_failed" },
  { run: "completed", node: "start", event: null },
  { run: "completed", node: "work", event: "node_done", host: true },
  { run: "completed", node: undefined, event: null },
] as const) {
  const existing = "host" in report;
  test(`${report.run} at ${report.node ?? "no node"} matches its ${existing ? "host session" : "workflow log"} progress trace`, async () => {
    const { t, viewer, workflow, host } = await seed();
    const run = await viewer.mutation(api.workflow_runs.create, {
      workflow_id: workflow,
      existing_conversation_id: existing ? host : undefined,
    });
    const id = await t.run(
      async ({ db }) => (await db.get(run))!.primary_conversation_id!,
    );
    const { result, writes } = await recordWrites(() =>
      t.mutation(api.workflow_runs.updateProgress, {
        api_token: token,
        run_id: run,
        current_node_id: report.node ?? "work",
        node_id: report.node,
        node_status: report.node ? report.run : undefined,
        run_status: report.run,
      }),
    );
    expect(result).toEqual({ ok: true });
    const log = await t.run(({ db }) => db.get(id));
    const contractStatus = sessionMachine.initial({
      session: log!.session_id,
      run: 1,
    }).status;
    const storedStatus =
      report.event && report.run !== "running" ? "completed" : contractStatus;
    const messageCount = (existing ? 6 : 1) + Number(report.event !== null);
    expect(log).toMatchObject({
      status: storedStatus,
      message_count: messageCount,
    });
    if (existing) expect(id).toBe(host);
    expect(writes).toEqual([
      `workflow_runs ${report.run}`,
      ...(report.event
        ? [
            `messages ${report.event}`,
            conversationWrite(id, "patch", {
              ...(storedStatus === "completed" ? { status: "completed" } : {}),
              message_count: messageCount,
              last_message_role: "assistant",
              updated_at: now,
            }),
          ]
        : []),
    ]);
  });
}

test("the workflow log stash backfill matches its dry, write, and retry traces", async () => {
  const { t, viewer, task, workflow, host } = await seed();
  const run = await viewer.mutation(api.workflow_runs.create, {
    workflow_id: workflow,
    task_id: task,
  });
  const id = await t.run(async ({ db }) => {
    const row = (await db.get(run))!;
    const id = row.primary_conversation_id!;
    await db.patch(id, {
      inbox_stashed_at: undefined,
      inbox_stash_hidden: undefined,
    });
    await db.insert("workflow_runs", {
      user_id: row.user_id,
      workflow_id: workflow,
      task_id: task,
      status: "completed",
      node_statuses: [],
      primary_conversation_id: host,
      created_at: now,
      updated_at: now,
    });
    return id;
  });

  for (const step of ["dry", "write", "retry"] as const) {
    const { result, writes } = await recordWrites(() =>
      t.mutation(internal.workflow_runs.hideTaskRunLogs, {
        dry: step === "dry",
      }),
    );
    expect(result).toEqual({ hidden: step === "retry" ? 0 : 1, cursor: null });
    expect(writes).toEqual(
      step === "write"
        ? [
            conversationWrite(id, "patch", {
              inbox_stashed_at: now,
              inbox_stash_hidden: true,
            }),
          ]
        : [],
    );
    const log = await t.run(({ db }) => db.get(id));
    expect(log!.status).toBe("active");
    expect(log!.inbox_stashed_at).toBe(step === "dry" ? undefined : now);
    expect(log!.inbox_stash_hidden).toBe(step === "dry" ? undefined : true);
  }
});
