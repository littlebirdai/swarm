import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaimGrant } from "@codecast/edge-client";
import { createProviderAdapter } from "@codecast/provider-adapter";
import type { OwnedSession } from "@codecast/provider-contract";
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

const claim: ClaimGrant = {
  v: 1,
  status: "granted",
  session: "conversation",
  run: 1,
  fencing_token: "granted-fence",
  lease_ms: 30_000,
  last_pane_instance: 0,
};
const previewToken = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";
const assignmentSecret = "quotedSecret70123456789";
const jsonSecret = "nestedApiKey90123456789";

test("owned Codex publishes legacy-shaped prompt cards and closes them on provider settlement", async () => {
  const directory = mkdtempSync(join(tmpdir(), "owned-codex-cards-"));
  const app = fake(directory, "cards");
  const cards = new CodexPilotPromptCards();
  const adapter = createProviderAdapter({
    provider: { agent: "codex", version: "0.153.4" },
    command: [app.executable],
    retainRaw: (frame) => cards.retain(frame),
  });
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
            input: { api_key: jsonSecret },
            command: `export API_SECRET="${assignmentSecret}" && echo ${previewToken}`,
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
    expect(permissions[0]?.arguments_preview).not.toContain(previewToken);
    expect(permissions[0]?.arguments_preview).not.toContain(assignmentSecret);
    expect(permissions[0]?.arguments_preview).not.toContain(jsonSecret);
    expect(permissions[0]?.arguments_preview).toContain(
      '"api_key":"[redacted:secret-assignment]"',
    );
    expect(permissions[0]).toMatchObject({
      conversation_id: claim.session,
      session_id: app.thread,
      fenced_prompt_id: address("approve").prompt_id,
      fenced_prompt_turn_id: turnId,
      tool_name: "item/commandExecution/requestApproval",
      arguments_preview: expect.stringContaining(
        JSON.stringify(
          'export API_SECRET="[redacted:secret-assignment]"',
        ).slice(0, -1),
      ),
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

test("redacts the permission summary when the raw approval is unavailable", async () => {
  const previews: string[] = [];
  const sync = strictStub<SyncService>("publisher", {
    async createPermissionRequest(request) {
      previews.push(request.arguments_preview);
      return "permission-row";
    },
  });
  await new CodexPilotPromptCards().publish(
    {
      v: 1,
      session: claim.session,
      run: claim.run,
      seq: 1,
      at: 1,
      source: "provider",
      turn: "turn",
      kind: "prompt.opened",
      body: {
        prompt_id: "permission",
        kind: "permission",
        summary: `Approve command using ${previewToken}`,
      },
    },
    claim,
    strictStub<OwnedSession>("provider", { getCheckpoint: () => "thread" }),
    sync,
    () => {},
  );
  expect(previews).toEqual(["Approve command using [redacted:github-token]"]);
});

test("restart closes stranded cards and restores held prompts with their answers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "owned-codex-mixed-cards-"));
  const app = fake(directory, "mixed-cards");
  const cards = new CodexPilotPromptCards();
  const adapter = createProviderAdapter({
    provider: { agent: "codex", version: "0.153.4" },
    command: [app.executable],
    retainRaw: (frame) => cards.retain(frame),
  });
  const turn = app.turn(3);
  const address = (id: string) => `1:app-server:string:${id}`;
  const stored = ["held", "stranded"].flatMap((state) => {
    const questionId = address(`${state}-question`);
    return [
      {
        kind: "permission",
        id: address(`${state}-approval`),
        turn,
        rowId: `${state}-row`,
      },
      {
        kind: "question",
        id: questionId,
        turn,
        messageUuid: `owned-prompt:1:${turn}:${questionId}`,
      },
    ];
  });
  const messages: Parameters<SyncService["addMessages"]>[0]["messages"] = [];
  const closedPermissions: string[] = [];
  const states: string[] = [];
  const sync = strictStub<SyncService>("previous process cards", {
    getClient() {
      return strictStub<ReturnType<SyncService["getClient"]>>("stored cards", {
        async query() {
          return { page: stored, isDone: true, continueCursor: "" } as never;
        },
      });
    },
    async cancelPermissionRequest(rowId) {
      closedPermissions.push(rowId);
      return true;
    },
    async addMessages({ conversationId, messages: batch }) {
      expect(conversationId).toBe(claim.session);
      messages.push(...batch);
      return { inserted: batch.length, ids: [] };
    },
  });
  let writer: Promise<void> | undefined;
  try {
    const opened = await adapter.resume({
      ...claim,
      cwd: directory,
      checkpoint: app.thread,
      afterSeq: 4,
    });
    if (opened.status !== "opened") throw new Error(JSON.stringify(opened));
    const session = opened.session;
    const pendingPrompts = session.getPendingPrompts;
    if (!pendingPrompts) throw new Error("Expected pending Codex prompts");
    const params = { threadId: app.thread, turnId: turn };
    app.send({
      frames: [
        {
          id: "held-approval",
          method: "item/commandExecution/requestApproval",
          params: { ...params, itemId: "held-command", command: "pwd" },
        },
        {
          id: "held-question",
          method: "item/tool/requestUserInput",
          params: { ...params, itemId: "held-item", questions: [question] },
        },
      ],
    });
    await until(
      () => pendingPrompts().length === 2,
      "the resumed adapter holds the two live prompts",
    );
    await cards.recover(
      claim.session,
      "fixture-bearer",
      sync,
      pendingPrompts,
      new AbortController().signal,
    );
    expect(closedPermissions).toEqual(["stranded-row"]);
    expect(messages.map(({ toolResults }) => toolResults)).toEqual([
      [
        {
          toolUseId: address("stranded-question"),
          content: "Codex question cancelled",
        },
      ],
    ]);

    let replayedQuestion = false;
    writer = (async () => {
      for await (const event of session.events) {
        if (event.kind === "message.delta") continue;
        if (event.kind === "turn.started") states.push("working");
        await cards.publish(event, claim, session, sync, () =>
          states.push(
            event.kind === "prompt.opened"
              ? "permission_blocked"
              : "question_blocked",
          ),
        );
        if (event.kind === "context") replayedQuestion = true;
      }
    })();
    await until(
      () => replayedQuestion,
      "the live question context is replayed",
    );
    expect(states).toEqual([
      "working",
      "permission_blocked",
      "question_blocked",
    ]);
    expect(messages).toHaveLength(1);
    expect(closedPermissions).toEqual(["stranded-row"]);

    await session.answer({
      expected: {
        run: claim.run,
        fencing_token: claim.fencing_token,
        prompt_id: address("held-question"),
      },
      by: { kind: "person", id: "owner" },
      answer: { answers: { [question.id]: { answers: ["Short"] } } },
    });
    await until(
      () => messages.length === 2,
      "the real answer settles the held question",
    );
    expect(messages[1]?.toolResults).toEqual([
      {
        toolUseId: address("held-question"),
        content: "Answered from the app: Short",
      },
    ]);
    expect(closedPermissions).toEqual(["stranded-row"]);
    expect(pendingPrompts().map(({ id }) => id)).toEqual([
      address("held-approval"),
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
      const promptId = f.promptMessages[0]?.toolCalls?.[0]?.id;
      if (!promptId) throw new Error("Expected the published question ID");
      expect(promptId).toMatch(/^1:app-server:[a-f0-9-]+:string:open$/);
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
          toolUseId: promptId,
          content: "Codex question cancelled",
        },
      ]);
    } finally {
      await f.dispose();
    }
  },
);

test("a question reissued after recovery with the same RPC id gets a live card", async () => {
  const f = fixture();
  const turnId = f.appServer.turn(3);
  const threadId = f.appServer.thread;
  const frames = [
    {
      id: 0,
      method: "item/tool/requestUserInput",
      params: { threadId, turnId, itemId: "ask-item", questions: [question] },
    },
  ];
  try {
    await f.runtime.processWorkUpdate([item(f.pilotRequest)]);
    f.appServer.send({ frames });
    await until(() => f.promptMessages.length === 1, "publish the old card");
    const previous = f.promptMessages[0]!;
    f.rejectPromptCleanup(true);
    await f.restart(undefined, () => f.rejectPromptCleanup(false));
    expect(f.promptMessages[1]?.messageUuid).toBe(
      `${previous.messageUuid}-closed`,
    );

    f.appServer.send({ frames });
    await until(() => f.promptMessages.length === 3, "publish the live card");
    const live = f.promptMessages[2]!;
    const newPrompt = live.toolCalls?.[0]?.id;
    if (!newPrompt) throw new Error("Expected the reissued question ID");
    expect(live.messageUuid).not.toBe(previous.messageUuid);
    expect(newPrompt).toMatch(/^1:app-server:[a-f0-9-]+:number:0$/);
    expect(newPrompt).not.toBe(previous.toolCalls?.[0]?.id);
    expect(
      f.promptMessages.some(
        ({ messageUuid }) => messageUuid === `${live.messageUuid}-closed`,
      ),
    ).toBe(false);

    f.appServer.send({
      frames: [
        {
          method: "serverRequest/resolved",
          params: { threadId, requestId: 0 },
        },
      ],
    });
    await until(() => f.promptMessages.length === 4, "settle the live card");
    expect(f.promptMessages[3]).toMatchObject({
      messageUuid: `${live.messageUuid}-closed`,
      toolResults: [
        { toolUseId: newPrompt, content: "Codex question cancelled" },
      ],
    });
  } finally {
    await f.dispose();
  }
});

test("turn end closes the question when cancelling the permission fails", async () => {
  const f = fixture();
  const turnId = f.appServer.turn(3);
  const threadId = f.appServer.thread;
  try {
    await f.runtime.processWorkUpdate([item(f.pilotRequest)]);
    f.appServer.send({
      frames: [
        {
          id: "approve",
          method: "item/commandExecution/requestApproval",
          params: { threadId, turnId, itemId: "command", command: "pwd" },
        },
        {
          id: "ask",
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
      () => f.promptPermissions.size === 1 && f.promptMessages.length === 1,
      "publish both cards",
    );
    const promptId = f.promptMessages[0]?.toolCalls?.[0]?.id;
    if (!promptId) throw new Error("Expected the published question ID");
    f.rejectPermissionCleanup([...f.promptPermissions.keys()][0]!);
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
      () => f.logs.some((line) => line.includes("Prompt sync failed")),
      "report the failed permission cancellation",
    );
    expect(f.promptPermissions.size).toBe(1);
    expect(f.promptMessages[1]?.toolResults).toEqual([
      {
        toolUseId: promptId,
        content: "Codex question cancelled",
      },
    ]);
  } finally {
    await f.dispose();
  }
});

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
      const permissionIds = [...f.promptPermissions.keys()].sort();

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

      const questionIds = f.promptMessages.flatMap(({ toolCalls }) =>
        (toolCalls ?? []).map(({ id }) => id),
      );
      expect(questionIds).toHaveLength(scenario === "close" ? 3 : 2);
      expect(f.promptPermissions.size).toBe(0);
      expect(f.cancelledPermissions.sort()).toEqual(permissionIds);
      expect(
        f.promptMessages
          .flatMap(({ toolResults }) => toolResults ?? [])
          .sort((a, b) => a.toolUseId.localeCompare(b.toolUseId)),
      ).toEqual(
        questionIds.sort().map((id) => ({
          toolUseId: id,
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
