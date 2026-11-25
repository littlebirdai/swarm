import type { Patch } from "mutative";
import {
  COLLECTION_RETENTION,
  partitionSessionRetention,
} from "../../cacheRetention";
import {
  collectionRowHydrator,
  collectionRowValidator,
  WEB_COLLECTION_INDEXES,
} from "../../clientSyncRegistry";
import {
  clearSnapshotDrops,
  deleteAllowed,
  hasSnapshotDrops,
  patchedIds,
} from "../../idb-collection-diff";
import { META_KEYS } from "../schema";
import { encode, type AfterCommit, type SqliteDriver } from "./schema";

const journalKeys = new Set(["pending", "pendingMessages", "queuedMessages"]);
const metaKeys = new Set([...META_KEYS].filter((key) => !journalKeys.has(key)));

type StoredRow = { id: string; value: string };

export function collectionStorage(db: SqliteDriver) {
  const conversationDrops = new Set<string>();
  const readMeta = db.prepare<{ value: string }>(
    "SELECT value FROM meta WHERE key = ?",
  );
  const putMeta = db.prepare(`
    INSERT INTO meta (key, value) VALUES (?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value
    WHERE meta.value <> excluded.value
  `);
  const deleteMeta = db.prepare("DELETE FROM meta WHERE key = ?");
  const readRows = db.prepare<StoredRow>(
    "SELECT id, value FROM collection_rows WHERE collection = ? ORDER BY id",
  );
  const readRow = db.prepare<StoredRow>(
    "SELECT id, value FROM collection_rows WHERE collection = ? AND id = ?",
  );
  const readIds = db.prepare<{ id: string }>(
    "SELECT id FROM collection_rows WHERE collection = ?",
  );
  const putRow = db.prepare(`
    INSERT INTO collection_rows (collection, id, timestamp, value) VALUES (?, ?, ?, ?)
    ON CONFLICT (collection, id) DO UPDATE
      SET timestamp = excluded.timestamp, value = excluded.value
    WHERE collection_rows.value <> excluded.value
  `);
  const deleteRow = db.prepare(
    "DELETE FROM collection_rows WHERE collection = ? AND id = ?",
  );
  function writeRow(
    key: string,
    id: string,
    row: Record<string, unknown>,
  ): boolean {
    const value = encode(row, key);
    if (value === undefined) return false;
    const timestamp =
      row.timestamp ?? row.updated_at ?? row.created_at ?? row._creationTime;
    putRow.run(
      key,
      id,
      typeof timestamp === "number" && Number.isFinite(timestamp)
        ? timestamp
        : null,
      value,
    );
    return true;
  }

  const getMeta = (key: string) => {
    const row = readMeta.get(key);
    return row ? JSON.parse(row.value) : undefined;
  };
  function setMeta(key: string, value: unknown): boolean {
    if (value === undefined) {
      deleteMeta.run(key);
      return true;
    }
    const json = encode(value, key);
    if (json === undefined) return false;
    putMeta.run(key, json);
    return true;
  }
  function load(
    keys: readonly string[] | undefined,
    context: Record<string, any>,
    afterCommit?: AfterCommit,
  ) {
    const result: Record<string, any> = {};
    for (const key of keys ?? metaKeys) {
      if (!metaKeys.has(key)) continue;
      const value = getMeta(key);
      if (value !== undefined) result[key] = value;
    }
    const live = getMeta("liveInboxIdList");
    const focus = getMeta("lastFocusedConversationId");
    const now = Date.now();
    for (const key of keys ?? Object.keys(WEB_COLLECTION_INDEXES)) {
      if (!Object.hasOwn(WEB_COLLECTION_INDEXES, key)) continue;
      const rows = [];
      const valid = collectionRowValidator(key);
      for (const { id, value } of readRows.all(key)) {
        let row;
        try {
          row = JSON.parse(value);
        } catch {}
        if (row?._id !== id || (valid && !valid(row))) {
          if (afterCommit) deleteRow.run(key, id);
          continue;
        }
        rows.push(row);
      }
      if (!rows.length) continue;
      const retained =
        key === "sessions" || key === "conversations"
          ? partitionSessionRetention(
              rows,
              live === undefined ? context.liveInboxIdList : live,
              focus === undefined ? context.lastFocusedConversationId : focus,
              now,
            )
          : COLLECTION_RETENTION[key]?.(rows, now);
      if (afterCommit && retained?.drop.length) {
        if (key === "conversations") {
          afterCommit(() => {
            for (const id of retained.drop) conversationDrops.add(id);
          });
        } else {
          for (const id of retained.drop) deleteRow.run(key, id);
        }
      }
      const hydrate = collectionRowHydrator(key);
      const kept = (retained?.keep ?? rows).map((row) => {
        const value = hydrate
          ? hydrate(row, { pending: context.pending ?? {} })
          : row;
        if (afterCommit && value !== row) writeRow(key, row._id, value);
        return [row._id, value] as const;
      });
      if (
        kept.length ||
        (key === "conversations" && retained?.keep.length === 0)
      )
        result[key] = Object.fromEntries(kept);
    }
    return Object.keys(result).length ? result : null;
  }
  function write(
    patches: Patch[],
    state: Record<string, any>,
    cursorBlocked: boolean,
    afterCommit: AfterCommit,
  ) {
    const keys = new Set(
      patches.flatMap(({ path }) => (path.length ? [String(path[0])] : [])),
    );
    let complete = true;
    for (const key of keys) {
      if (Object.hasOwn(WEB_COLLECTION_INDEXES, key)) {
        const data = state[key];
        if (!data || typeof data !== "object") continue;
        const pending = state.pending ?? {};
        const snapshot = hasSnapshotDrops(key);
        const ids = snapshot ? null : patchedIds(patches, key);
        const affected =
          ids ??
          new Set([
            ...Object.keys(data),
            ...readIds.all(key).map(({ id }) => id),
          ]);
        for (const id of affected) {
          const row = Object.hasOwn(data, id) ? data[id] : undefined;
          if (row != null) {
            if (!writeRow(key, id, row)) complete = false;
          } else if (deleteAllowed(key, id, pending)) {
            deleteRow.run(key, id);
          }
        }
        if (snapshot) afterCommit(() => clearSnapshotDrops(key));
        if (key === "conversations" && conversationDrops.size) {
          const candidates = [...conversationDrops].flatMap((id) => {
            if (data[id] != null) return [];
            const stored = readRow.get(key, id);
            return stored ? [JSON.parse(stored.value)] : [];
          });
          const { drop } = partitionSessionRetention(
            [
              ...Object.values(data).filter((row) => row != null),
              ...candidates,
            ],
            state.liveInboxIdList ?? getMeta("liveInboxIdList"),
            state.lastFocusedConversationId ??
              getMeta("lastFocusedConversationId"),
            Date.now(),
          );
          const expired = new Set(drop);
          for (const row of candidates) {
            if (expired.has(row._id)) deleteRow.run(key, row._id);
          }
          afterCommit(() => conversationDrops.clear());
        }
      } else if (metaKeys.has(key) && key !== "syncMeta") {
        if (!setMeta(key, state[key])) complete = false;
      }
    }
    if (complete && !cursorBlocked && keys.has("syncMeta"))
      return setMeta("syncMeta", state.syncMeta);
    return complete;
  }

  return {
    getMeta,
    setMeta,
    load,
    write,
    resetRetention: () => conversationDrops.clear(),
  };
}
