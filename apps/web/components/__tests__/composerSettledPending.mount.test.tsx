import { expect, test } from "bun:test";
import { api } from "@codecast/convex/convex/_generated/api";
import { mountWeb } from "../../test-helpers/mountWeb";
import { pending } from "../../test-helpers/testConvex";
import { testToasts } from "../../test-helpers/testToasts";
import { MessageInput } from "../message-input";

const conversationId = "jx70000000000000000000000settled";

async function composerStatusFor(
  status: "pending" | "delivered" | "cancelled",
) {
  const { backend, clock, container } = await mountWeb(
    <MessageInput
      conversationId={conversationId}
      status="active"
      sessionId="sess_settled"
      agentType="claude_code"
      agentStatus="idle"
      isSessionReady
    />,
    {
      clock: true,
      dispatch: true,
      setup: (backend, store) => {
        store.syncTable("pendingMessageStatus", [
          {
            _id: conversationId,
            conversation_id: conversationId,
            message_id: "pm_settled_1",
            client_id: "c1",
            created_at: Date.now() - 3 * 60_000,
            retry_count: 0,
            status,
            content: "hi",
          },
        ]);
        backend.mutation(api.dispatch.dispatch, null);
        backend.set(api.pendingMessages.getConversationPendingMessage, pending);
        backend.set(api.pendingMessages.getMessageStatus, pending);
        backend.set(api.sessionCommands.forConversation, pending);
      },
    },
  );
  await clock!.advance(320);
  const text =
    container.querySelector("[data-cc-composer-meta]")?.textContent ?? "";
  const commands = backend.mutations.flatMap(({ args }) =>
    args &&
    typeof args === "object" &&
    "action" in args &&
    args.action === "convCommand" &&
    Array.isArray(args.args)
      ? [args.args]
      : [],
  );
  return { text, commands };
}

test("an in-flight row past the threshold raises the stuck banner and resumes", async () => {
  const notices = testToasts();
  const { text, commands } = await composerStatusFor("pending");
  expect(text).toContain("Cancel");
  expect(commands).toEqual([[conversationId, "resumeSession"]]);
  expect(notices.events().filter(({ kind }) => kind === "error")).toEqual([]);
});

for (const status of ["delivered", "cancelled"] as const) {
  test(`a ${status} row is not a stuck message`, async () => {
    const { text, commands } = await composerStatusFor(status);
    expect(text).not.toContain("Disconnected");
    expect(text).not.toContain("Cancel");
    expect(text).toContain("Ready");
    expect(commands).toEqual([]);
  });
}
