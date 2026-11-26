import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import {
  threadItemsToMessages,
  type Turn,
  type ThreadItem,
} from "./codex-app-server.js";
import { CodexRecoveryQueue } from "./codexRecoveryQueue";
import { functionBlock, sliceBetween } from "./test-helpers/sourceRegion";

const source = readFileSync(new URL("./daemon.ts", import.meta.url), "utf8");
const code = new Bun.Transpiler({ loader: "ts" }).transformSync(
  [
    ...["readyCodexAppServer", "rehydratePersistedAppServerThreads"].map(
      (name) => functionBlock(source, name).text,
    ),
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
  const queued = new Set<string>();
  const liveTurns = new Map<string, Turn>();
  const progress = new Map<string, { threadId: string; items: ThreadItem[] }>();
  const resumed: string[] = [];
  const queried: string[] = [];
  const errors: unknown[] = [];
  const registered: Array<[string, string]> = [];
  const threads = new Map<string, { conversationId: string }>();
  const published: Array<{
    conversationId: string;
    messages: ReturnType<typeof threadItemsToMessages>;
  }> = [];
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
        const active = liveTurns.get(threadId);
        return {
          thread: { id: threadId, turns: active ? [active] : [] },
          sandbox: { type: "readOnly" },
        };
      },
    }),
    appServerShuttingDown: false,
    persistedAppServerThreads: saved,
    appServerConversations: live,
    appServerThreads: threads,
    appServerTurnProgress: progress,
    makeAppServerTurnProgress: (threadId: string) => ({ threadId, items: [] }),
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
          hasPendingMessages: queued.has(id),
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
      threads.set(threadId, { conversationId: id });
    },
    ensureManagedSessionHeartbeat: () => {},
    recoverCodexTurn: async () => "none",
    findActiveTurnForThread: () => undefined,
    deviceId: () => "local",
    persistAppServerThreadRegistrations: () => {},
    log: () => {},
    policyForPersist: () => undefined,
    markTurnStarted: () => {},
    sendAgentStatus: () => {},
    markAppServerConversationResumable: () => {},
    removeAppServerPartial: () => {},
    threadItemsToMessages,
    syncAppServerTurnMessagesIfChanged: async (
      _turnId: string,
      conversationId: string,
      messages: ReturnType<typeof threadItemsToMessages>,
    ) => {
      published.push({ conversationId, messages });
    },
    syncService: {},
    retryQueue: {},
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
    queued,
    liveTurns,
    progress,
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

test("a queued follow-up keeps the resumed active turn ready for streaming", async () => {
  const f = fixture();
  const conversation = "conversation-8";
  const threadId = "thread-8";
  const turnId = "active-turn";
  const item = {
    type: "agentMessage",
    id: "earlier-item",
    text: "Earlier output",
  } as const;
  f.saved.get(conversation)!.activeTurnId = turnId;
  f.queued.add(conversation);
  f.liveTurns.set(threadId, {
    id: turnId,
    status: "inProgress",
    items: [item],
  });
  await f.ready(conversation);
  expect(f.errors).toEqual([]);
  expect(f.progress.get(turnId)).toEqual({ threadId, items: [item] });
});

test("a late turn start keeps resumed output and completion replaces the seeded item", async () => {
  const f = fixture();
  const conversationId = "conversation-8";
  const threadId = "thread-8";
  const turnId = "active-turn";
  const completed = {
    type: "agentMessage",
    id: "replayed",
    text: "Final output",
  } as const;
  f.saved.get(conversationId)!.activeTurnId = turnId;
  f.queued.add(conversationId);
  f.liveTurns.set(threadId, {
    id: turnId,
    status: "inProgress",
    items: [
      { type: "agentMessage", id: "earlier", text: "Earlier output" },
      { ...completed, text: "Draft output" },
    ],
  });
  await f.ready(conversationId);
  f.events.emit("turnStarted", threadId, turnId, "codex");
  f.events.emit("itemCompleted", threadId, turnId, completed);
  expect(f.published).toEqual([
    {
      conversationId,
      messages: [
        expect.objectContaining({
          role: "assistant",
          content: "Earlier output\nFinal output",
        }),
      ],
    },
  ]);
});
