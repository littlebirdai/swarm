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
  deleteAllowed,
  durableDeletes,
  hasSnapshotDrops,
  patchedIds,
} from "../../idbCollectionDiff";
import { META_KEYS } from "../schema";
import { encode, type SqliteDriver } from "./schema";

const metaKeys = new Set([...META_KEYS].filter((key) => key !== "pending"));

export function collectionStorage(db: SqliteDriver) {
  let retainConversations = false;
  const readMeta = db.prepare<{ value: string }>(
    "SELECT value FROM meta WHERE key = ?",
  );
  const putMeta = db.prepare(`
    INSERT INTO meta (key, value) VALUES (?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value
    WHERE meta.value <> excluded.value
  `);
  const deleteMeta = db.prepare("DELETE FROM meta WHERE key = ?");
  const readRows = db.prepare<{ id: string; value: string }>(
    "SELECT id, value FROM collection_rows WHERE collection = ? ORDER BY id",
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
  const writeRow = (key: string, id: string, row: Record<string, unknown>) => {
    const timestamp =
      row.timestamp ?? row.updated_at ?? row.created_at ?? row._creationTime;
    putRow.run(
      key,
      id,
      typeof timestamp === "number" ? timestamp : null,
      encode(row),
    );
  };
  const deleteRow = db.prepare(
    "DELETE FROM collection_rows WHERE collection = ? AND id = ?",
  );

  const getMeta = (key: string) => {
    const row = readMeta.get(key);
    return row ? JSON.parse(row.value) : undefined;
  };
  const setMeta = (key: string, value: unknown) => {
    if (value === undefined) deleteMeta.run(key);
    else putMeta.run(key, encode(value));
  };
  const loadRows = (key: string) =>
    readRows.all(key).map(({ value }) => JSON.parse(value));

  function load(
    keys: readonly string[] | undefined,
    context: Record<string, any>,
    maintain: boolean,
  ): Record<string, any> | null {
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
      const rows = loadRows(key);
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
      if (maintain && retained?.drop.length) {
        if (key === "conversations") retainConversations = true;
        else for (const id of retained.drop) deleteRow.run(key, id);
      }
      const valid = collectionRowValidator(key);
      const hydrate = collectionRowHydrator(key);
      const kept: Array<[string, unknown]> = [];
      for (const row of retained?.keep ?? rows) {
        if (valid && !valid(row)) {
          if (maintain) deleteRow.run(key, row._id);
          continue;
        }
        const value = hydrate
          ? hydrate(row, { pending: context.pending ?? {} })
          : row;
        if (maintain && value !== row) writeRow(key, row._id, value);
        kept.push([row._id, value]);
      }
      if (
        kept.length ||
        (key === "conversations" && retained?.keep.length === 0)
      )
        result[key] = Object.fromEntries(kept);
    }
    return Object.keys(result).length ? result : null;
  }

  function write(patches: Patch[], state: Record<string, any>) {
    const keys = new Set(
      patches.flatMap(({ path }) => (path.length ? [String(path[0])] : [])),
    );
    for (const key of keys) {
      if (Object.hasOwn(WEB_COLLECTION_INDEXES, key)) {
        const data = state[key];
        if (!data || typeof data !== "object") continue;
        const ids = hasSnapshotDrops(key) ? null : patchedIds(patches, key);
        const pending = state.pending ?? {};
        if (ids) {
          for (const id of ids) {
            if (Object.hasOwn(data, id)) writeRow(key, id, data[id]);
            else if (deleteAllowed(key, id, pending)) deleteRow.run(key, id);
          }
        } else {
          const absent = readIds
            .all(key)
            .map(({ id }) => id)
            .filter((id) => !Object.hasOwn(data, id));
          for (const id of durableDeletes(
            key,
            absent,
            pending,
            undefined,
            new Map(),
          )) {
            deleteRow.run(key, id);
          }
          for (const [id, row] of Object.entries(data))
            writeRow(key, id, row as Record<string, unknown>);
        }
        if (key === "conversations" && retainConversations) {
          retainConversations = false;
          const { drop } = partitionSessionRetention(
            loadRows(key),
            state.liveInboxIdList,
            state.lastFocusedConversationId,
            Date.now(),
          );
          for (const id of drop) {
            if (!Object.hasOwn(data, id)) deleteRow.run(key, id);
          }
        }
      } else if (metaKeys.has(key) && key !== "syncMeta") {
        setMeta(key, state[key]);
      }
    }
    if (keys.has("syncMeta")) setMeta("syncMeta", state.syncMeta);
  }

  return {
    getMeta,
    setMeta,
    load,
    write,
    resetRetention: () => {
      retainConversations = false;
    },
  };
}
