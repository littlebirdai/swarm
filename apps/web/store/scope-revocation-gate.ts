import type { Patch } from "mutative";
import { isKnownHomeScope, revokedScopeOfRow } from "./scope-row-home";

const REVOCATION_GATED: Readonly<Record<string, true>> = {
  tasks: true,
  docs: true,
  plans: true,
  chatMessages: true,
  projects: true,
  docDetails: true,
  taskComments: true,
};

export function isRevocationGated(collection: string): boolean {
  return REVOCATION_GATED[collection] === true;
}

const EMPTY_REVOCATIONS: Record<string, unknown> = {};
const revokedScopesMemo = new WeakMap<
  object,
  WeakMap<object, ReadonlySet<string> | null>
>();

function computeRevokedScopes(
  published: Record<string, unknown>,
  denied: Record<string, unknown>,
): ReadonlySet<string> | null {
  let out: Set<string> | null = null;
  for (const map of [published, denied]) {
    for (const scope in map) {
      if (scope.startsWith("user:") || !isKnownHomeScope(scope)) continue;
      (out ??= new Set()).add(scope);
    }
  }
  return out;
}

export function activeRevokedScopes(state: {
  scopeRevocations?: Record<string, number>;
  scopeSubscriptions?: { denied?: Record<string, unknown> };
}): ReadonlySet<string> | null {
  const published = state.scopeRevocations ?? EMPTY_REVOCATIONS;
  const denied = state.scopeSubscriptions?.denied ?? EMPTY_REVOCATIONS;
  let byDenied = revokedScopesMemo.get(published);
  if (!byDenied) {
    byDenied = new WeakMap();
    revokedScopesMemo.set(published, byDenied);
  }
  if (byDenied.has(denied)) return byDenied.get(denied) ?? null;
  const out = computeRevokedScopes(published, denied);
  byDenied.set(denied, out);
  return out;
}

export function rowInRevokedScope(
  state: Parameters<typeof activeRevokedScopes>[0],
  collection: string,
  row: any,
): boolean {
  if (!isRevocationGated(collection) || !row || typeof row !== "object")
    return false;
  const revoked = activeRevokedScopes(state);
  return !!revoked && revokedScopeOfRow(collection, row, revoked) !== null;
}

export function dropRevokedRows<T>(
  state: Parameters<typeof activeRevokedScopes>[0],
  collection: string,
  incoming: T,
): T {
  if (!isRevocationGated(collection) || !Array.isArray(incoming))
    return incoming;
  const revoked = activeRevokedScopes(state);
  if (!revoked) return incoming;
  const kept = incoming.filter(
    (row) =>
      !row ||
      typeof row !== "object" ||
      revokedScopeOfRow(collection, row, revoked) === null,
  );
  return (kept.length === incoming.length ? incoming : kept) as T;
}

export function dropRevokedRowMap<T>(
  state: Parameters<typeof activeRevokedScopes>[0],
  collection: string,
  rows: T,
): T {
  if (!isRevocationGated(collection) || !rows || typeof rows !== "object")
    return rows;
  if (Array.isArray(rows)) return dropRevokedRows(state, collection, rows);
  const revoked = activeRevokedScopes(state);
  if (!revoked) return rows;
  let out: Record<string, unknown> | null = null;
  for (const [id, row] of Object.entries(rows as Record<string, unknown>)) {
    if (revokedScopeOfRow(collection, row, revoked) === null) continue;
    out ??= { ...(rows as Record<string, unknown>) };
    delete out[id];
  }
  return (out ?? rows) as T;
}

function gatedIds(
  nextState: Record<string, any>,
  patches: readonly Patch[],
  revoked: ReadonlySet<string>,
): Map<string, Map<string, string>> | null {
  let out: Map<string, Map<string, string>> | null = null;
  const consider = (key: string, id: string) => {
    const row = nextState[key]?.[id];
    if (!row || typeof row !== "object") return;
    const scope = revokedScopeOfRow(key, row, revoked);
    if (!scope) return;
    out ??= new Map();
    let ids = out.get(key);
    if (!ids) out.set(key, (ids = new Map()));
    ids.set(id, scope);
  };
  for (const patch of patches) {
    const path = patch.path as Array<string | number>;
    const key = String(path[0]);
    if (!isRevocationGated(key)) continue;
    if (path.length === 1) {
      for (const id in nextState[key] ?? {}) consider(key, id);
      continue;
    }
    if (patch.op === "remove" && path.length === 2) continue;
    consider(key, String(path[1]));
  }
  return out;
}

const MENTION_KINDS = ["tasks", "docs", "plans"] as const;

function gateDerivedKeys(
  next: Record<string, any>,
  patches: readonly Patch[],
  revoked: ReadonlySet<string>,
  extra: Patch[],
): boolean {
  let changed = false;
  let feedsCopied = false;
  for (const patch of patches) {
    const path = patch.path as Array<string | number>;
    if (path[0] === "feedConversations") {
      const feeds = next.feedConversations ?? {};
      const keys = path.length > 1 ? [String(path[1])] : Object.keys(feeds);
      for (const feedKey of keys) {
        const team = feedKey.split("|")[0];
        if (!(feedKey in feeds) || !revoked.has(`dir:${team}`)) continue;
        if (!feedsCopied) {
          next.feedConversations = { ...feeds };
          feedsCopied = true;
        }
        delete next.feedConversations[feedKey];
        extra.push({ op: "remove", path: ["feedConversations", feedKey] });
        changed = true;
      }
    } else if (path[0] === "mentionIndex") {
      const index = next.mentionIndex;
      if (!index) continue;
      const kinds = path.length > 1 ? [String(path[1])] : [...MENTION_KINDS];
      for (const kind of kinds) {
        const rows = index[kind];
        if (!rows) continue;
        const kept: Record<string, unknown> = {};
        let dropped = false;
        for (const [id, row] of Object.entries(rows)) {
          if (revokedScopeOfRow(kind, row, revoked)) dropped = true;
          else kept[id] = row;
        }
        if (!dropped) continue;
        next.mentionIndex = { ...next.mentionIndex, [kind]: kept };
        extra.push({
          op: "replace",
          path: ["mentionIndex", kind],
          value: kept,
        });
        changed = true;
      }
    }
  }
  return changed;
}

export function gateRevokedCommit(commit: {
  state: any;
  nextState: any;
  patches: Patch[];
}): { nextState: any; patches: Patch[] } | null {
  const revoked = activeRevokedScopes(commit.nextState);
  if (!revoked) return null;
  const hits = gatedIds(commit.nextState, commit.patches, revoked);
  const next: Record<string, any> = { ...commit.nextState };
  const derived: Patch[] = [];
  const derivedChanged = gateDerivedKeys(
    next,
    commit.patches,
    revoked,
    derived,
  );
  if (!hits)
    return derivedChanged ? { nextState: next, patches: derived } : null;
  const now = Date.now();
  const pending: Record<string, any> = { ...(next.pending ?? {}) };
  const extra: Patch[] = [];
  for (const [key, ids] of hits) {
    const rows = { ...next[key] };
    for (const [id, scope] of ids) {
      delete rows[id];
      pending[`${key}:${id}`] = { type: "exclude", ts: now, scope };
      extra.push({ op: "remove", path: [key, id] });
    }
    next[key] = rows;
  }
  next.pending = pending;
  extra.push({ op: "replace", path: ["pending"], value: pending });
  return { nextState: next, patches: [...derived, ...extra] };
}
