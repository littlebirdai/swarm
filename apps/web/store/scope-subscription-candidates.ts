import { leavesOf } from "./stageSplit";

export const SCOPE_FOLLOW_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export type ScopeFollowCandidate = {
  scope: string;
  at?: number;
};

export type ScopeCandidates = {
  principalId: string | null;
  pinned: string[];
  membership: string[];
  follows: ScopeFollowCandidate[];
  view: string[];
};

export type ScopeScopedCollection = "tasks" | "docs" | "plans" | "chatMessages";

export type PurgeTarget = {
  collection: ScopeScopedCollection;
  id: string;
  scope: string;
};

export type ScopeStoreInput = {
  currentUser?: { _id?: unknown } | null;
  teams?: Array<{ _id?: unknown }>;
  projects?: Record<string, any>;
  viewerRoles?: Record<string, any>;
  chatChannels?: Record<string, any>;
  chatReads?: Record<string, any>;
  chatRail?: Array<any>;
  clientState?: {
    ui?: {
      sidebar_pins?: Array<{ kind?: string; id?: string }>;
    };
  };
  recentVisits?: Array<{
    kind?: string;
    key?: string;
    path?: string;
    ts?: number;
  }>;
  tabs?: Array<{ id?: string; path?: string | null; layout?: any }>;
  activeTabId?: string | null;
  tasks?: Record<string, any>;
  docs?: Record<string, any>;
  docDetails?: Record<string, any>;
  plans?: Record<string, any>;
};

const SCOPE_SCOPED_COLLECTIONS: readonly ScopeScopedCollection[] = [
  "tasks",
  "docs",
  "plans",
  "chatMessages",
];

function isStubId(id: string): boolean {
  return (
    !id ||
    id.startsWith("team-stub-") ||
    id.startsWith("chatstub-") ||
    id.startsWith("projstub-") ||
    id.startsWith("temp_")
  );
}

function resolveProjectId(
  projects: Record<string, any> | undefined,
  ref: string,
): string | null {
  if (!ref || isStubId(ref)) return null;
  if (projects?.[ref]) return String(projects[ref]._id ?? ref);
  if (projects) {
    for (const id in projects) {
      const row = projects[id];
      if (!row) continue;
      if (row._id === ref || row.short_id === ref) {
        return String(row._id ?? id);
      }
    }
  }
  return ref;
}

