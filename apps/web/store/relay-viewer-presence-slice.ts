import type { RelayEvent } from "@codecast/relay-client";
import type { PresenceRow } from "../hooks/useDocPresence";
import { memberAvatarUrl, memberDisplayName } from "../lib/liveEntities";
import { sync } from "./mutativeMiddleware";

export type RelayViewerStatus =
  | "disabled"
  | "connecting"
  | "ready"
  | "unknown"
  | "denied";

export type RelayViewerReadingAnchor = {
  message_id: string;
  offset: number;
  at: number;
};

export type RelayViewerDraftCursor = {
  revision: number;
  anchor: number;
  head: number;
};

export type RelayViewerConnectionState = {
  active: boolean;
  inDraft: boolean;
  presenceSeq: number;
  reading?: RelayViewerReadingAnchor;
  readingSeq: number;
  draftCursor?: RelayViewerDraftCursor;
  draftCursorSeq: number;
};

export type RelayViewerIdentity = {
  user_id: string;
  user_name: string;
  user_color: string;
  user_image?: string;
};

export type RelayViewerSessionState = {
  viewer: string;
  hub: string;
  status: RelayViewerStatus;
  connections: Record<string, Record<string, RelayViewerConnectionState>>;
  identities: Record<string, RelayViewerIdentity>;
  deniedIds: Record<string, true>;
};

const PRESENCE_COLORS = [
  "#e06c75",
  "#61afef",
  "#c678dd",
  "#98c379",
  "#e5c07b",
  "#56b6c2",
  "#be5046",
  "#d19a66",
];

function colorForName(name: string): string {
  return PRESENCE_COLORS[(name.charCodeAt(0) || 0) % PRESENCE_COLORS.length];
}

function emptySessionState(
  viewer: string,
  hub: string,
  status: RelayViewerStatus,
): RelayViewerSessionState {
  return {
    viewer,
    hub,
    status,
    connections: {},
    identities: {},
    deniedIds: {},
  };
}

function ensureSessionState(
  map: Record<string, RelayViewerSessionState | undefined>,
  conversationId: string,
  viewer: string,
  hub: string,
  defaultStatus: RelayViewerStatus,
): RelayViewerSessionState {
  const existing = map[conversationId];
  if (existing && existing.viewer === viewer && existing.hub === hub) {
    return existing;
  }
  const created = emptySessionState(viewer, hub, defaultStatus);
  map[conversationId] = created;
  return created;
}

export function applyRelayViewerStatus(
  map: Record<string, RelayViewerSessionState | undefined>,
  conversationId: string,
  viewer: string,
  hub: string,
  status: RelayViewerStatus,
): void {
  const existing = map[conversationId];
  if (
    existing &&
    existing.viewer === viewer &&
    existing.hub === hub &&
    existing.status === status &&
    (status === "ready" ||
      status === "connecting" ||
      Object.keys(existing.connections).length === 0)
  ) {
    return;
  }
  const entry = ensureSessionState(map, conversationId, viewer, hub, status);
  entry.status = status;
  if (status === "unknown" || status === "disabled" || status === "denied") {
    if (Object.keys(entry.connections).length > 0) {
      entry.connections = {};
    }
  }
  if (status === "denied" || status === "disabled") {
    if (Object.keys(entry.identities).length > 0) {
      entry.identities = {};
    }
    if (Object.keys(entry.deniedIds).length > 0) {
      entry.deniedIds = {};
    }
  }
}

function pruneConnectionIfEmpty(
  entry: RelayViewerSessionState,
  userId: string,
  connectionId: string,
  force = true,
): void {
  const userConns = entry.connections[userId];
  if (!userConns) return;
  const conn = userConns[connectionId];
  if (
    !force &&
    conn &&
    (conn.active ||
      conn.reading !== undefined ||
      conn.draftCursor !== undefined)
  ) {
    return;
  }
  delete userConns[connectionId];
  if (Object.keys(userConns).length === 0) {
    delete entry.connections[userId];
  }
}

