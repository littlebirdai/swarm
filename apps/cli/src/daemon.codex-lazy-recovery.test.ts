import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { threadItemsToMessages, type Turn } from "./codex-app-server.js";
import { CodexRecoveryQueue } from "./codexRecoveryQueue";
import { functionBlock, sliceBetween } from "./test-helpers/sourceRegion";

const source = readFileSync(new URL("./daemon.ts", import.meta.url), "utf8");
const code = new Bun.Transpiler({ loader: "ts" }).transformSync(
  [
    ...[
      "readyCodexAppServer",
      "rehydratePersistedAppServerThreads",
      "makeAppServerTurnProgress",
      "removeAppServerPartial",
    ].map((name) => functionBlock(source, name).text),
    ...["turnStarted", "itemCompleted"].map(
      (event) =>
        sliceBetween(
          source,
          `  codexAppServerInstance.on(\n    "${event}",`,
          "\n  );",
        ).text + "\n  );",
    ),
  ].join("\n"),
);

function fixture() {
  const saved = new Map<string, { threadId: string; activeTurnId?: string }>();
  for (let i = 0; i < 50; i++)
    saved.set(`conversation-${i}`, { threadId: `thread-${i}` });
  const live = new Map<string, string>();
  const resumed: string[] = [];
  const queried: string[] = [];
  const errors: unknown[] = [];
  const registered: Array<[string, string]> = [];
  const activeTurns = new Map<string, Turn>();
  const published: string[] = [];
  let functions: {
    ready: (id: string) => Promise<unknown>;
    recover: (requested?: ReadonlySet<string>) => Promise<void>;
  };
  const queue = new CodexRecoveryQueue(
    (requested) => functions.recover(requested),
    () => {},
    (error) => errors.push(error),
  );
  const deps = {
    codexAppServerInstance: Object.assign(new EventEmitter(), {
      running: true,
      restartIfAuthChanged: async () => {},
      threadResume: async ({ threadId }: { threadId: string }) => {
        resumed.push(threadId);
        const turn = activeTurns.get(threadId);
        return {
          thread: { id: threadId, turns: turn ? [turn] : [] },
          sandbox: { type: "readOnly" },
        };
      },
    }),
    appServerShuttingDown: false,
    persistedAppServerThreads: saved,
    appServerConversations: live,
    appServerThreads: new Map(),
    appServerTurnProgress: new Map(),
    appServerRecoveryRetryAt: new Map(),
    appServerRecoveringThreads: new Set(),
    pendingAgentSwitches: new Set(),
    codexRecoveryQueue: queue,
    syncServiceRef: {
      getConversationLifecycle: async (id: string) => {
        queried.push(id);
        return {
          hideStateKnown: true,
          agentType: "codex",
          status: "active",
          hasPendingMessages: false,
        };
      },
      getConversationOwnerInfo: async () => ({ ownerDeviceId: "local" }),
      registerManagedSession: async (
        threadId: string,
        _pid: number,
        _tmux: undefined,
        conversationId: string,
      ) => {
        registered.push([threadId, conversationId]);
      },
    },
    logConvexFailure: (error: unknown) => errors.push(error),
    conversationUsesCodexAppServer: (type: string) => type === "codex",
    activeConfig: {},
    resolveCodexPermissionDefaults: () => ({ approvalPolicy: "never" }),
    codexResumeParams: (record: unknown) => record,
    registerAppServerConversation: (id: string, threadId: string) => {
      live.set(id, threadId);
      deps.appServerThreads.set(threadId, { conversationId: id });
    },
    ensureManagedSessionHeartbeat: () => {},
    recoverCodexTurn: async ({ thread }: { thread: { turns: Turn[] } }) =>
      thread.turns.some((turn) => turn.status === "inProgress")
        ? "active"
        : "none",
    findActiveTurnForThread: () => undefined,
    deviceId: () => "local",
    persistAppServerThreadRegistrations: () => {},
    policyForPersist: () => undefined,
    markTurnStarted: () => {},
    sendAgentStatus: () => {},
    markAppServerConversationResumable: () => {},
    threadItemsToMessages,
    syncAppServerTurnMessagesIfChanged: async (
      _turnId: string,
      _conversationId: string,
      messages: ReturnType<typeof threadItemsToMessages>,
    ) => {
      for (const message of messages) published.push(message.content);
    },
    syncService: {},
    retryQueue: {},
    log: () => {},
    logError: (_message: string, error: unknown) => errors.push(error),
  };
  functions = new Function(
    ...Object.keys(deps),
    code +
      "\nreturn { ready: readyCodexAppServer, recover: rehydratePersistedAppServerThreads };",
  )(...Object.values(deps));
  return {
    ...functions,
    saved,
    live,
    resumed,
    queried,
    errors,
    queue,
    registered,
    activeTurns,
    events: deps.codexAppServerInstance,
    published,
  };
}

