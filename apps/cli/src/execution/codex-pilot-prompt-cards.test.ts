import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaimGrant } from "@codecast/edge-client";
import { createProviderAdapter } from "@codecast/provider-adapter";
import type { CanonicalEvent } from "@codecast/edge-contract";
import { waitFor } from "@codecast/test-helpers/waitFor";
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
    getClient() {
      const page = [
        ...permissions.map((request) => ({
          kind: "permission",
          id: request.fenced_prompt_id,
          turn: request.fenced_prompt_turn_id,
          rowId: `row-${request.fenced_prompt_id}`,
        })),
        ...messages.flatMap((message) =>
          (message.toolCalls ?? []).map((call) => ({
            kind: "question",
            id: call.id,
            turn: (call.input as { fencedTurnId: string }).fencedTurnId,
            messageUuid: message.messageUuid,
          })),
        ),
      ];
      return strictStub<ReturnType<SyncService["getClient"]>>("stored cards", {
        async query() {
          return { page, isDone: true, continueCursor: "" } as never;
        },
      });
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
    expect(session.getPendingPrompts).toBeDefined();
    await new CodexPilotPromptCards().recover(
      claim.session,
      "fixture-bearer",
      sync,
      session.getPendingPrompts!,
      new AbortController().signal,
    );
    expect(messages).toHaveLength(1);
    expect(closedPermissions).toEqual([]);

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

test.each(["turn ends", "provider resolves its request"])(
  "the owned runtime closes a published question when the %s",
  async (ending) => {
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
          ending === "turn ends"
            ? {
                method: "turn/completed",
                params: {
                  threadId,
                  turn: { id: turnId, items: [], status: "completed" },
                },
              }
            : {
                method: "serverRequest/resolved",
                params: { threadId, requestId: "open" },
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
  },
);

test.each(["lease loss", "close", "restart", "sync error"] as const)(
  "the owned runtime closes stranded prompt cards on %s",
  async (scenario) => {
    const f = fixture();
    const write = Promise.withResolvers<void>();
    const renew = Promise.withResolvers<void>();
    const turnId = f.appServer.turn(3);
    const threadId = f.appServer.thread;
    try {
      if (scenario === "lease loss") f.rejectRenewalAfter(renew.promise);
      await f.runtime.processWorkUpdate([item(f.pilotRequest)]);
      await until(
        () => f.events.some(({ kind }) => kind === "turn.started"),
        "resumed turn",
      );
      f.appServer.send({
        frames: ["one", "two"].flatMap((id) => [
          {
            id: `approve-${id}`,
            method: "item/commandExecution/requestApproval",
            params: {
              threadId,
              turnId,
              itemId: `command-${id}`,
              command: "pwd",
            },
          },
          {
            id: `ask-${id}`,
            method: "item/tool/requestUserInput",
            params: {
              threadId,
              turnId,
              itemId: `ask-item-${id}`,
              questions: [question],
            },
          },
        ]),
      });
      await until(
        () => f.promptPermissions.size === 2 && f.promptMessages.length === 2,
        "publish every open card",
      );

      if (scenario === "close") {
        f.pauseQuestionWrite(write.promise);
        f.appServer.send({
          frames: [
            {
              id: "ask-late",
              method: "item/tool/requestUserInput",
              params: {
                threadId,
                turnId,
                itemId: "ask-item-late",
                questions: [question],
              },
            },
          ],
        });
        await until(
          () => f.promptMessages.length === 3,
          "question publication starts",
        );
        const closing = f.pilot.close();
        expect(
          await waitFor(() => f.actions.includes("edge:release"), 300, 5),
        ).toBe(false);
        write.resolve();
        await closing;
      } else if (scenario === "lease loss") {
        renew.resolve();
        await until(
          () => f.actions.includes("edge:release"),
          "lease is released after stale renewal",
        );
      } else if (scenario === "restart") {
        f.rejectPromptCleanup(true);
        await f.restart(undefined, () => {
          expect(f.promptPermissions.size).toBe(2);
          expect(f.promptMessages).toHaveLength(2);
          f.rejectPromptCleanup(false);
        });
      } else {
        f.rejectPromptCleanup(true);
        await f.pilot.close();
        expect(f.actions).toContain("edge:release");
        expect(
          f.logs.some((message) =>
            message.includes("prompt card cleanup failed"),
          ),
        ).toBe(true);
        return;
      }

      const questionIds =
        scenario === "close" ? ["one", "two", "late"] : ["one", "two"];
      expect(f.promptPermissions.size).toBe(0);
      expect(f.cancelledPermissions.sort()).toEqual([
        "row-1:app-server:string:approve-one",
        "row-1:app-server:string:approve-two",
      ]);
      expect(
        f.promptMessages
          .flatMap(({ toolResults }) => toolResults ?? [])
          .sort((a, b) => a.toolUseId.localeCompare(b.toolUseId)),
      ).toEqual(
        questionIds.sort().map((id) => ({
          toolUseId: `1:app-server:string:ask-${id}`,
          content: "Codex question cancelled",
        })),
      );
    } finally {
      write.resolve();
      renew.resolve();
      await f.dispose();
    }
  },
);