export function applyRelayViewerSignal(
  map: Record<string, RelayViewerSessionState | undefined>,
  conversationId: string,
  viewer: string,
  hub: string,
  event: RelayEvent,
  nowMs: number,
): void {
  const { signal } = event;
  if (signal.hub.kind !== "session" || signal.hub.id !== hub) return;
  if (!("user_id" in signal) || signal.user_id === viewer) return;

  const entry = ensureSessionState(map, conversationId, viewer, hub, "ready");
  const userId = signal.user_id;
  const connId = signal.connection_id;
  const userConns = entry.connections[userId];
  const conn = userConns?.[connId];

  if (event.type === "removed") {
    if (!conn) return;
    if (signal.type === "presence") {
      if (conn.presenceSeq <= signal.seq) {
        pruneConnectionIfEmpty(entry, userId, connId);
      }
      return;
    }
    if (signal.type === "reading_cursor") {
      if (conn.readingSeq <= signal.seq && conn.reading !== undefined) {
        conn.reading = undefined;
        pruneConnectionIfEmpty(entry, userId, connId, false);
      }
      return;
    }
    if (signal.type === "draft_cursor") {
      if (conn.draftCursorSeq <= signal.seq && conn.draftCursor !== undefined) {
        conn.draftCursor = undefined;
        pruneConnectionIfEmpty(entry, userId, connId, false);
      }
      return;
    }
    return;
  }

  if (signal.type === "presence") {
    if (signal.state === "left") {
      if (conn && conn.presenceSeq < signal.seq) {
        pruneConnectionIfEmpty(entry, userId, connId);
      }
      return;
    }
    if (conn) {
      if (conn.presenceSeq >= signal.seq) return;
      conn.presenceSeq = signal.seq;
      conn.active = true;
      conn.inDraft = signal.in_draft;
      return;
    }
    const bucket = (entry.connections[userId] ??= {});
    bucket[connId] = {
      active: true,
      inDraft: signal.in_draft,
      presenceSeq: signal.seq,
      readingSeq: 0,
      draftCursorSeq: 0,
    };
    return;
  }

  if (signal.type === "reading_cursor") {
    if (signal.cursor === null) {
      if (!conn || conn.readingSeq >= signal.seq) return;
      conn.readingSeq = signal.seq;
      conn.reading = undefined;
      pruneConnectionIfEmpty(entry, userId, connId, false);
      return;
    }
    const target =
      conn ??
      ((entry.connections[userId] ??= {})[connId] = {
        active: false,
        inDraft: false,
        presenceSeq: 0,
        readingSeq: 0,
        draftCursorSeq: 0,
      });
    if (target.readingSeq >= signal.seq) return;
    target.readingSeq = signal.seq;
    const samePos =
      target.reading &&
      target.reading.message_id === signal.cursor.message_id &&
      target.reading.offset === signal.cursor.offset;
    target.reading = {
      message_id: signal.cursor.message_id,
      offset: signal.cursor.offset,
      at: samePos ? target.reading!.at : nowMs,
    };
    return;
  }

  if (signal.type === "draft_cursor") {
    if (signal.cursor === null) {
      if (!conn || conn.draftCursorSeq >= signal.seq) return;
      conn.draftCursorSeq = signal.seq;
      conn.draftCursor = undefined;
      pruneConnectionIfEmpty(entry, userId, connId, false);
      return;
    }
    const target =
      conn ??
      ((entry.connections[userId] ??= {})[connId] = {
        active: false,
        inDraft: false,
        presenceSeq: 0,
        readingSeq: 0,
        draftCursorSeq: 0,
      });
    if (target.draftCursorSeq >= signal.seq) return;
    target.draftCursorSeq = signal.seq;
    target.draftCursor = signal.cursor;
  }
}

export function applyRelayViewerIdentities(
  map: Record<string, RelayViewerSessionState | undefined>,
  conversationId: string,
  viewer: string,
  requestedIds: readonly string[],
  identities: readonly RelayViewerIdentity[],
): void {
  const entry = map[conversationId];
  if (!entry || entry.viewer !== viewer) return;
  const byId = new Map(identities.map((item) => [item.user_id, item]));
  for (const item of identities) {
    const prev = entry.identities[item.user_id];
    if (
      !prev ||
      prev.user_name !== item.user_name ||
      prev.user_color !== item.user_color ||
      prev.user_image !== item.user_image
    ) {
      entry.identities[item.user_id] = item;
    }
    if (entry.deniedIds[item.user_id]) {
      delete entry.deniedIds[item.user_id];
    }
  }
  for (const id of requestedIds) {
    if (!byId.has(id) && !entry.identities[id] && !entry.deniedIds[id]) {
      entry.deniedIds[id] = true;
    }
  }
}

export function isRelayViewerEntryActive(
  entry: RelayViewerSessionState | undefined,
  viewer: string | undefined,
): entry is RelayViewerSessionState {
  return Boolean(
    entry &&
    viewer &&
    entry.viewer === viewer &&
    entry.status !== "disabled" &&
    entry.status !== "denied",
  );
}

