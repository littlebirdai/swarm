export const HOME_SCOPE_FIELDS: ReadonlySet<string> = new Set([
  "user_id",
  "team_id",
  "workspace",
  "project_id",
  "created_from_conversation",
  "created_from_conversation_id",
  "conversation_id",
  "conversation_ids",
  "related_conversation_ids",
  "first_linked_conversation",
]);

const DERIVED_HOME_TABLES: ReadonlySet<string> = new Set([
  "tasks",
  "docs",
  "plans",
]);

export function cargoDerivesHomeScope(
  entityType: string,
  patch: Record<string, unknown>,
  unset: readonly string[] = [],
): boolean {
  if (!DERIVED_HOME_TABLES.has(entityType)) return false;
  if (typeof patch.workspace !== "string" || patch.workspace.length === 0)
    return false;
  return !unset.some(
    (k) => k === "home_scope" || k === "channel_id" || HOME_SCOPE_FIELDS.has(k),
  );
}

export function derivedHomeScope(patch: Record<string, any>): string | null {
  const ws = patch.workspace;
  if (typeof ws !== "string") return null;
  if (ws.startsWith("user:")) return ws;
  if (ws.startsWith("team:"))
    return patch.project_id
      ? `project:${String(patch.project_id)}`
      : `dir:${ws.slice(5)}`;
  return null;
}

export function stripRedundantHomeScope(
  entityType: string,
  patch: Record<string, any>,
  unset: readonly string[] = [],
): Record<string, any> {
  if (typeof patch.home_scope !== "string") return patch;
  if (!cargoDerivesHomeScope(entityType, patch, unset)) return patch;
  if (patch.home_scope !== derivedHomeScope(patch)) return patch;
  const rest = { ...patch };
  delete rest.home_scope;
  return rest;
}
