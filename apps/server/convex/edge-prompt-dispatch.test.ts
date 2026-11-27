import { expect, test } from "bun:test";
import {
  edgePromptFixture,
  installEdgePromptTestClock,
} from "../test-helpers/edge-prompt.testkit";
import { api } from "./_generated/api";

installEdgePromptTestClock();

test("web dispatch queues an exact answer while a legacy permission denial leaves the fenced card open", async () => {
  const f = await edgePromptFixture("permission");
  const legacy = await f.browser.mutation(
    api.permissions.createPermissionRequest,
    {
      conversation_id: f.conversation,
      session_id: "runtime",
      tool_name: "read",
      arguments_preview: "read notes",
    },
  );
  const fenced = await f.browser.mutation(
    api.permissions.createPermissionRequest,
    {
      conversation_id: f.conversation,
      session_id: "runtime",
      tool_name: "read",
      arguments_preview: "other notes",
      fenced_prompt_id: f.target.prompt_id,
      fenced_prompt_turn_id: f.target.turn_id,
    },
  );
  const legacyAnswer = await f.browser.mutation(
    api.permissions.updatePermissionStatus,
    {
      permission_id: legacy,
      status: "denied",
      message: "Deny the old request",
    },
  );
  expect(legacyAnswer).toBe(legacy);
  expect(await f.rows()).toEqual([]);
  const pending = await f.browser.query(api.permissions.getPendingPermissions, {
    conversation_id: f.conversation,
  });
  expect(pending.map(({ _id }) => _id)).toEqual([fenced]);
  const answer = { behavior: "deny" } as const;
  const action = {
    action: "answerFencedPrompt",
    args: ["web-row", { ...f.address, answer }],
  };
  await f.browser.mutation(api.dispatch.dispatch, action);
  expect(await f.rows()).toMatchObject([
    { ...f.address, actor_user_id: f.owner, answer },
  ]);
  await expect(
    f.browser.mutation(api.dispatch.dispatch, action),
  ).rejects.toThrow("This prompt already has an answer.");
});
