import { describe, expect, test } from "bun:test";
import { actedBlockedConversations } from "./ccAccountsShared";
import { internal } from "./_generated/api";
import { getFunctionName } from "convex/server";
import { insertSwitchCommands, onFreshApiErrorPark } from "./accountSwitch";
import { makeFakeDb } from "./testDb";

const safety = {
  _id: "conversations_safety",
  user_id: "users_owner",
  agent_type: "codex",
  pending_api_error: true,
  pending_api_error_kind: "safety",
  owner_device_id: "mac",
};

describe("safety blockers in fleet recovery", () => {
  test("bulk selection excludes safety stops, including explicitly included workers", () => {
    const recoverable = {
      ...safety,
      _id: "conversations_limit",
      agent_type: "claude_code",
      pending_api_error_kind: "limit",
    };
    const child = { ...safety, _id: "conversations_child", is_subagent: true };
    expect(
      actedBlockedConversations([safety, recoverable, child], false),
    ).toEqual([recoverable]);
    expect(
      actedBlockedConversations([safety, recoverable, child], true),
    ).toEqual([recoverable]);
  });

  test("a safety park schedules a warning without scheduling account-switch or retry work", async () => {
    const scheduled: unknown[] = [];
    await onFreshApiErrorPark(
      {
        scheduler: {
          runAfter: async (_ms, fn) => {
            scheduled.push(getFunctionName(fn));
          },
        },
      },
      "users_owner" as any,
      "safety",
    );
    expect(scheduled).toEqual([
      getFunctionName(internal.accountSwitch.blockedNotifyCheck),
    ]);
  });

  test.each([undefined, "another-account"])(
    "the execution boundary refuses safety revival with account=%s",
    async (profile) => {
      const now = Date.now();
      const device = {
        _id: "devices_mac",
        device_id: "mac",
        user_id: "users_owner",
        last_seen: now,
        cc_accounts: {
          profiles: [{ name: "another-account", email: "other@example.com" }],
        },
      };
      const db = makeFakeDb({
        conversations: [safety],
        devices: [device],
        pending_messages: [],
        daemon_commands: [],
      });
      const result = await insertSwitchCommands({ db }, "users_owner" as any, {
        blocked: [safety] as any,
        primary: device as any,
        online: [device] as any,
        continueBlocked: true,
        profile,
        now,
      });
      expect(result.routed).toBe(0);
      expect(result.messaged).toBe(0);
      expect(result.restarted).toBe(0);
      expect(db._inserted).toEqual([]);
    },
  );
});
