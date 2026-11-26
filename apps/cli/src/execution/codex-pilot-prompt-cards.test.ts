import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaimGrant } from "@codecast/edge-client";
import { createProviderAdapter } from "@codecast/provider-adapter";
import type { CanonicalEvent } from "@codecast/edge-contract";
import { fake, until } from "../../../../tests/codex-driver-parity/peers.js";
import {
  question,
  recordedItems,
} from "../../../../tests/codex-driver-parity/recording.js";
import type { SyncService } from "../syncService.js";
import { strictStub } from "../test-helpers/strictStub.js";
import { fixture, item } from "./codex-owned-pilot-fixture.js";
import { CodexPilotPromptCards } from "./codex-pilot-prompt-cards.js";

test("owned Codex publishes legacy-shaped prompt cards and closes them on provider settlement", async () => {
  const directory = mkdtempSync(join(tmpdir(), "owned-codex-cards-"));
  const app = fake(directory, "cards");
  const cards = new CodexPilotPromptCards();
  const adapter = createProviderAdapter({
    provider: { agent: "codex", version: "0.153.4" },
    command: [app.executable],
    retainRaw: (frame) => cards.retain(frame),
  });
  const claim: ClaimGrant = {
    v: 1,
    status: "granted",
    session: "conversation",
    run: 1,
    fencing_token: "granted-fence",
    lease_ms: 30_000,
    last_pane_instance: 0,
  };
  const messages: Parameters<SyncService["addMessages"]>[0]["messages"] = [];
  const permissions: Parameters<SyncService["createPermissionRequest"]>[0][] =
    [];
  const closedPermissions: string[] = [];
  const events: CanonicalEvent[] = [];
  const blocked: number[] = [];
  const sync = strictStub<SyncService>("publisher", {
    async addMessages(request) {
      expect(request.conversationId).toBe(claim.session);
      messages.push(...request.messages);
      return { inserted: request.messages.length, ids: [] };
    },
    async createPermissionRequest(request) {
      permissions.push(request);
      return `row-${request.fenced_prompt_id}`;
    },
    async cancelPermissionRequest(id) {
      closedPermissions.push(id);
      return true;
    },
  });
  let writer: Promise<void> | undefined;
  try {
    const opened = await adapter.start({
      ...claim,
      cwd: directory,
      afterSeq: 0,
    });
    if (opened.status !== "opened") throw new Error(JSON.stringify(opened));
    const session = opened.session;
    writer = (async () => {
      for await (const event of session.events) {
        if (event.kind === "message.delta") continue;
        events.push(event);
        await cards.publish(event, claim, session, sync, () =>
          blocked.push(event.seq),
        );
      }
    })();

    const turnId = app.turn(1);
    await session.steer({
      expected: {
        run: claim.run,
        fencing_token: claim.fencing_token,
        turn: null,
      },
      delivery_id: "first",
      authors: [{ kind: "person", id: "owner" }],
      input: [{ type: "text", text: "start the turn" }],
    });
    const address = (id: string) => ({
      run: claim.run,
      fencing_token: claim.fencing_token,
      prompt_id: `1:app-server:string:${id}`,
    });
    const params = { threadId: app.thread, turnId };
    app.send({
      frames: [
        ...recordedItems(app.thread, turnId),
        {
          id: "approve",
          method: "item/commandExecution/requestApproval",
          params: {
            ...params,
            itemId: "exec",
            command: "pwd",
            reason: "Show the working directory",
          },
        },
        {
          id: "ask",
          method: "item/tool/requestUserInput",
          params: {
            ...params,
            itemId: "native-question",
            questions: [question],
          },
        },
        {
          id: "secret",
          method: "item/tool/requestUserInput",
          params: {
            ...params,
            itemId: "secret-question",
            questions: [{ ...question, isSecret: true }],
          },
        },
      ],
    });

    await until(
      () => messages.length === 1 && permissions.length === 1,
      "publish visible cards",
    );
    expect(permissions[0]).toMatchObject({
      conversation_id: claim.session,
      session_id: app.thread,
      fenced_prompt_id: address("approve").prompt_id,
      fenced_prompt_turn_id: turnId,
      tool_name: "item/commandExecution/requestApproval",
      arguments_preview: expect.stringContaining("pwd"),
    });
    const questionCall = messages[0]!.toolCalls?.[0];
    expect(questionCall).toEqual({
      id: address("ask").prompt_id,
      name: "AskUserQuestion",
      input: {
        fencedTurnId: turnId,
        questions: [
          {
            id: question.id,
            question: question.question,
            header: question.header,
            isSecret: false,
            options: question.options,
          },
        ],
      },
    });
    await until(
      () => app.wire().some(({ id }) => id === "secret"),
      "cancel the secret request",
    );
    expect(app.wire().find(({ id }) => id === "secret")?.result).toEqual({
      answers: {},
    });
    expect(messages).toHaveLength(1);
    expect(blocked).toHaveLength(2);

    await session.answer({
      expected: address("ask"),
      by: { kind: "person", id: "owner" },
      answer: { answers: { question: { answers: ["Short"] } } },
    });
    await session.answer({
      expected: address("approve"),
      by: { kind: "person", id: "owner" },
      answer: { behavior: "allow" },
    });
    await until(
      () => messages.length === 2 && closedPermissions.length === 1,
      "close settled cards",
    );
    expect(messages[1]).toMatchObject({
      role: "human",
      toolResults: [
        {
          toolUseId: address("ask").prompt_id,
          content: "Answered from the app: Short",
        },
      ],
    });
    expect(closedPermissions).toEqual([`row-${address("approve").prompt_id}`]);
    expect(
      events
        .filter((event) => event.kind === "prompt.settled")
        .map(({ body }) => body.prompt_id),
    ).toEqual([
      address("secret").prompt_id,
      address("ask").prompt_id,
      address("approve").prompt_id,
    ]);
  } finally {
    await adapter.dispose();
    await writer;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the owned runtime publishes the question and closes it when the turn ends", async () => {
  const f = fixture();
  const turnId = f.appServer.turn(3);
  const threadId = f.appServer.thread;
  try {
    await f.runtime.processWorkUpdate([item(f.pilotRequest)]);
    await until(
      () => f.events.some((event) => event.kind === "turn.started"),
      "resumed turn",
    );
    f.appServer.send({
      frames: [
        {
          id: "open",
          method: "item/tool/requestUserInput",
          params: {
            threadId,
            turnId,
            itemId: "ask-item",
            questions: [question],
          },
        },
      ],
    });
    await until(
      () => f.promptMessages.length === 1,
      "owned runtime writes the card",
    );
    expect(f.promptMessages[0]?.toolCalls?.[0]?.id).toBe(
      "1:app-server:string:open",
    );
    f.appServer.send({
      frames: [
        {
          method: "turn/completed",
          params: {
            threadId,
            turn: { id: turnId, items: [], status: "completed" },
          },
        },
      ],
    });
    await until(
      () => f.promptMessages.length === 2,
      "owned runtime closes the card",
    );
    expect(f.promptMessages[1]?.toolResults).toEqual([
      {
        toolUseId: "1:app-server:string:open",
        content: "Codex question cancelled",
      },
    ]);
  } finally {
    await f.dispose();
  }
});
