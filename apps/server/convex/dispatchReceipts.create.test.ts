import { describe, expect, test } from "bun:test";
import { dispatch } from "./dispatch";
import { makeFakeDb } from "./testDb";

describe("receipt-backed create into a team", () => {
  const run = async (memberships: unknown[]) => {
    const userId = "users_owner";
    const db = makeFakeDb({
      local_command_receipts: [],
      local_view_heads: [],
      team_memberships: memberships,
    });
    let creates = 0;
    const ctx = {
      auth: {
        getUserIdentity: async () => ({ subject: `${userId}|session` }),
      },
      db,
      runMutation: async () => {
        creates++;
        return { id: "docs_created" };
      },
    };
    const receipt = await (dispatch as any)._handler(ctx, {
      action: "createDoc",
      args: [{ title: "Team doc", workspace: "team", team_id: "teams_gone" }],
      result: { receiptActionVersion: 1, commandId: "create-team-doc" },
    });
    return { receipt, creates, db };
  };

  test("a person who left the team gets a terminal rejected receipt", async () => {
    const { receipt, creates, db } = await run([]);
    expect(creates).toBe(0);
    expect(receipt).toMatchObject({
      status: "rejected",
      rejection: { code: "WORKSPACE_ACCESS_DENIED" },
    });
    expect(db._tables.local_command_receipts).toHaveLength(1);
  });

  test("a member creates the doc", async () => {
    const { receipt, creates } = await run([
      { _id: "m1", user_id: "users_owner", team_id: "teams_gone" },
    ]);
    expect(creates).toBe(1);
    expect(receipt).toMatchObject({ status: "acknowledged" });
  });
});
