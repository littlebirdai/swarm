import type { CacheEviction } from "./cache-eviction";
import { isDetailPinned } from "../lib/detail-rows";
import { isConvexId } from "../lib/entityLinks";
import { holdsUnsentComment } from "./store-eviction";
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

export type ScopeViewTargetKind =
  | "project"
  | "task"
  | "doc"
  | "plan"
  | "channel";

export type ScopeViewTarget = { kind: ScopeViewTargetKind; id: string };

export const SCOPE_VIEW_TARGET_OWNERS_MAX = 16;

export type PurgeTarget = {
  collection: ScopeScopedCollection | "projects";
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
  scopeViewTargets?: Record<string, ScopeViewTarget[]>;
  tasks?: Record<string, any>;
  docs?: Record<string, any>;
  docDetails?: Record<string, any>;
  taskComments?: Record<string, any>;
  plans?: Record<string, any>;
  pending?: Record<string, any>;
  scopeSubscriptions?: {
    peerViews?: Record<string, string[]>;
  };
  _protectedOutboxRows?: () => ReadonlySet<string>;
};

export type ScopePurgeOptions = {
  pending?: Record<string, any>;
  protectedOutboxRows?: ReadonlySet<string>;
  viewerId?: string | null;
};

const SCOPE_SCOPED_COLLECTIONS: readonly ScopeScopedCollection[] = [
  "tasks",
  "docs",
  "plans",
  "chatMessages",
];

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

const ENTITY_ROW_KEY_CACHE = new WeakMap<object, Map<string, string | null>>();

function lookupEntityInMap(
  map: Record<string, any> | undefined,
  ref: string,
): any | null {
  if (!map || !ref) return null;
  if (map[ref]) return map[ref];
  let cache = ENTITY_ROW_KEY_CACHE.get(map);
  if (!cache) {
    cache = new Map<string, string | null>();
    ENTITY_ROW_KEY_CACHE.set(map, cache);
  }
  const cachedKey = cache.get(ref);
  if (cachedKey !== undefined) {
    if (cachedKey === null) return null;
    const cachedRow = map[cachedKey];
    if (cachedRow && (cachedRow._id === ref || cachedRow.short_id === ref)) {
      return cachedRow;
    }
  }
  for (const id in map) {
    const row = map[id];
    if (!row) continue;
    if (row._id === ref || row.short_id === ref) {
      cache.set(ref, id);
      return row;
    }
  }
  cache.set(ref, null);
  return null;
}

function isStubId(id: string): boolean {
  return (
    !id ||
    id.startsWith("team-stub-") ||
    id.startsWith("chatstub-") ||
    id.startsWith("projstub-") ||
    id.startsWith("temp_")
  );
}

function isPersonalProject(proj: any): boolean {
  if (!proj) return false;
  if (typeof proj.workspace === "string" && proj.workspace.length > 0) {
    return !proj.workspace.startsWith("team:");
  }
  return !proj.team_id;
}

function resolveProjectId(
  projects: Record<string, any> | undefined,
  ref: string,
): string | null {
  if (!ref || isStubId(ref) || !projects) return null;
  const row = lookupEntityInMap(projects, ref);
  if (!row || isPersonalProject(row)) return null;
  return String(row._id ?? ref);
}

