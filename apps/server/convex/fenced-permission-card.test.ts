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