function matchRouteParam(path: string, segment: string): string | null {
  const clean = path.split(/[?#]/)[0];
  const prefix = `/${segment}/`;
  if (!clean.startsWith(prefix)) return null;
  const rest = clean.slice(prefix.length);
  const slash = rest.indexOf("/");
  const param = slash === -1 ? rest : rest.slice(0, slash);
  return param ? decodeURIComponent(param) : null;
}

function visitPath(visit: {
  kind?: string;
  key?: string;
  path?: string;
}): string | null {
  if (typeof visit.path === "string" && visit.path.startsWith("/")) {
    return visit.path;
  }
  if (visit.kind === "page" && typeof visit.key === "string") {
    return visit.key.startsWith("page:") ? visit.key.slice(5) : visit.key;
  }
  return null;
}

function activeTabPaths(state: ScopeStoreInput): string[] {
  const tabs = state.tabs;
  if (!Array.isArray(tabs) || !state.activeTabId) return [];
  const tab = tabs.find((t) => t?.id === state.activeTabId);
  if (!tab) return [];
  if (tab.layout) {
    return leavesOf(tab.layout)
      .map((leaf) => leaf.path)
      .filter((p): p is string => typeof p === "string" && p.length > 0);
  }
  return typeof tab.path === "string" && tab.path.length > 0 ? [tab.path] : [];
}

function findEntityRow(
  primary: Record<string, any> | undefined,
  ref: string,
  secondary?: Record<string, any>,
): any | null {
  for (const map of [secondary, primary]) {
    if (!map) continue;
    if (map[ref]) return map[ref];
    for (const id in map) {
      const row = map[id];
      if (row && (row._id === ref || row.short_id === ref)) return row;
    }
  }
  return null;
}

export function rowHomeScope(
  collection: ScopeScopedCollection,
  row: any,
): string | null {
  if (!row) return null;
  if (typeof row.home_scope === "string" && row.home_scope.length > 0) {
    return row.home_scope;
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
  }
  if (row.user_id && !row.team_id) {
    return `user:${String(row.user_id)}`;
  }
  if (row.team_id) {
    return row.project_id
      ? `project:${String(row.project_id)}`
      : `dir:${String(row.team_id)}`;
  }
  return null;
}

export function extractScopeCandidates(
  state: ScopeStoreInput,
  now: number,
  opts?: { activePaths?: string[] },
): ScopeCandidates {
  const userId = state.currentUser?._id ? String(state.currentUser._id) : null;
  if (!userId) {
    return {
      principalId: null,
      pinned: [],
      membership: [],
      follows: [],
      view: [],
    };
  }

  const pinnedSet = new Set<string>([`user:${userId}`]);
  for (const team of state.teams ?? []) {
    const teamId = team?._id ? String(team._id) : "";
    if (teamId && !isStubId(teamId)) pinnedSet.add(`dir:${teamId}`);
  }

  const membershipSet = new Set<string>();
  const myRoleIds = new Set<string>();
  const roles = state.viewerRoles;
  if (roles) {
    for (const id in roles) {
      const role = roles[id];
      if (!role || String(role.host_user_id) !== userId) continue;
      if (role.status === "retired") continue;
      myRoleIds.add(String(role._id ?? id));
      for (const pid of role.scope?.project_ids ?? []) {
        const resolved = resolveProjectId(state.projects, String(pid));
        if (resolved) membershipSet.add(`project:${resolved}`);
      }
    }
  }
  const projects = state.projects;
  if (projects) {
    for (const id in projects) {
      const proj = projects[id];
      if (!proj || isStubId(id)) continue;
      const pid = String(proj._id ?? id);
      if (isStubId(pid)) continue;
      if (
        String(proj.user_id) === userId ||
        (proj.owner_role_id && myRoleIds.has(String(proj.owner_role_id)))
      ) {
        membershipSet.add(`project:${pid}`);
      }
    }
  }

  const readByChannel = new Map<string, any>();
  const chatReads = state.chatReads;
  if (chatReads) {
    for (const id in chatReads) {
      const read = chatReads[id];
      if (!read?.channel_id) continue;
      const cid = String(read.channel_id);
      const prev = readByChannel.get(cid);
      if (!prev || (prev.updated_at ?? 0) <= (read.updated_at ?? 0)) {
        readByChannel.set(cid, read);
      }
    }
  }
  const railByChannel = new Map<string, any>();
  for (const row of state.chatRail ?? []) {
    if (row?.channel_id) railByChannel.set(String(row.channel_id), row);
  }
  const channelIds = new Set<string>();
  const chatChannels = state.chatChannels;
  if (chatChannels) {
    for (const id in chatChannels) channelIds.add(id);
  }
  for (const cid of railByChannel.keys()) channelIds.add(cid);
  for (const cid of channelIds) {
    if (isStubId(cid)) continue;
    const ch = chatChannels?.[cid];
    if (ch?.archived_at) continue;
    const read = readByChannel.get(cid);
    const rail = railByChannel.get(cid);
    const joined = !!read || !!rail?.joined;
    if (!joined) continue;
    const notifyLevel = read?.notify_level ?? rail?.notify_level ?? "mentions";
    if (notifyLevel === "none") continue;
    membershipSet.add(`channel:${cid}`);
  }

  const followsMap = new Map<string, number | undefined>();
  const addFollow = (scope: string, at?: number) => {
    const prev = followsMap.get(scope);
    if (at === undefined) {
      if (!followsMap.has(scope)) followsMap.set(scope, undefined);
      return;
    }
    followsMap.set(scope, prev === undefined ? at : Math.max(prev, at));
  };

  for (const pin of state.clientState?.ui?.sidebar_pins ?? []) {
    if (pin?.kind === "project" && typeof pin.id === "string") {
      const pid = resolveProjectId(projects, pin.id);
      if (pid) addFollow(`project:${pid}`);
    }
  }
  if (projects) {
    for (const id in projects) {
      const proj = projects[id];
      if (!proj || isStubId(id)) continue;
      if (proj.starred === true || proj.is_favorite === true) {
        addFollow(`project:${String(proj._id ?? id)}`);
      }
    }
  }
  for (const visit of state.recentVisits ?? []) {
    if (!visit || typeof visit.ts !== "number") continue;
    if (now - visit.ts > SCOPE_FOLLOW_WINDOW_MS) continue;
    if (visit.kind === "view" && visit.key?.startsWith("pj:")) {
      const pid = resolveProjectId(projects, visit.key.slice(3));
      if (pid) addFollow(`project:${pid}`, visit.ts);
      continue;
    }
    const path = visitPath(visit);
    if (!path) continue;
    const projRef = matchRouteParam(path, "projects");
    if (projRef) {
      const pid = resolveProjectId(projects, projRef);
      if (pid) addFollow(`project:${pid}`, visit.ts);
    }
  }

  const viewSet = new Set<string>();
  for (const path of opts?.activePaths ?? activeTabPaths(state)) {
    const projRef = matchRouteParam(path, "projects");
    if (projRef) {
      const pid = resolveProjectId(projects, projRef);
      if (pid) viewSet.add(`project:${pid}`);
      continue;
    }
    const chanId = matchRouteParam(path, "chat");
    if (chanId && !isStubId(chanId)) {
      viewSet.add(`channel:${chanId}`);
      continue;
    }
    const taskRef = matchRouteParam(path, "tasks");
    if (taskRef) {
      const row = findEntityRow(state.tasks, taskRef);
      const scope = rowHomeScope("tasks", row);
      if (scope) viewSet.add(scope);
      continue;
    }
    const docRef = matchRouteParam(path, "docs");
    if (docRef) {
      const row = findEntityRow(state.docs, docRef, state.docDetails);
      const scope = rowHomeScope("docs", row);
      if (scope) viewSet.add(scope);
      continue;
    }
    const planRef = matchRouteParam(path, "plans");
    if (planRef) {
      const row = findEntityRow(state.plans, planRef);
      const scope = rowHomeScope("plans", row);
      if (scope) viewSet.add(scope);
    }
  }

  return {
    principalId: userId,
    pinned: [...pinnedSet],
    membership: [...membershipSet],
    follows: [...followsMap.entries()].map(([scope, at]) => ({ scope, at })),
    view: [...viewSet],
  };
}

function hasPendingFieldLock(
  pending: Record<string, any> | undefined,
  collection: ScopeScopedCollection,
  id: string,
): boolean {
  if (!pending) return false;
  const prefix = `${collection}:${id}:`;
  for (const key in pending) {
    if (!key.startsWith(prefix)) continue;
    if (pending[key]?.type === "field") return true;
  }
  return false;
}

export function computePurgeSet(
  collections: Partial<Record<ScopeScopedCollection, Record<string, any>>>,
  heldScopes: ReadonlySet<string>,
  pending?: Record<string, any>,
): PurgeTarget[] {
  const targets: PurgeTarget[] = [];
  for (const collection of SCOPE_SCOPED_COLLECTIONS) {
    const rows = collections[collection];
    if (!rows) continue;
    for (const id in rows) {
      if (isStubId(id)) continue;
      if (hasPendingFieldLock(pending, collection, id)) continue;
      const row = rows[id];
      const scope = rowHomeScope(collection, row);
      if (!scope || heldScopes.has(scope)) continue;
      targets.push({ collection, id, scope });
    }
  }
  return targets;
}

export function purgeUnheldScopeRowsInDraft(
  draft: any,
  heldScopes: ReadonlySet<string>,
  now: number,
): PurgeTarget[] {
  const targets = computePurgeSet(draft, heldScopes, draft.pending);
  for (const { collection, id, scope } of targets) {
    const rows = draft[collection] as Record<string, any> | undefined;
    if (rows && id in rows) delete rows[id];
    draft.pending[`${collection}:${id}`] = {
      type: "exclude",
      ts: now,
      scope,
    };
  }
  return targets;
}
