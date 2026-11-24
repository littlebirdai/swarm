// The server half of the Codex account registry (ct-49528): the daemon records
// which account each pane launched on.
import { describe, expect, test } from "bun:test";
import { recordCodexAccount } from "./accountSwitch";
import { makeFakeDb } from "./testDb";

function fixture() {
  const tables: Record<string, any[]> = {
    conversations: [],
  };
  const db = makeFakeDb(tables);
  const ctx = {
    db,
    auth: {
      async getUserIdentity() {
        return { subject: "users_owner|session" };
      },
    },
  };

  const conversation = (id: string, extra: Record<string, any> = {}) =>
    tables.conversations.push({
      _id: id,
      user_id: "users_owner",
      session_id: `session-${id}`,
      agent_type: "codex",
      owner_device_id: "mac",
      title: `title ${id}`,
      ...extra,
    });

  return { tables, db, ctx, conversation };
}

const record = (ctx: any, args: any) =>
  (recordCodexAccount as any)._handler(ctx, args);

describe("recordCodexAccount", () => {
  test("stamps the account the launching daemon reported", async () => {
    const f = fixture();
    f.conversation("conversations_a");
    expect(
      await record(f.ctx, {
        conversation_id: "conversations_a",
        codex_account: "ashot",
      }),
    ).toEqual({
      codex_account: "ashot",
    });
    expect(f.tables.conversations[0].codex_account).toBe("ashot");
  });

  test("clears the record when the daemon could not name the account", async () => {
    const f = fixture();
    f.conversation("conversations_a", { codex_account: "ashot" });
    expect(await record(f.ctx, { conversation_id: "conversations_a" })).toEqual(
      { codex_account: null },
    );
    expect(f.tables.conversations[0].codex_account).toBeUndefined();
  });

  test("writes nothing when the row already says so", async () => {
    const f = fixture();
    f.conversation("conversations_a", { codex_account: "ashot" });
    await record(f.ctx, {
      conversation_id: "conversations_a",
      codex_account: "ashot",
    });
    expect((f.db as any)._patched).toEqual([]);
  });

  test("refuses a conversation that is not the caller's", async () => {
    const f = fixture();
    f.conversation("conversations_a", { user_id: "users_someone_else" });
    expect(
      await record(f.ctx, {
        conversation_id: "conversations_a",
        codex_account: "ashot",
      }),
    ).toBeNull();
    expect(f.tables.conversations[0].codex_account).toBeUndefined();
  });
});
