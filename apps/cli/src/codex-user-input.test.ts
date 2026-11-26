import { expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  codexPromptHandlers,
  deliverCodexPromptAnswer,
} from "./codex-prompt-cards.js";
import { releasePromptHold } from "./pendingPromptHold.js";
import type { SyncService } from "./syncService.js";
import { strictStub } from "./test-helpers/strictStub.js";
import { CodexAppServer } from "./codex-app-server.js";
import { pollUntil } from "./test-helpers/pollUntil.js";

test("sends question card choices by Codex question ID and cancels an unanswered card", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-question-"));
  const executable = join(directory, "codex");
  const fake = resolve(
    import.meta.dir,
    "../../../packages/provider-adapter/test/fake-app-server.ts",
  );
  writeFileSync(
    executable,
    `#!/bin/sh\nexec "${process.execPath}" "${fake}" "${directory}"\n`,
    { mode: 0o700 },
  );
  const cards: unknown[] = [];
  const closed: string[] = [];
  const delivered: string[] = [];
  const service = strictStub<SyncService>("prompt sync", {
    addMessages: async ({ messages }) => {
      cards.push(...messages.map(({ toolCalls }) => toolCalls?.[0]));
      return { inserted: messages.length, ids: [] };
    },
    updateMessageStatus: async ({ messageId }) => {
      delivered.push(messageId);
    },
  });
  const { onUserInput } = codexPromptHandlers(
    service,
    (threadId) =>
      threadId === "thread" ? { conversationId: "conversation" } : undefined,
    () => {},
    () => {},
    (_thread, conversation, _id, resolution) => {
      releasePromptHold(conversation);
      closed.push(resolution);
    },
  );
  const client = new CodexAppServer({
    log: () => {},
    codexBinary: executable,
    onApproval: async () => false,
    onUserInput,
  });
  const questions = [
    {
      id: "review-size",
      question: "How much detail?",
      header: "Detail",
      options: [{ label: "Short" }, { label: "Long" }],
    },
    {
      id: "include-summary",
      question: "Add a summary?",
      header: "Summary",
      options: [{ label: "Yes" }],
    },
  ];
  try {
    client.start();
    await pollUntil(() => client.running, "Codex client ready");
    for (const [id, answer, expected] of [
      [
        "answered",
        { keys: ["2", "1", "Enter"], display: "Long, Yes" },
        {
          "review-size": { answers: ["Long"] },
          "include-summary": { answers: ["Yes"] },
        },
      ],
      [
        "typed",
        { text: "Detail: Include examples\n\nSummary: Yes" },
        {
          "review-size": { answers: ["Include examples"] },
          "include-summary": { answers: ["Yes"] },
        },
      ],
      ["dismissed", { keys: ["Escape"] }, {}],
      ["cancelled", null, {}],
    ] as const) {
      const command = join(directory, "next");
      writeFileSync(
        command,
        JSON.stringify({
          frame: {
            id,
            method: "item/tool/requestUserInput",
            params: {
              threadId: answer ? "thread" : "missing",
              turnId: "turn",
              itemId: "item",
              questions,
            },
          },
        }),
      );
      renameSync(command, join(directory, `${id}.command`));
      if (answer) {
        await pollUntil(
          () => cards.length > delivered.length,
          `Card is published for ${id}`,
        );
        expect(cards.at(-1)).toMatchObject({
          name: "AskUserQuestion",
          input: {
            questions: [
              { question: "How much detail?" },
              { question: "Add a summary?" },
            ],
          },
        });
        expect(
          await deliverCodexPromptAnswer(
            "thread",
            JSON.stringify({ __cc_poll: true, ...answer }),
            id,
            async () => {},
            service,
          ),
        ).toBe("handled");
      }
      let result: unknown;
      await pollUntil(() => {
        try {
          for (const line of readFileSync(join(directory, "effects"), "utf8")
            .trim()
            .split("\n")) {
            const { action, message } = JSON.parse(line);
            if (action === "answer" && message.id === id)
              result = message.result;
          }
        } catch {}
        return result !== undefined;
      }, `Codex receives reply for ${id}`);
      expect(result).toEqual({ answers: expected });
    }
    expect(delivered).toEqual(["answered", "typed", "dismissed"]);
    expect(closed.at(-1)).toBe("Codex question cancelled");
  } finally {
    client.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
