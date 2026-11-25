import { expect, test } from "bun:test";
import { join } from "node:path";
import ts from "typescript";
import { DISPATCHABLE_CONVERSATION_FIELDS } from "@codecast/sessions/conversationFields";

const fields: Record<string, readonly string[]> = {
  managed_sessions: [
    "status",
    "agent_status",
    "agent_status_updated_at",
    "agent_status_write_at",
    "agent_status_boundary",
    "turn_completed_at",
    "hibernated_at",
  ],
  conversations: [
    "status",
    "agent_status_probe",
    "hosted_stop",
    "thread_state",
    "thread_state_at",
    "thread_state_msg_count",
    "thread_state_status",
    "thread_state_result",
    "thread_state_result_at",
  ],
  assistant_turns: ["status"],
};

const statusFields = new Set(Object.values(fields).flat());
const allowed: Record<string, string[]> = {
  "anchors.ts": ['insertStandingConversation insert("conversations") status'],
  "assistant/turns.ts": [
    "endTurn patch(turn._id) status",
    'leaseTurn insert("assistant_turns") status',
    'leaseTurn insert("assistant_turns") status',
    "leaseTurn patch(conversationId) hosted_stop",
    "leaseTurn patch(turnId) status",
    "settleParked patch(input.waiting._id) status",
    "tellStopped patch(turn.conversation_id) hosted_stop",
  ],
  "conversations.ts": [
    'createConversation insert("conversations") status',
    "createConversation patch(parentConversationId) status",
    'forkConversation insert("conversations") status',
    'forkFromMessage insert("conversations") status',
    'insertStartedConversation insert("conversations") status',
    "killConversation patch(args.conversation_id) status",
    "markSessionActive patch(convId) status",
    "markSessionCompleted patch(convId) status",
    "performSetThreadState patch(conv._id) thread_state,thread_state_at,thread_state_msg_count,thread_state_result,thread_state_result_at,thread_state_status",
    'resolveRestartTarget insert("conversations") status',
    "resolveRestartTarget patch(conv._id) status",
    "resolveRestartTarget patch(twin._id) status",
    "setThreadState patch(conv._id) thread_state,thread_state_at,thread_state_msg_count,thread_state_result,thread_state_result_at,thread_state_status",
  ],
  "devices.ts": [
    "performMoveSessionToDevice patch(args.conversation_id) status",
    "performReassignToDevice patch(args.conversation_id) status",
    "performReparentSessionToDevice patch(conv._id) status",
  ],
  "dispatch.ts": [
    "applyPatches favoritePatch(doc as any) thread_state,thread_state_at,thread_state_msg_count,thread_state_status",
    "applyPatches patch(documentId) thread_state,thread_state_at,thread_state_msg_count,thread_state_status",
    'createSession insert("conversations") status',
  ],
  "executionBindings.ts": [
    "abandonAmbiguousAndResendInDb patch(fence.conversationId) status",
  ],
  "favoriteViewWrites.ts": [
    "patchConversationThroughFavoriteView patch(conversation._id) agent_status_probe,hosted_stop,status,thread_state,thread_state_at,thread_state_msg_count,thread_state_result,thread_state_result_at,thread_state_status",
  ],
  "managedSessions.ts": [
    "applyAgentStatus patch(session._id) agent_status,agent_status_boundary,agent_status_updated_at,agent_status_write_at,hibernated_at,turn_completed_at",
    "applyHeartbeat patch(session._id) agent_status,agent_status_boundary,agent_status_updated_at,agent_status_write_at",
    'ensureHostedManagedSession insert("managed_sessions") agent_status,agent_status_updated_at',
  ],
  "messages.ts": [
    "addMessage patch(session._id) agent_status,agent_status_updated_at",
    "projectAgentStatusOnAddMessages patch(session._id) agent_status,agent_status_updated_at",
    "writeMessageBatch patch(args.conversation_id) agent_status_probe",
  ],
  "pendingMessageWrites.ts": [
    "reviveConversationOnDelivery patch(conversationId) status",
  ],
  "pendingMessages.ts": [
    "enqueuePendingMessage patch(conversation._id) status,thread_state,thread_state_at,thread_state_msg_count,thread_state_status",
  ],
  "sessionGoals.ts": [
    "takeDownGoalPin patch(conv._id) thread_state,thread_state_at,thread_state_msg_count,thread_state_result,thread_state_result_at,thread_state_status",
  ],
  "spawn.ts": ['spawnSessionCore insert("conversations") status'],
  "tasks.ts": ['spawnSessionForTask insert("conversations") status'],
  "users.ts": ['startSession insert("conversations") status'],
  "workflow_runs.ts": [
    'create insert("conversations") status',
    'createRunCore insert("conversations") status',
    "updateProgress patch(run.primary_conversation_id) status",
  ],
};

