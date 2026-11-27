import { expect, test } from "bun:test";
import { asUser } from "../test-helpers/database.testkit";
import { setupRunLease } from "../test-helpers/run-lease.testkit";
import { api } from "./_generated/api";

test("permission cards keep the provider prompt and turn without deduplicating different prompts", async () => {
  const fixture = await setupRunLease();
  const browser = asUser(fixture.t, fixture.owner);
  const base = {
    conversation_id: fixture.conversation,
    session_id: "thread",
    tool_name: "item/commandExecution/requestApproval",
    arguments_preview: "pwd",
    fenced_prompt_id: "first",
    fenced_prompt_turn_id: "turn",
  };
  const create = api.permissions.createPermissionRequest;
  const first = await browser.mutation(create, base);
  expect(await browser.mutation(create, base)).toBe(first);
  const second = await browser.mutation(create, {
    ...base,
    fenced_prompt_id: "second",
  });
  expect(second).not.toBe(first);
  const third = await browser.mutation(create, {
    ...base,
    fenced_prompt_turn_id: "later-turn",
  });
  expect(third).not.toBe(first);

  const rows = await browser.query(api.permissions.getPendingPermissions, {
    conversation_id: fixture.conversation,
  });
  expect(rows.find(({ _id }) => _id === first)).toMatchObject({
    fenced_prompt_id: "first",
    fenced_prompt_turn_id: "turn",
  });
  expect(rows).toHaveLength(3);
});

test("the daemon can recover only open fenced cards from its own conversation", async () => {
  const fixture = await setupRunLease();
  const browser = asUser(fixture.t, fixture.owner);
  const base = {
    conversation_id: fixture.conversation,
    session_id: "thread",
    tool_name: "item/commandExecution/requestApproval",
    arguments_preview: "pwd",
  };
  const create = api.permissions.createPermissionRequest;
  await browser.mutation(create, base);
  const permission = await browser.mutation(create, {
    ...base,
    fenced_prompt_id: "1:app-server:string:approve",
    fenced_prompt_turn_id: "turn",
  });
  const cancelled = await browser.mutation(create, {
    ...base,
    fenced_prompt_id: "1:app-server:string:cancelled",
    fenced_prompt_turn_id: "turn",
  });
  await browser.mutation(api.permissions.cancelPermissionRequest, {
    permission_id: cancelled,
  });

  await fixture.t.run(async ({ db }) => {
    for (const suffix of ["open", "closed", "legacy"]) {
      const id = `1:app-server:string:${suffix}`;
      const uuid = suffix === "legacy" ? "legacy" : `owned-prompt:1:turn:${id}`;
      await db.insert("messages", {
        conversation_id: fixture.conversation,
        message_uuid: uuid,
        role: "assistant",
        timestamp: 1,
        tool_calls: [
          {
            id,
            name: "AskUserQuestion",
            input: JSON.stringify({ fencedTurnId: "turn" }),
          },
        ],
      });
      if (suffix === "closed")
        await db.insert("messages", {
          conversation_id: fixture.conversation,
          message_uuid: `${uuid}-closed`,
          role: "user",
          timestamp: 2,
        });
    }
  });

  const query = api.permissions.listOwnedPromptCards;
  const args = {
    conversation_id: fixture.conversation,
    paginationOpts: { cursor: null, numItems: 64 },
  };
  await expect(
    fixture.t.query(query, { ...args, api_token: fixture.wrongUser }),
  ).rejects.toThrow("Fenced prompt cards are unavailable");
  const result = await fixture.t.query(query, {
    ...args,
    api_token: fixture.bearer,
  });
  expect(result.page).toEqual([
    {
      kind: "permission",
      id: "1:app-server:string:approve",
      turn: "turn",
      rowId: permission,
    },
    {
      kind: "question",
      id: "1:app-server:string:open",
      turn: "turn",
      messageUuid: "owned-prompt:1:turn:1:app-server:string:open",
    },
  ]);
  expect(result.isDone).toBe(true);
});
