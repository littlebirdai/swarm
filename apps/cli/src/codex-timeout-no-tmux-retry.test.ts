import { expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fake, until } from "../../../tests/codex-driver-parity/peers.js";
import {
  CodexAppServer,
  CodexRequestRefused,
  isAuthoritativeRefusal,
} from "./codex-app-server.js";
import { PendingDeliveryHeldError } from "./pendingDeliveryAdmission.js";
import { blockAt, functionBlock } from "./test-helpers/sourceRegion.js";

const source = readFileSync(new URL("./daemon.ts", import.meta.url), "utf8");
const code = new Bun.Transpiler({ loader: "ts" }).transformSync(
  [
    blockAt(source, source.indexOf("class CodexDeliveryInDoubt ")).text,
    functionBlock(source, "buildCodexUserTurnMessage").text,
    blockAt(source, source.indexOf("const tryAppServerDelivery = ")).text,
  ]
    .join("\n")
    .replace(/^export /gm, ""),
);
const injected = {
  messageId: "message",
  options: { conversationId: "conversation", pasteVerified: true },
};

function appServerDelivery(
  threadId: string,
  turnStart: (
    params: Parameters<CodexAppServer["turnStart"]>[0],
  ) => Promise<unknown>,
  {
    admit = async () => {},
    updateMessageStatus = async () => {},
  }: {
    admit?: () => Promise<void>;
    updateMessageStatus?: () => Promise<void>;
  } = {},
) {
  const marks: unknown[] = [];
  const deps = {
    readyCodexAppServer: async () => ({ turnStart }),
    appServerConversations: new Map([["conversation", threadId]]),
    agentTypeHint: undefined,
    conversationId: "conversation",
    messageId: "message",
    content: "Send once",
    withoutDeliveryId: (content: string) => content,
    deliverCodexPromptAnswer: async () => "none",
    deliveryStep: (_id: string, _name: string, work: () => Promise<void>) =>
      work(),
    admit,
    isAuthoritativeRefusal,
    isMissingAppServerThreadError: () => false,
    isCodexSafetyError: () => false,
    PendingDeliveryHeldError,
    markInjectedBestEffort: async (
      _service: unknown,
      messageId: string,
      _timeout: number,
      options: unknown,
    ) => {
      marks.push({ messageId, options });
    },
    deliveryEchoLedger: () => ({ expect: () => {} }),
    markTurnStarted: () => {},
    retryQueueRef: undefined,
    syncService: { updateMessageStatus },
    logDelivery: () => {},
  };
  const delivery = new Function(
    ...Object.keys(deps),
    code + "\nreturn { deliver: tryAppServerDelivery, CodexDeliveryInDoubt }",
  )(...Object.values(deps)) as {
    deliver: () => Promise<boolean>;
    CodexDeliveryInDoubt: typeof PendingDeliveryHeldError;
  };
  return { ...delivery, marks };
}

test("holds a Codex delivery in doubt when an accepted turn loses its RPC reply", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-timeout-"));
  const appServer = fake(directory, "timeout");
  const client = new CodexAppServer({
    codexBinary: appServer.executable,
    log: () => {},
  });
  const rpc = client as unknown as {
    sendRequest(
      method: string,
      params: object,
      timeout: number,
    ): Promise<unknown>;
  };
  const request = rpc.sendRequest.bind(client);
  try {
    client.start();
    await until(() => client.running, "Codex client ready");
    await client.threadStart({});
    await client.turnStart({ threadId: appServer.thread, input: [] });
    const completed = Promise.withResolvers<void>();
    client.once("turnCompleted", () => completed.resolve());
    appServer.send({
      frames: [
        {
          method: "turn/completed",
          params: {
            threadId: appServer.thread,
            turn: { id: appServer.turn(1), status: "completed" },
          },
        },
      ],
    });
    await completed.promise;
    rpc.sendRequest = (method, params, timeout) =>
      request(method, params, method === "turn/start" ? 250 : timeout);
    const started: string[] = [];
    client.on("turnStarted", (_thread, turn) => started.push(turn));

    const { deliver, CodexDeliveryInDoubt, marks } = appServerDelivery(
      appServer.thread,
      client.turnStart.bind(client),
    );
    await expect(deliver()).rejects.toBeInstanceOf(CodexDeliveryInDoubt);
    expect(started).toEqual([appServer.turn(2)]);
    expect(
      appServer.wire().filter(({ method }) => method === "turn/start"),
    ).toHaveLength(2);
    expect(marks).toEqual([injected]);
  } finally {
    client.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rethrows a transient admission error before marking or starting delivery", async () => {
  const transient = new Error("Admission is temporarily unavailable");
  const turnStart = mock(async () => {});
  const { deliver, marks } = appServerDelivery("thread", turnStart, {
    admit: async () => {
      throw transient;
    },
  });
  await expect(deliver()).rejects.toBe(transient);
  expect(turnStart).not.toHaveBeenCalled();
  expect(marks).toEqual([]);
});

test.each([
  ["transient status write failure", new Error("Delivery status unavailable")],
  [
    "status write failure marked refused",
    Object.assign(new Error("Delivery status write refused"), {
      refused: true,
    }),
  ],
])(
  "holds an accepted turn in doubt after a local failure: %s",
  async (_label, error) => {
    const turnStart = mock(async () => ({ turn: { id: "accepted" } }));
    const updateMessageStatus = mock(async () => {
      throw error;
    });
    const { deliver, CodexDeliveryInDoubt, marks } = appServerDelivery(
      "thread",
      turnStart,
      { updateMessageStatus },
    );
    await expect(deliver()).rejects.toBeInstanceOf(CodexDeliveryInDoubt);
    expect(turnStart).toHaveBeenCalledTimes(1);
    expect(updateMessageStatus).toHaveBeenCalledTimes(1);
    expect(marks).toEqual([injected]);
  },
);

test("an authoritative turn/start refusal leaves delivery unmarked and allows fallback", async () => {
  const turnStart = mock(async () => {
    throw new CodexRequestRefused("Turn already active");
  });
  const updateMessageStatus = mock(async () => {});
  const { deliver, marks } = appServerDelivery("thread", turnStart, {
    updateMessageStatus,
  });
  await expect(deliver()).resolves.toBe(false);
  expect(turnStart).toHaveBeenCalledTimes(1);
  expect(updateMessageStatus).not.toHaveBeenCalled();
  expect(marks).toEqual([]);
});