export function isRelayViewerPresenceUnknown(
  entry: RelayViewerSessionState | undefined,
  viewer: string | undefined,
): boolean {
  return Boolean(
    entry && viewer && entry.viewer === viewer && entry.status === "unknown",
  );
}

export function relayViewerHasPeers(
  entry: RelayViewerSessionState | undefined,
  viewer: string | undefined,
): boolean {
  return Boolean(
    isRelayViewerEntryActive(entry, viewer) &&
    activeConnectionIds(entry).length > 0,
  );
}

function resolveIdentity(
  userId: string,
  entry: RelayViewerSessionState,
  roster: readonly any[],
): RelayViewerIdentity | null {
  const member = roster.find((m) => String(m?._id) === userId);
  if (member) {
    const name = memberDisplayName(member);
    return {
      user_id: userId,
      user_name: name,
      user_color: colorForName(name),
      user_image: memberAvatarUrl(member),
    };
  }
  return entry.identities[userId] ?? null;
}

function activeConnectionIds(
  entry: RelayViewerSessionState | undefined,
): string[] {
  if (!entry || entry.status !== "ready") return [];
  const ids: string[] = [];
  for (const [userId, conns] of Object.entries(entry.connections)) {
    if (userId === entry.viewer) continue;
    if (Object.values(conns).some((c) => c.active)) {
      ids.push(userId);
    }
  }
  return ids.sort();
}

export function relayViewerUnknownIds(
  entry: RelayViewerSessionState | undefined,
  roster: readonly any[],
): string[] {
  if (!entry || entry.status !== "ready") return [];
  const rosterSet = new Set(roster.map((m) => String(m?._id)));
  return activeConnectionIds(entry)
    .filter(
      (id) =>
        !rosterSet.has(id) && !entry.identities[id] && !entry.deniedIds[id],
    )
    .slice(0, 32);
}

function aggregateReading(
  conns: Record<string, RelayViewerConnectionState>,
): RelayViewerReadingAnchor | undefined {
  let latest: RelayViewerReadingAnchor | undefined;
  for (const conn of Object.values(conns)) {
    if (!conn.active || !conn.reading) continue;
    if (!latest || conn.reading.at > latest.at) {
      latest = conn.reading;
    }
  }
  return latest;
}

function aggregateDraftCursor(
  conns: Record<string, RelayViewerConnectionState>,
  sharedRevision: number | null | undefined,
): number | undefined {
  if (sharedRevision == null) return undefined;
  for (const conn of Object.values(conns)) {
    if (!conn.active || !conn.inDraft || !conn.draftCursor) continue;
    if (conn.draftCursor.revision === sharedRevision) {
      return conn.draftCursor.head;
    }
  }
  return undefined;
}

export function relayViewerRows(
  entry: RelayViewerSessionState | undefined,
  roster: readonly any[],
  sharedRevision?: number | null,
): PresenceRow[] {
  if (!entry || entry.status !== "ready") return [];
  const out: PresenceRow[] = [];
  for (const userId of activeConnectionIds(entry)) {
    const identity = resolveIdentity(userId, entry, roster);
    if (!identity) continue;
    const conns = entry.connections[userId] ?? {};
    const inDraft = Object.values(conns).some((c) => c.active && c.inDraft);
    const reading = aggregateReading(conns);
    const cursorPos = aggregateDraftCursor(conns, sharedRevision);
    out.push({
      user_id: identity.user_id,
      user_name: identity.user_name,
      user_color: identity.user_color,
      user_image: identity.user_image,
      in_draft: inDraft || undefined,
      cursor_pos: cursorPos,
      anchor: reading
        ? { message_id: reading.message_id, offset: reading.offset }
        : undefined,
      anchor_at: reading?.at,
    });
  }
  return out;
}

export function relayViewerFaceMembers(
  entry: RelayViewerSessionState | undefined,
  roster: readonly any[],
): Array<{ _id: string; name: string; image?: string }> {
  if (!entry || entry.status !== "ready") return [];
  const out: Array<{ _id: string; name: string; image?: string }> = [];
  for (const userId of activeConnectionIds(entry)) {
    const identity = resolveIdentity(userId, entry, roster);
    if (!identity) continue;
    out.push({
      _id: identity.user_id,
      name: identity.user_name,
      image: identity.user_image,
    });
  }
  return out;
}

