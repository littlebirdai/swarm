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

export function touchesHomeScope(
  patch: Record<string, unknown>,
  unset: readonly string[] = [],
): boolean {
  return (
    Object.keys(patch).some((k) => HOME_SCOPE_FIELDS.has(k)) ||
    unset.some((k) => HOME_SCOPE_FIELDS.has(k))
  );
}

export function derivedHomeScope(
  entityType: string,
  patch: Record<string, any>,
  accessKey?: string,
): string | null {
  if (entityType === "chat_messages") {
    return patch.channel_id ? `channel:${String(patch.channel_id)}` : null;
  }
  const ws =
    typeof patch.workspace === "string" && patch.workspace.length > 0
      ? patch.workspace
      : accessKey;
  if (typeof ws === "string" && ws.length > 0) {
    if (ws.startsWith("user:")) return ws;
    if (ws.startsWith("team:")) {
      return patch.project_id
        ? `project:${String(patch.project_id)}`
        : `dir:${ws.slice(5)}`;
    }
    return null;
  }
  if (patch.user_id && !patch.team_id) {
    return `user:${String(patch.user_id)}`;
  }
  return null;
}

export function stripRedundantHomeScope(
  entityType: string,
  patch: Record<string, any>,
  accessKey?: string,
  unset: readonly string[] = [],
): Record<string, any> {
  if (typeof patch.home_scope !== "string") return patch;
  if (!touchesHomeScope(patch, unset)) return patch;
  if (patch.home_scope !== derivedHomeScope(entityType, patch, accessKey))
    return patch;
  const rest = { ...patch };
  delete rest.home_scope;
  return rest;
}
