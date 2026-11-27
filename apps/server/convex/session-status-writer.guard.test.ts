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

function patchKeys(payload: ts.Expression): string[] {
  if (
    ts.isParenthesizedExpression(payload) ||
    ts.isAsExpression(payload) ||
    ts.isSatisfiesExpression(payload)
  )
    return patchKeys(payload.expression);
  if (ts.isConditionalExpression(payload))
    return [...patchKeys(payload.whenTrue), ...patchKeys(payload.whenFalse)];
  if (!ts.isObjectLiteralExpression(payload))
    return [`dynamic(${payload.getText()})`];
  return payload.properties.flatMap((property) => {
    if (ts.isSpreadAssignment(property)) return patchKeys(property.expression);
    const name = property.name;
    if (name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)))
      return [name.text];
    if (name && ts.isComputedPropertyName(name))
      return [
        ts.isStringLiteralLike(name.expression)
          ? name.expression.text
          : `dynamic(${name.getText()})`,
      ];
    return [];
  });
}

function patchScope(node: ts.Node): string {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionDeclaration(parent) && parent.name)
      return parent.name.text;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name))
      return parent.name.text;
  }
  return "";
}

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
      if (payload) {
        const matched = [...new Set(patchKeys(payload))].filter(
          (name) => name.startsWith("dynamic(") || fields.test(name),
        );
        if (matched.length)
          sites.push(
            `${file} ${patchScope(node)} ${node.arguments[0].getText(source)}: ${matched.sort().join(", ")}`,
          );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

test("moved pending status patches go through the status writer", () => {
  const fields = /^(?:status|delivered_at|delivery_status)$/;
  const files = [
    "managedSessions.ts",
    "pendingMessageWrites.ts",
    "pendingMessages.ts",
    "orgRoles.ts",
  ];
  expect(files.flatMap((file) => directPatches(file, fields)).sort()).toEqual([
    "managedSessions.ts performRegisterManagedSession existing._id: dynamic(backendPatch(args)), dynamic(lease)",
    "managedSessions.ts performRegisterManagedSession id: dynamic(lease)",
    "orgRoles.ts applyProjectLead project._id: dynamic(patch)",
    "orgRoles.ts performBackfillSeatedHeads standing._id: dynamic(seatTitlePatch(standing, role.name))",
    "orgRoles.ts performPauseRoleCore role._id: status",
    "orgRoles.ts performProvisionRoleCore role._id: dynamic(patch)",
    "orgRoles.ts performRestartRole retiring._id: status",
    "orgRoles.ts performResumeRoleCore role._id: status",
    "orgRoles.ts performRetireRoleCore role._id: status",
    "orgRoles.ts setRoleSwitch role._id: dynamic([field])",
    "orgRoles.ts updateRole role._id: dynamic(patch)",
  ]);
});

test("moved inbox placement and thread pin patches go through the status writer", () => {
  const fields =
    /^(?:inbox_(?:closed_at|stash_hidden|dismissed_at|stashed_at|pinned_at|adopted_at|snoozed_until|deferred_at|killed_at)|thread_state(?:_\w+)?)$/;
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
  expect(files.flatMap((file) => directPatches(file, fields)).sort()).toEqual([
    "agentTasks.ts matchTaskTriggers task._id: dynamic(patch)",
    "anchors.ts provisionStandingAgent args.role!.adopt._id: dynamic(seat), dynamic(seatTitlePatch(args.role!.adopt, name))",
    "anchors.ts provisionStandingAgent conversationId: dynamic(markers)",
    'anchors.ts updateAnchor anchor.bot_user_id as Id<"users">: dynamic(botPatch)',
    "anchors.ts updateAnchor args.anchor_id: dynamic(patch)",
    "conversations.ts backfillNavPromptsPage m._id: dynamic(nav)",
    "conversations.ts createConversation existing._id: dynamic(patch)",
    'conversations.ts makeForkCtx id as Id<"conversations">: dynamic(patch)',
    "conversations.ts reconfigureSessionDefinition args.conversation_id: dynamic(patch)",
    "conversations.ts setConversationIcon args.conversation_id: dynamic(patch)",
    "conversations.ts setSessionError convId: dynamic(safetyPatch)",
    "conversations.ts switchSessionAgent conv._id: dynamic(patch)",
    "conversations.ts updateGitState convId: dynamic(next)",
    "conversations.ts updateProjectPath conversation._id: dynamic(patch)",
    "conversations.ts updateSessionId args.conversation_id: dynamic(patch)",
    "dispatch.ts SIDE_EFFECTS doc._id: dynamic(updates)",
    "dispatch.ts applyPatches documentId: dynamic(finalSafe)",
    "dispatch.ts applyPatches existing._id: dynamic(merged)",
    "inboxFilters.ts bringNestedThreadToInbox conv._id: inbox_adopted_at",
    "lib/agentTaskRows.ts patchTask task._id: dynamic(patch)",
    "migrations.ts canonicalizeRepositoryNames row._id: dynamic([field])",
    "sessionGoals.ts performGoalControl goal._id: dynamic(GOAL_RESUME_RESET)",
  ]);
});
