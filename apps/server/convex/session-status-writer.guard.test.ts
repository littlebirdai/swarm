import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const allowed: Record<string, string> = {
  "anchors.ts": "session projection",
  "assistant/turns.ts": "hosted registry report arguments",
  "chat.ts": "chat message replies",
  "chatSessionReplies.ts": "chat message replies",
  "cliSessionClassifier.ts": "session projection",
  "comments.ts": "comment replies",
  "conversations.ts": "session projections",
  "daemonLogs.ts": "user heartbeat projection",
  "debugTmp.ts": "session debug projection",
  "decisionThread.ts": "decision thread replies",
  "decisionThreadBackfill.ts": "decision thread replies",
  "lib/closeAside.ts": "session classification",
  "lib/conversationCommentRows.ts": "comment reply projection",
  "lib/sessionHeartbeat.ts": "session heartbeat reads and maintenance",
  "lib/sessionStatusWriter.ts": "session status writes",
  "managedSessions.ts": "wire shapes and registration heartbeats",
  "managedSessionsList.ts": "session projection",
  "pendingMessages.ts": "session readiness classification",
  "plans.ts": "session projection",
  "schema/accounts.tables.ts": "user heartbeat field",
  "schema/chat.tables.ts": "chat reply status field",
  "schema/conversations.tables.ts": "session status fields",
  "schema/managed-sessions.tables.ts": "session registry and heartbeat fields",
  "schema/messages.tables.ts": "comment reply status field",
  "schema/pull-requests.tables.ts": "pull request comment and snapshot fields",
  "schema/tasks.tables.ts": "task heartbeat field",
  "sessionMigrations.ts": "session migration projections",
  "slackSchema.ts": "Slack sync heartbeat field",
  "slackSync.ts": "Slack sync heartbeat writes",
  "tasks.ts": "task heartbeat writes and session projections",
  "treeSnapshots.ts": "snapshot turn identity",
  "users.ts": "user heartbeat writes and projections",
};

const fields =
  "(?:agent_status(?:_updated_at|_write_at|_boundary|_probe)?|turn_completed_at|hosted_stop|hibernated_at|last_heartbeat|heartbeat_at)";
const bracket = `\\[\\s*["'\`]${fields}["'\`]\\s*\\]`;
const keyOrAssignment = new RegExp(
  `(?<![\\w$.])(?:\\b${fields}\\b|["']${fields}["']|${bracket})\\s*:|(?:\\.\\s*${fields}\\b|${bracket})\\s*=(?!=|>)`,
);

test("distinctive session status fields stay in known files", () => {
  const unexpected: string[] = [];
  for (const file of new Bun.Glob("**/*.ts").scanSync(import.meta.dir)) {
    if (
      file.startsWith("_generated/") ||
      /\.(test|testkit|d)\.ts$/.test(file) ||
      Object.hasOwn(allowed, file)
    )
      continue;
    const source = readFileSync(join(import.meta.dir, file), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\/|(?:^|\s)\/\/.*$/gm, "");
    if (keyOrAssignment.test(code)) unexpected.push(file);
  }
  expect(unexpected.sort()).toEqual([]);
});

function directPatches(file: string, fields: RegExp) {
  const source = ts.createSourceFile(
    file,
    readFileSync(join(import.meta.dir, file), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const sites: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "patch" &&
      ts.isPropertyAccessExpression(node.expression.expression) &&
      node.expression.expression.name.text === "db"
    ) {
      const payload = node.arguments.at(-1);
      const keys =
        payload && ts.isObjectLiteralExpression(payload)
          ? payload.properties.map((property) =>
              ts.isSpreadAssignment(property)
                ? property.expression.getText(source)
                : property.name && ts.isStringLiteral(property.name)
                  ? property.name.text
                  : (property.name?.getText(source) ?? ""),
            )
          : [payload?.getText(source) ?? ""];
      const matched = keys.filter((name) => fields.test(name));
      if (matched.length)
        sites.push(
          `${node.arguments[0].getText(source)}: ${matched.sort().join(", ")}`,
        );
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites.sort();
}

test("moved pending status patches go through the status writer", () => {
  const fields = /^(?:status|delivered_at|delivery_status)$/;
  expect(directPatches("managedSessions.ts", fields)).toEqual([]);
  expect(directPatches("pendingMessageWrites.ts", fields)).toEqual([]);
  expect(directPatches("pendingMessages.ts", fields)).toEqual([]);
  expect(directPatches("orgRoles.ts", fields)).toEqual([
    "retiring._id: status",
    "role._id: status",
    "role._id: status",
    "role._id: status",
  ]);
});

test("moved inbox placement and thread pin patches go through the status writer", () => {
  const fields =
    /^(?:inbox_(?:dismissed_at|stashed_at|pinned_at|adopted_at|snoozed_until|deferred_at|killed_at)|thread_state(?:_\w+)?|clearedThreadStateFields\(\))$/;
  const files = [
    "agentTasks.ts",
    "anchors.ts",
    "conversations.ts",
    "daemonCommandUtils.ts",
    "debugTmp.ts",
    "dispatch.ts",
    "favoriteViewWrites.ts",
    "inboxFilters.ts",
    "lib/agentTaskRows.ts",
    "lib/orgSessionFiling.ts",
    "migrations.ts",
    "sessionGoals.ts",
    "sessionOwnership.ts",
  ];
  const remaining = files.flatMap((file) =>
    directPatches(file, fields).map((patch) => `${file} ${patch}`),
  );
  expect(remaining).toEqual(["inboxFilters.ts conv._id: inbox_adopted_at"]);
});