function matchRouteParam(path: string, segment: string): string | null {
  const clean = path.split(/[?#]/)[0];
  const prefix = `/${segment}/`;
  if (!clean.startsWith(prefix)) return null;
  const rest = clean.slice(prefix.length);
  const slash = rest.indexOf("/");
  const param = slash === -1 ? rest : rest.slice(0, slash);
  if (!param) return null;
  try {
    return decodeURIComponent(param);
  } catch {
    return null;
  }
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

function tabPathsForTab(
  tab: { path?: string | null; layout?: any } | undefined,
): string[] {
  if (!tab) return [];
  if (tab.layout) {
    return leavesOf(tab.layout)
      .map((leaf) => leaf.path)
      .filter((p): p is string => typeof p === "string" && p.length > 0);
  }
  return typeof tab.path === "string" && tab.path.length > 0 ? [tab.path] : [];
}

export function activeTabPaths(state: ScopeStoreInput): string[] {
  const tabs = state.tabs;
  if (!Array.isArray(tabs) || !state.activeTabId) return [];
  const tab = tabs.find((t) => t?.id === state.activeTabId);
  return tabPathsForTab(tab);
}

const VIEW_TARGET_SEGMENT: Record<ScopeViewTargetKind, string> = {
  project: "projects",
  task: "tasks",
  doc: "docs",
  plan: "plans",
  channel: "chat",
};

export function isScopeViewTargetKind(
  kind: unknown,
): kind is ScopeViewTargetKind {
  return typeof kind === "string" && Object.hasOwn(VIEW_TARGET_SEGMENT, kind);
}

export function viewTargetPaths(state: ScopeStoreInput): string[] {
  const owners = state.scopeViewTargets;
  if (!owners) return [];
  const paths: string[] = [];
  for (const owner in owners) {
    for (const target of owners[owner] ?? []) {
      const segment = target && VIEW_TARGET_SEGMENT[target.kind];
      if (!segment || typeof target.id !== "string" || !target.id) continue;
      paths.push(`/${segment}/${encodeURIComponent(target.id)}`);
    }
  }
  return paths;
}

export function activeViewPaths(state: ScopeStoreInput): string[] {
  return [...activeTabPaths(state), ...viewTargetPaths(state)];
}

export function findEntityRow(
  primary: Record<string, any> | undefined,
  ref: string,
  secondary?: Record<string, any>,
): any | null {
  return (
    lookupEntityInMap(secondary, ref) ?? lookupEntityInMap(primary, ref) ?? null
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

export function extractViewScopes(
  state: ScopeStoreInput,
  paths?: string[],
): string[] {
  const viewSet = new Set<string>();
  const projects = state.projects;
  for (const path of paths ?? activeViewPaths(state)) {
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
  return [...viewSet];
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
      if (!proj || isStubId(id) || isPersonalProject(proj)) continue;
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
      if (!proj || isStubId(id) || isPersonalProject(proj)) continue;
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

  const viewSet = new Set<string>(
    extractViewScopes(
      state,
      opts?.activePaths
        ? [...opts.activePaths, ...viewTargetPaths(state)]
        : undefined,
    ),
  );
  const peerViews = state.scopeSubscriptions?.peerViews;
  if (peerViews) {
    for (const peerId in peerViews) {
      const scopes = peerViews[peerId];
      if (!Array.isArray(scopes)) continue;
      for (const scope of scopes) {
        if (typeof scope === "string" && isKnownHomeScope(scope)) {
          viewSet.add(scope);
        }
      }
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

function hasProtectedPendingLock(
  pending: Record<string, any> | undefined,
  collection: ScopeScopedCollection,
  id: string,
): boolean {
  if (!pending) return false;
  const rowKey = `${collection}:${id}`;
  const rowType = pending[rowKey]?.type;
  if (rowType === "include" || rowType === "field") return true;
  const fieldPrefix = `${rowKey}:`;
  for (const key in pending) {
    if (!key.startsWith(fieldPrefix)) continue;
    const entryType = pending[key]?.type;
    if (entryType === "field" || entryType === "include") return true;
  }
  return false;
}

function isProtectedChatState(
  collection: ScopeScopedCollection,
  row: any,
): boolean {
  if (collection !== "chatMessages" || !row) return false;
  return !!(row._failedAt || row._failReason || row.sync_local_only);
}

function isRowDetailProtected(
  collections: Partial<ScopeStoreInput>,
  collection: ScopeScopedCollection,
  id: string,
  row: any,
): boolean {
  if (isDetailPinned(collection, id)) return true;
  if (collection === "docs" && isDetailPinned("docDetails", id)) return true;
  if (collection === "tasks") {
    if (isDetailPinned("taskComments", id)) return true;
    if (holdsUnsentComment(row)) return true;
    if (holdsUnsentComment(collections.taskComments?.[id])) return true;
  }
  return false;
}

function isHeldByViewerUserScope(
  row: any,
  viewerId: string | null,
  heldScopes: ReadonlySet<string>,
): boolean {
  if (!row || !viewerId || !heldScopes.has(`user:${viewerId}`)) return false;
  if (row.user_id !== undefined && String(row.user_id) === viewerId) {
    return true;
  }
  if (
    row.owner_user_id !== undefined &&
    String(row.owner_user_id) === viewerId
  ) {
    return true;
  }
  if (
    typeof row.assignee === "string" &&
    row.assignee.length > 0 &&
    !row.assignee.startsWith("agent:") &&
    row.assignee === viewerId
  ) {
    return true;
  }
  return false;
}

function normalizePurgeOptions(
  collections: Partial<Record<ScopeScopedCollection, Record<string, any>>> &
    Partial<ScopeStoreInput>,
  pendingOrOpts?: Record<string, any> | ScopePurgeOptions,
): {
  pending: Record<string, any> | undefined;
  protectedOutboxRows: ReadonlySet<string> | undefined;
  viewerId: string | null;
} {
  const isOpts =
    pendingOrOpts &&
    typeof pendingOrOpts === "object" &&
    ("pending" in pendingOrOpts ||
      "protectedOutboxRows" in pendingOrOpts ||
      "viewerId" in pendingOrOpts);
  const opts = isOpts ? (pendingOrOpts as ScopePurgeOptions) : undefined;
  const pending = opts
    ? (opts.pending ?? collections.pending)
    : ((pendingOrOpts as Record<string, any> | undefined) ??
      collections.pending);
  const protectedOutboxRows =
    opts?.protectedOutboxRows ??
    (typeof collections._protectedOutboxRows === "function"
      ? collections._protectedOutboxRows()
      : undefined);
  const rawViewerId = opts?.viewerId ?? collections.currentUser?._id;
  const viewerId = rawViewerId ? String(rawViewerId) : null;
  return { pending, protectedOutboxRows, viewerId };
}

export function computePurgeSet(
  collections: Partial<Record<ScopeScopedCollection, Record<string, any>>> &
    Partial<ScopeStoreInput>,
  heldScopes: ReadonlySet<string>,
  pendingOrOpts?: Record<string, any> | ScopePurgeOptions,
): PurgeTarget[] {
  const { pending, protectedOutboxRows, viewerId } = normalizePurgeOptions(
    collections,
    pendingOrOpts,
  );
  const targets: PurgeTarget[] = [];
  for (const collection of SCOPE_SCOPED_COLLECTIONS) {
    const rows = collections[collection];
    if (!rows) continue;
    for (const id in rows) {
      if (!isConvexId(id) || isStubId(id)) continue;
      if (hasProtectedPendingLock(pending, collection, id)) continue;
      const row = rows[id];
      if (!row || typeof row !== "object") continue;
      if (
        protectedOutboxRows?.has(`${collection}:${id}`) ||
        (typeof row.short_id === "string" &&
          protectedOutboxRows?.has(`${collection}:${row.short_id}`))
      ) {
        continue;
      }
      if (isProtectedChatState(collection, row)) continue;
      if (isRowDetailProtected(collections, collection, id, row)) continue;
      if (isHeldByViewerUserScope(row, viewerId, heldScopes)) continue;
      const scope = rowHomeScope(collection, row);
      if (!scope || !isKnownHomeScope(scope) || heldScopes.has(scope)) continue;
      targets.push({ collection, id, scope });
    }
  }
  return targets;
}

export function computeEvictionsForPurge(
  collections: Partial<Record<ScopeScopedCollection, Record<string, any>>> &
    Partial<ScopeStoreInput>,
  heldScopes: ReadonlySet<string>,
  opts?: ScopePurgeOptions,
): { targets: PurgeTarget[]; evictions: CacheEviction[] } {
  const targets = computePurgeSet(collections, heldScopes, opts);
  const evictions: CacheEviction[] = [];
  for (const { collection, id } of targets) {
    const observed = collections[collection]?.[id];
    if (observed && typeof observed === "object") {
      evictions.push({ key: collection, id, observed });
    }
  }
  return { targets, evictions };
}

export function purgeUnheldScopeRowsInDraft(
  draft: any,
  heldScopes: ReadonlySet<string>,
  opts?: ScopePurgeOptions | number,
): PurgeTarget[] {
  const resolvedOpts =
    typeof opts === "number" ? { pending: draft.pending } : opts;
  const targets = computePurgeSet(draft, heldScopes, resolvedOpts);
  for (const { collection, id } of targets) {
    const rows = draft[collection] as Record<string, any> | undefined;
    if (rows && id in rows) delete rows[id];
  }
  return targets;
}

const DETAIL_OF_PARENT: Record<string, string> = {
  docs: "docDetails",
  tasks: "taskComments",
};

function rowTeamId(row: any): string | null {
  const ws = row?.workspace;
  if (typeof ws === "string")
    return ws.startsWith("team:") ? ws.slice(5) : null;
  return row?.team_id ? String(row.team_id) : null;
}

function revokedScopeOfRow(
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

export function revokeScopeRowsInDraft(
  draft: any,
  revokedScopes: ReadonlySet<string>,
  now: number,
  userScope?: string | null,
): PurgeTarget[] {
  const targets: PurgeTarget[] = [];
  if (revokedScopes.size === 0) return targets;
  for (const collection of [
    ...SCOPE_SCOPED_COLLECTIONS,
    "projects",
    "docDetails",
  ] as const) {
    const rows = draft[collection] as Record<string, any> | undefined;
    if (!rows) continue;
    for (const id of Object.keys(rows)) {
      if (!isConvexId(id) || isStubId(id)) continue;
      const row = rows[id];
      if (!row || typeof row !== "object") continue;
      const scope = revokedScopeOfRow(collection, row, revokedScopes);
      if (!scope || scope === userScope) continue;
      delete rows[id];
      const detailKey = DETAIL_OF_PARENT[collection];
      if (detailKey && draft[detailKey]?.[id]) delete draft[detailKey][id];
      if (draft.pending) {
        const keys = new Set([collection as string]);
        if (collection === "docDetails") keys.add("docs");
        if (detailKey) keys.add(detailKey);
        for (const key of keys)
          draft.pending[`${key}:${id}`] = { type: "exclude", ts: now, scope };
      }
      if (collection !== "docDetails") targets.push({ collection, id, scope });
    }
  }
  return targets;
}

export function dropDetailsOfRemovedParents(
  draft: any,
  key: string,
  removedIds: readonly string[],
): void {
  const detailKey = DETAIL_OF_PARENT[key];
  const details = detailKey ? draft[detailKey] : undefined;
  if (!details) return;
  for (const id of removedIds) {
    if (details[id] !== undefined) delete details[id];
  }
}