test("daemon boot leaves 50 idle saved Codex threads cold without querying or spawning them", async () => {
  const f = fixture();
  f.queue.request(true);
  await f.queue.wait();
  expect(f.resumed).toEqual([]);
  expect(f.queried).toEqual([]);
  expect(f.saved.size).toBe(50);
  expect(f.errors).toEqual([]);
});

test("delivery restores its saved thread on demand and a repeated delivery reuses it", async () => {
  const f = fixture();
  await f.ready("conversation-12");
  await f.ready("conversation-12");
  expect(f.resumed).toEqual(["thread-12"]);
  expect(f.live.get("conversation-12")).toBe("thread-12");
  // The server row naming the thread is re-registered: status writes and lines
  // the agent posts resolve to their conversation only through it.
  expect(f.registered).toEqual([["thread-12", "conversation-12"]]);
  expect(f.saved.size).toBe(50);
  expect(f.errors).toEqual([]);
});

test("daemon boot still restores an interrupted active turn without a new delivery", async () => {
  const f = fixture();
  f.saved.get("conversation-8")!.activeTurnId = "interrupted";
  f.queue.request(true);
  await f.queue.wait();
  expect(f.resumed).toEqual(["thread-8"]);
  expect(f.errors).toEqual([]);
});

test("a late turn start preserves output collected after resuming an active turn", async () => {
  const f = fixture();
  const threadId = "thread-8";
  const turnId = "active-turn";
  f.saved.get("conversation-8")!.activeTurnId = turnId;
  f.activeTurns.set(threadId, { id: turnId, status: "inProgress", items: [] });
  await f.ready("conversation-8");
  expect(f.errors).toEqual([]);

  f.events.emit("itemCompleted", threadId, turnId, {
    id: "first",
    type: "agentMessage",
    text: "Output after resume",
  });
  f.events.emit("turnStarted", threadId, turnId, "codex");
  f.events.emit("itemCompleted", threadId, turnId, {
    id: "second",
    type: "agentMessage",
    text: "More output",
  });

  expect(f.published).toEqual([
    "Output after resume",
    "Output after resume\nMore output",
  ]);
});

test("a repeated item completion replaces its text in place", async () => {
  const f = fixture();
  const threadId = "thread-8";
  const turnId = "new-turn";
  await f.ready("conversation-8");
  expect(f.errors).toEqual([]);

  f.events.emit("turnStarted", threadId, turnId, "codex");
  const first = { id: "first", type: "agentMessage", text: "Draft" };
  f.events.emit("itemCompleted", threadId, turnId, first);
  f.events.emit("itemCompleted", threadId, turnId, {
    id: "second",
    type: "agentMessage",
    text: "Second item",
  });
  f.events.emit("itemCompleted", threadId, turnId, {
    ...first,
    text: "Final",
  });

  expect(f.published).toEqual([
    "Draft",
    "Draft\nSecond item",
    "Final\nSecond item",
  ]);
});
