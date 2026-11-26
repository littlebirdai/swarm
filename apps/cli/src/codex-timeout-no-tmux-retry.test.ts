import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fake, until } from "../../../tests/codex-driver-parity/peers.js";
import { CodexAppServer, isAuthoritativeRefusal } from "./codex-app-server.js";
import { PendingDeliveryHeldError } from "./pendingDeliveryAdmission.js";
import { blockAt } from "./test-helpers/sourceRegion.js";

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
  const marks: unknown[] = [];
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

    const source = readFileSync(
      new URL("./daemon.ts", import.meta.url),
      "utf8",
    );
    const { text } = blockAt(
      source,
      source.indexOf("const tryAppServerDelivery = "),
    );
    const deps = {
      readyCodexAppServer: async () => client,
      appServerConversations: new Map([["conversation", appServer.thread]]),
      agentTypeHint: undefined,
      conversationId: "conversation",
      messageId: "message",
      content: "Send once",
      withoutDeliveryId: (content: string) => content,
      deliverCodexPromptAnswer: async () => "none",
      deliveryStep: (_id: string, _name: string, work: () => Promise<void>) =>
        work(),
      admit: async () => {},
      isAuthoritativeRefusal,
      isMissingAppServerThreadError: () => false,
      isCodexSafetyError: () => false,
      PendingDeliveryHeldError,
      markInjectedBestEffort: (
        _service: unknown,
        messageId: string,
        _timeout: number,
        options: unknown,
      ) => {
        marks.push({ messageId, options });
        return Promise.resolve();
      },
      syncService: {},
      logDelivery: () => {},
    };
    const held = blockAt(source, source.indexOf("class CodexDeliveryInDoubt "));
    const code = new Bun.Transpiler({ loader: "ts" }).transformSync(
      held.text + "\n" + text,
    );
    const deliver = new Function(
      ...Object.keys(deps),
      code + "\nreturn tryAppServerDelivery",
    )(...Object.values(deps)) as () => Promise<boolean>;
    const outcome = await deliver().catch((error: unknown) => error);
    expect(started).toEqual([appServer.turn(2)]);
    expect(
      appServer.wire().filter(({ method }) => method === "turn/start"),
    ).toHaveLength(2);
    expect(outcome).toBeInstanceOf(PendingDeliveryHeldError);
    expect(marks).toEqual([
      {
        messageId: "message",
        options: { conversationId: "conversation", pasteVerified: true },
      },
    ]);
  } finally {
    client.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