const nonSessionWrites = new Set([
  "anchors.ts:provisionStandingAgent patch(anchorId) status",
  "orgRoles.ts:performResumeRoleCore patch(role._id) status",
]);

function nameOf(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
  if (ts.isComputedPropertyName(node)) return nameOf(node.expression);
}

function unwrap(node: ts.Expression): ts.Expression {
  while (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isParenthesizedExpression(node)
  ) {
    node = node.expression;
  }
  return node;
}

function member(node: ts.Node) {
  if (ts.isPropertyAccessExpression(node))
    return { object: node.expression, name: node.name.text };
  if (
    ts.isElementAccessExpression(node) &&
    ts.isStringLiteralLike(node.argumentExpression)
  )
    return { object: node.expression, name: node.argumentExpression.text };
}

function visit(node: ts.Node, fn: (node: ts.Node) => void) {
  fn(node);
  ts.forEachChild(node, (child) => visit(child, fn));
}

function writerOf(node: ts.Node): string {
  for (let owner = node.parent; owner; owner = owner.parent) {
    if (
      ts.isFunctionDeclaration(owner) ||
      ts.isMethodDeclaration(owner) ||
      ts.isPropertyAssignment(owner) ||
      (ts.isVariableDeclaration(owner) &&
        ts.isSourceFile(owner.parent.parent.parent))
    ) {
      const name = nameOf(owner.name);
      if (name && name !== "handler") return name;
    }
  }
  return "<module>";
}

function fieldReads(checker: ts.TypeChecker, node: ts.Expression) {
  const type = checker.getTypeAtLocation(node);
  return type.getProperties().map((prop) => prop.name);
}

function payloadFields(
  checker: ts.TypeChecker,
  assigned: ReadonlyMap<ts.Symbol, Set<string>>,
  expression: ts.Expression,
  seen = new Set<ts.Node>(),
): string[] {
  const node = unwrap(expression);
  if (seen.has(node)) return [];
  seen.add(node);
  const keysOf = (item: ts.Expression) =>
    payloadFields(checker, assigned, item, seen);
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.flatMap((prop) => {
      if (ts.isSpreadAssignment(prop)) return keysOf(prop.expression);
      return nameOf(prop.name) ?? [];
    });
  }
  if (ts.isConditionalExpression(node))
    return [...keysOf(node.whenTrue), ...keysOf(node.whenFalse)];
  if (ts.isIdentifier(node)) {
    const symbol = checker.getSymbolAtLocation(node);
    const decl = symbol?.valueDeclaration;
    if (symbol && decl && ts.isVariableDeclaration(decl) && decl.initializer)
      return [...(assigned.get(symbol) ?? []), ...keysOf(decl.initializer)];
  }
  if (ts.isCallExpression(node)) {
    if (node.expression.getText() === "Object.assign")
      return node.arguments.flatMap(keysOf);
    const declared = checker.getResolvedSignature(node)?.declaration;
    if (
      declared &&
      ts.isFunctionDeclaration(declared) &&
      declared.body &&
      declared.getSourceFile().fileName.startsWith(import.meta.dir + "/")
    ) {
      const returned: string[] = [];
      const readReturns = (child: ts.Node) => {
        if (ts.isFunctionLike(child)) return;
        if (ts.isReturnStatement(child) && child.expression) {
          returned.push(...keysOf(child.expression));
          return;
        }
        ts.forEachChild(child, readReturns);
      };
      readReturns(declared.body);
      return returned;
    }
  }
  if (ts.isAwaitExpression(node)) return keysOf(node.expression);
  return fieldReads(checker, expression);
}

function tableOf(checker: ts.TypeChecker, target: ts.Expression) {
  if (ts.isStringLiteralLike(target)) return target.text;
  const type = checker.getTypeAtLocation(target);
  const brand = type.getProperty("__tableName");
  if (brand) {
    const name = checker.getTypeOfSymbolAtLocation(brand, target);
    if (name.isStringLiteral()) return name.value;
  }
}

