import { expect, test } from "bun:test";
import { getFunctionName, type FunctionReference } from "convex/server";
import { dispatch } from "./dispatch";
import { makeFakeDb } from "./testDb";

test("dispatch forwards the composer observation to the receipt-backed send", async () => {
  const calls: unknown[] = [];
  const ctx = {
    auth: { getUserIdentity: async () => ({ subject: "users_owner|session" }) },
    db: makeFakeDb({}),
    async runMutation(fn: FunctionReference<"mutation">, args: unknown) {
      calls.push([getFunctionName(fn), args]);
      return { status: "acknowledged" };
    },
  };
  const observed_turn = { id: "turn", run: 4, start_event_seq: 19 };
  await (dispatch as any)._handler(ctx, {
    action: "sendMessage",
    args: ["conversations_1", "hello", null, "command", null, "hello"],
    result: {
      receiptActionVersion: 1,
      commandId: "command",
      localResult: { observed_turn },
    },
  });
  expect(calls).toEqual([
    [
      "pendingMessages:sendMessageV2",
      {
        command_id: "command",
        client_id: "command",
        conversation_id: "conversations_1",
        content: "hello",
        typed: "hello",
        observed_turn,
      },
    ],
  ]);
});
