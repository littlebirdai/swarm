import { expect, test } from "bun:test";
import type { TranscriptUplinkClient } from "@codecast/edge-client";
import { SyncService } from "./syncService";

const input = {
  conversationId: "conversation",
  messages: [
    {
      messageUuid: "message",
      role: "assistant" as const,
      content: "hello",
      timestamp: 10,
    },
  ],
};

test("an uplink receipt accepts the transcript write and a refusal leaves it pending", async () => {
  const sync = new SyncService({ convexUrl: "http://localhost:0" });
  const accepted: number[][] = [];
  const options = {
    onBatchAccepted: (indexes: readonly number[]) =>
      accepted.push([...indexes]),
  };
  let respond!: (
    value: Awaited<ReturnType<TranscriptUplinkClient["submit"]>>,
  ) => void;
  let seen!: () => void;
  const submitted = new Promise<void>((resolve) => {
    seen = resolve;
  });
  sync.setTranscriptUplink({
    submit: (write) => {
      expect(write.conversation_id).toBe(input.conversationId);
      expect(write.messages[0]).toMatchObject({
        message_uuid: "message",
        role: "assistant",
        content: "hello",
      });
      seen();
      return new Promise((resolve) => {
        respond = resolve;
      });
    },
  });
  const pending = sync.addMessages(input, options);
  await submitted;
  expect(accepted).toEqual([]);
  respond({ status: "applied", inserted: 1, ids: ["server-message"] });
  expect(await pending).toEqual({ inserted: 1, ids: ["server-message"] });

  sync.setTranscriptUplink({
    submit: async () => ({ status: "refused" }),
  });
  await expect(sync.addMessages(input, options)).rejects.toThrow(
    "Transcript write refused",
  );
  expect(accepted).toEqual([[0]]);
});