function writeKey(
  file: string,
  checker: ts.TypeChecker,
  assigned: ReadonlyMap<ts.Symbol, Set<string>>,
  call: ts.CallExpression,
): string | undefined {
  const method = member(call.expression);
  const forwardsPatch =
    nameOf(call.expression) === "patchConversationThroughFavoriteView";
  if (
    !forwardsPatch &&
    (!method || !["insert", "patch", "replace"].includes(method.name))
  )
    return;
  if (method && !/\b(\w*[dD]b|database)\b/.test(method.object.getText()))
    return;
  const operation = method?.name ?? "favoritePatch";
  const [target, value, explicitValue] = forwardsPatch
    ? call.arguments.slice(1)
    : call.arguments;
  if (!target || !value) return;
  const table = forwardsPatch ? "conversations" : tableOf(checker, target);
  if (table && !fields[table]) return;
  const payload = !forwardsPatch && explicitValue ? explicitValue : value;
  const writer = writerOf(call);
  const keys =
    file === "dispatch.ts" &&
    writer === "applyPatches" &&
    nameOf(unwrap(payload)) === "finalSafe"
      ? dispatchFields(call.getSourceFile())
      : payloadFields(checker, assigned, payload);
  const protectedKeys = table ? fields[table] : [...statusFields];
  const matches = protectedKeys.filter((field) => keys.includes(field));
  if (!table && matches.includes("status")) {
    const ownerText = call.getText();
    if (
      !/\b(conv\w*|parentConversationId|turn\w*|session\w*)\b/i.test(
        target.getText(),
      ) &&
      !keys.includes("inbox_killed_at") &&
      !/\bstatus\s*:\s*["'](?:active|completed)["']/.test(ownerText)
    ) {
      matches.splice(matches.indexOf("status"), 1);
    }
  }
  if (!matches.length && !(table && operation === "replace")) return;
  const key = `${writer} ${operation}(${target.getText()}) ${matches.sort().join(",")}`;
  if (!nonSessionWrites.has(`${file}:${key}`)) return key;
}

function dispatchFields(source: ts.SourceFile): readonly string[] {
  const config = source.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => [...statement.declarationList.declarations])
    .find((decl) => nameOf(decl.name) === "TABLE_CONFIG")?.initializer;
  const property = (object: ts.Expression | undefined, name: string) =>
    object && ts.isObjectLiteralExpression(object)
      ? object.properties
          .filter(ts.isPropertyAssignment)
          .find((prop) => nameOf(prop.name) === name)?.initializer
      : undefined;
  const editable = property(property(config, "conversations"), "editable");
  const entries =
    editable && ts.isNewExpression(editable)
      ? editable.arguments?.[0]
      : undefined;
  if (!entries || !ts.isArrayLiteralExpression(entries))
    throw new Error("Cannot read dispatch conversation fields");
  return entries.elements.flatMap((entry) => {
    if (ts.isStringLiteral(entry)) return [entry.text];
    if (
      ts.isSpreadElement(entry) &&
      nameOf(entry.expression) === "DISPATCHABLE_CONVERSATION_FIELDS"
    )
      return [...DISPATCHABLE_CONVERSATION_FIELDS];
    throw new Error(`Unknown dispatch conversation field: ${entry.getText()}`);
  });
}

function statusWriters(): Record<string, string[]> {
  const root = import.meta.dir;
  const paths = [...new Bun.Glob("**/*.ts").scanSync(root)]
    .filter(
      (file) =>
        !file.startsWith("_generated/") &&
        !/\.(test|testkit|d)\.ts$/.test(file),
    )
    .sort();
  const config = ts.readConfigFile(
    join(root, "tsconfig.json"),
    ts.sys.readFile,
  );
  const { options } = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    root,
  );
  const program = ts.createProgram(
    paths.map((file) => join(root, file)),
    options,
  );
  const checker = program.getTypeChecker();
  const found: Record<string, string[]> = {};
  const assignments = new Map<ts.Symbol, Set<string>>();
  const sources = paths.map((file) => {
    const source = program.getSourceFile(join(root, file));
    if (!source) throw new Error(`Cannot read ${file}`);
    return { file, source };
  });
  for (const { source } of sources) {
    visit(source, (node) => {
      if (
        !ts.isBinaryExpression(node) ||
        node.operatorToken.kind !== ts.SyntaxKind.EqualsToken
      )
        return;
      const field = member(node.left);
      if (!field || !statusFields.has(field.name)) return;
      const symbol = checker.getSymbolAtLocation(unwrap(field.object));
      if (!symbol) return;
      const keys = assignments.get(symbol) ?? new Set<string>();
      keys.add(field.name);
      assignments.set(symbol, keys);
    });
  }
  for (const { file, source } of sources) {
    if (file === "lib/sessionStatusWriter.ts") continue;
    const writes: string[] = [];
    visit(source, (node) => {
      if (!ts.isCallExpression(node)) return;
      const key = writeKey(file, checker, assignments, node);
      if (key) writes.push(key);
    });
    if (writes.length) found[file] = writes.sort();
  }
  return found;
}

test("only the named legacy writers write session status outside the status module", () => {
  expect(statusWriters()).toEqual(allowed);
}, 30_000);
