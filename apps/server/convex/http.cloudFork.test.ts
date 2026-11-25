import { expect, test } from "bun:test";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import { hashToken } from "./apiTokens";
import schema from "./schema";
import { allModules } from "./testModules.testkit";

const token = "fork-test-token";
const worktree = {
  name: "cloud-fork",
  branch: "work/cloud-fork",
  path: "/cloud/worktrees/fork",
};
const cloudSeed = { source: "checkout" as const, base: "f00baa1", dirty: true };
const deviceId = "cloud-host";

async function fixture() {
  const t = convexTest(schema, allModules);
  const parentId = await t.run(async ({ db }) => {
    const userId = await db.insert("users", { name: "Fork owner" });
    const now = Date.now();
    await db.insert("api_tokens", {
      user_id: userId,
      token_hash: await hashToken(token),
      name: "cli",
      created_at: now,
      last_used_at: now,
    });
    await db.insert("devices", {
      user_id: userId,
      device_id: deviceId,
      label: "Cloud host",
      platform: "linux",
      is_remote: true,
      last_seen: now,
    });
    await db.insert("devices", {
      user_id: userId,
      device_id: "laptop",
      label: "Laptop",
      platform: "darwin",
      last_seen: now,
      local_project_roots: ["/local/parent"],
    });
    return db.insert("conversations", {
      user_id: userId,
      session_id: "parent",
      agent_type: "claude_code",
      project_path: "/local/parent",
      worktree_name: "parent",
      worktree_path: "/local/parent",
      owner_device_id: "laptop",
      started_at: now,
      updated_at: now,
      message_count: 0,
      is_private: true,
      status: "active",
    });
  });
  return {
    t,
    args: {
      api_token: token,
      conversation_id: String(parentId),
      cloud_device_id: deviceId,
      cloud_project_path: worktree.path,
      cloud_worktree: worktree,
      cloud_seed: cloudSeed,
    },
  };
}

test("the CLI fork route places the fork and queues its resume on the cloud host", async () => {
  const { t, args } = await fixture();
  const response = await t.fetch("/cli/fork", {
    method: "POST",
    body: JSON.stringify(args),
  });
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  const { row, commands } = await t.run(async ({ db }) => ({
    row: await db.get("conversations", body.conversation_id),
    commands: await db.query("daemon_commands").collect(),
  }));
  expect(row).toMatchObject({
    owner_device_id: deviceId,
    project_path: worktree.path,
    worktree_name: worktree.name,
    worktree_branch: worktree.branch,
    worktree_path: worktree.path,
    cloud_seed: cloudSeed,
  });
  const command = commands.find((row) => row.command === "resume_session");
  expect(command?.target_device_id).toBe(deviceId);
  expect(JSON.parse(command!.args)).toMatchObject({
    conversation_id: body.conversation_id,
    project_path: worktree.path,
  });
});

test("a cloud fork has its own isolated worktree stamped with the seed and fork time", async () => {
  const { t, args } = await fixture();
  const result = await t.mutation(api.conversations.forkFromMessage, args);
  const row = await t.run(({ db }) => db.get(result.conversation_id));
  expect(row).toMatchObject({
    cloud_workspace: "isolated",
    worktree_path: worktree.path,
    worktree_status: "active",
    cloud_seed: { ...cloudSeed, at: row!.started_at },
  });
});

test("a local fork has no cloud workspace and no cloud seed", async () => {
  const { t, args } = await fixture();
  const result = await t.mutation(api.conversations.forkFromMessage, {
    api_token: args.api_token,
    conversation_id: args.conversation_id,
  });
  const row = await t.run(({ db }) => db.get(result.conversation_id));
  expect(row).not.toBeNull();
  expect(row).not.toHaveProperty("cloud_workspace");
  expect(row).not.toHaveProperty("cloud_seed");
});
