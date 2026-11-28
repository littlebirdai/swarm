export type ScopeScopedCollection = "tasks" | "docs" | "plans" | "chatMessages";

const KNOWN_HOME_SCOPE_PREFIXES = [
  "user:",
  "dir:",
  "project:",
  "channel:",
] as const;

export function isKnownHomeScope(scope: string): boolean {
  return KNOWN_HOME_SCOPE_PREFIXES.some(
    (prefix) => scope.startsWith(prefix) && scope.length > prefix.length,
  );
}

export function rowHomeScope(
  collection: ScopeScopedCollection,
  row: any,
): string | null {
  if (!row) return null;
  if (typeof row.home_scope === "string" && row.home_scope.length > 0) {
    return isKnownHomeScope(row.home_scope) ? row.home_scope : null;
  }
  if (collection === "chatMessages") {
    return row.channel_id ? `channel:${String(row.channel_id)}` : null;
  }
  if (typeof row.workspace === "string" && row.workspace.length > 0) {
    if (row.workspace.startsWith("user:")) return row.workspace;
    if (row.workspace.startsWith("team:")) {
      return row.project_id
        ? `project:${String(row.project_id)}`
        : `dir:${row.workspace.slice(5)}`;
    }
    return null;
  }
  if (row.user_id && !row.team_id) {
    return `user:${String(row.user_id)}`;
  }
  return null;
}

function rowTeamId(row: any): string | null {
  const ws = row?.workspace;
  if (typeof ws === "string")
    return ws.startsWith("team:") ? ws.slice(5) : null;
  return row?.team_id ? String(row.team_id) : null;
}

export function revokedScopeOfRow(
  collection: string,
  row: any,
  revokedScopes: ReadonlySet<string>,
): string | null {
  const team = rowTeamId(row);
  if (team && revokedScopes.has(`dir:${team}`)) return `dir:${team}`;
  const homeCollection = collection === "docDetails" ? "docs" : collection;
  if (homeCollection === "projects") return null;
  const home = rowHomeScope(homeCollection as ScopeScopedCollection, row);
  return home && revokedScopes.has(home) ? home : null;
}

export function revokesTaskThreads(
  revokedScopes: ReadonlySet<string>,
): string | null {
  for (const scope of revokedScopes)
    if (scope.startsWith("dir:") || scope.startsWith("project:")) return scope;
  return null;
}

export function revokedScopeOfThread(
  parent: unknown,
  revokedScopes: ReadonlySet<string>,
): string | null {
  return parent
    ? revokedScopeOfRow("tasks", parent, revokedScopes)
    : revokesTaskThreads(revokedScopes);
}