function digestStrings(parts: readonly string[]): string {
  let hash = 2166136261;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      hash ^= part.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    hash ^= 10;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function relayViewerPresenceSig(
  entry: RelayViewerSessionState | undefined,
  roster: readonly any[],
): string {
  if (!entry) return "";
  if (entry.status !== "ready") return entry.status;
  const parts: string[] = [entry.status, entry.viewer];
  for (const userId of activeConnectionIds(entry)) {
    const identity = resolveIdentity(userId, entry, roster);
    const inDraft = Object.values(entry.connections[userId] ?? {}).some(
      (c) => c.active && c.inDraft,
    );
    parts.push(
      `${userId}:${inDraft ? 1 : 0}:${identity ? `${identity.user_name}:${identity.user_image ?? ""}` : "?"}`,
    );
  }
  return `${entry.status}:${parts.length - 2}:${digestStrings(parts)}`;
}

export function relayViewerAnchorsSig(
  entry: RelayViewerSessionState | undefined,
  roster: readonly any[],
): string {
  if (!entry) return "";
  if (entry.status !== "ready") return entry.status;
  const parts: string[] = [entry.status];
  for (const userId of activeConnectionIds(entry)) {
    const identity = resolveIdentity(userId, entry, roster);
    if (!identity) continue;
    const reading = aggregateReading(entry.connections[userId] ?? {});
    parts.push(
      `${userId}:${reading ? `${reading.message_id}:${reading.offset}` : ""}:${identity.user_name}`,
    );
  }
  return `${entry.status}:${parts.length - 1}:${digestStrings(parts)}`;
}

export function relayViewerMessageAnchorSig(
  entry: RelayViewerSessionState | undefined,
  roster: readonly any[],
  messageId: string,
): string {
  if (!entry || entry.status !== "ready") return "";
  const parts: string[] = [];
  for (const userId of activeConnectionIds(entry)) {
    const reading = aggregateReading(entry.connections[userId] ?? {});
    if (reading?.message_id !== messageId) continue;
    const identity = resolveIdentity(userId, entry, roster);
    if (!identity) continue;
    parts.push(`${userId}:${reading.offset}:${identity.user_name}`);
  }
  return parts.length === 0 ? "" : `${parts.length}:${digestStrings(parts)}`;
}

type RelayViewerSliceDraft = {
  relayViewerPresence: Record<string, RelayViewerSessionState | undefined>;
};

export type RelayViewerPresenceSlice = {
  setRelayViewerStatus: (
    conversationId: string,
    viewer: string,
    hub: string,
    status: RelayViewerStatus,
  ) => void;
  applyRelayViewerEvent: (
    conversationId: string,
    viewer: string,
    hub: string,
    event: RelayEvent,
    nowMs: number,
  ) => void;
  setRelayViewerIdentities: (
    conversationId: string,
    viewer: string,
    requestedIds: readonly string[],
    identities: readonly RelayViewerIdentity[],
  ) => void;
  clearRelayViewerPresence: (conversationId: string) => void;
};

export function createRelayViewerPresenceSlice(): RelayViewerPresenceSlice {
  return {
    setRelayViewerStatus: sync(function (
      this: RelayViewerSliceDraft,
      conversationId: string,
      viewer: string,
      hub: string,
      status: RelayViewerStatus,
    ) {
      applyRelayViewerStatus(
        this.relayViewerPresence,
        conversationId,
        viewer,
        hub,
        status,
      );
    }),
    applyRelayViewerEvent: sync(function (
      this: RelayViewerSliceDraft,
      conversationId: string,
      viewer: string,
      hub: string,
      event: RelayEvent,
      nowMs: number,
    ) {
      applyRelayViewerSignal(
        this.relayViewerPresence,
        conversationId,
        viewer,
        hub,
        event,
        nowMs,
      );
    }),
    setRelayViewerIdentities: sync(function (
      this: RelayViewerSliceDraft,
      conversationId: string,
      viewer: string,
      requestedIds: readonly string[],
      identities: readonly RelayViewerIdentity[],
    ) {
      applyRelayViewerIdentities(
        this.relayViewerPresence,
        conversationId,
        viewer,
        requestedIds,
        identities,
      );
    }),
    clearRelayViewerPresence: sync(function (
      this: RelayViewerSliceDraft,
      conversationId: string,
    ) {
      if (conversationId in this.relayViewerPresence) {
        delete this.relayViewerPresence[conversationId];
      }
    }),
  } as unknown as RelayViewerPresenceSlice;
}
