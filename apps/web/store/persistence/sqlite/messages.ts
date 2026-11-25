import { persistedMessageTail } from "../../cacheRetention";
import { sameValue } from "../../sameValue";
import { diffMessageTail } from "../messageTailDiff";
import type { CachedConversation } from "../storage";
import { encode, type SqliteDriver } from "./schema";

type Message = {
  _id?: string;
  _clientId?: string;
  client_id?: string;
  timestamp?: number;
};
type Meta = {
  pagination: string | null;
  latest_timestamp: number | null;
  user_messages: string | null;
};

const MAX_CONVERSATIONS = 1000;
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PROTECT_RECENT_MS = 10 * 60 * 1000;

export function messageStorage(db: SqliteDriver) {
  const meta = db.prepare<Meta>(
    "SELECT pagination, latest_timestamp, user_messages FROM conversation_meta WHERE id = ?",
  );
  const rows = db.prepare<{
    message_key: string;
    position: number;
    value: string;
  }>(`
    SELECT message_key, position, value FROM message_rows
    WHERE conversation_id = ? ORDER BY position, message_key
  `);
  const putRow = db.prepare(`
    INSERT INTO message_rows VALUES (?, ?, ?, ?)
    ON CONFLICT (conversation_id, message_key) DO UPDATE
      SET position = excluded.position, value = excluded.value
  `);
  const deleteRow = db.prepare(
    "DELETE FROM message_rows WHERE conversation_id = ? AND message_key = ?",
  );
  const putTail = db.prepare(`
    INSERT INTO conversation_meta (id, pagination, latest_timestamp, touched_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET pagination = excluded.pagination,
      latest_timestamp = excluded.latest_timestamp, touched_at = excluded.touched_at
  `);
  const touch = db.prepare(
    "UPDATE conversation_meta SET touched_at = ? WHERE id = ?",
  );
  const putUserMessages = db.prepare(`
    INSERT INTO conversation_meta (id, user_messages, touched_at) VALUES (?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET user_messages = excluded.user_messages,
      touched_at = excluded.touched_at
  `);
  const prune = db.prepare<{ id: string }>(`
    SELECT id FROM conversation_meta
    WHERE touched_at < ? AND (
      COALESCE(latest_timestamp, touched_at) < ? OR id IN (
        SELECT id FROM conversation_meta
        ORDER BY COALESCE(latest_timestamp, touched_at) DESC, id DESC LIMIT -1 OFFSET ?
      )
    )
    LIMIT 10
  `);
  const deleteTail = db.prepare(
    "DELETE FROM message_rows WHERE conversation_id = ?",
  );
  const deleteConversation = db.prepare(
    "DELETE FROM conversation_meta WHERE id = ?",
  );

  function load(id: string): CachedConversation | null {
    const row = meta.get(id);
    if (!row) return null;
    return {
      messages: rows.all(id).map(({ value }) => JSON.parse(value)),
      pagination:
        row.pagination === null ? undefined : JSON.parse(row.pagination),
      latestTimestamp: row.latest_timestamp ?? 0,
      userMessages:
        row.user_messages === null ? undefined : JSON.parse(row.user_messages),
    };
  }

  function write(id: string, messages: unknown[], pagination: unknown) {
    const tail = persistedMessageTail(
      messages as Message[],
      pagination as Record<string, unknown> | undefined,
    );
    const prior = meta.get(id);
    const previous = new Map(
      rows
        .all(id)
        .map(({ message_key, position, value }) => [
          message_key,
          { position, message: JSON.parse(value) as Message },
        ]),
    );
    const { puts, deletes } = diffMessageTail(previous, tail.messages);
    for (const key of deletes) deleteRow.run(id, key);
    for (const row of puts)
      putRow.run(id, row.messageKey, row.position, encode(row.message));
    const latest = tail.messages.reduce(
      (max, message) => Math.max(max, message.timestamp ?? 0),
      0,
    );
    const now = Date.now();
    if (
      prior?.latest_timestamp === latest &&
      sameValue(
        prior.pagination === null ? undefined : JSON.parse(prior.pagination),
        tail.pagination,
      )
    )
      touch.run(now, id);
    else
      putTail.run(
        id,
        tail.pagination === undefined ? null : encode(tail.pagination),
        latest,
        now,
      );
    retain(now);
  }

  function retain(now: number) {
    for (const { id } of prune.all(
      now - PROTECT_RECENT_MS,
      now - TTL_MS,
      MAX_CONVERSATIONS,
    )) {
      deleteTail.run(id);
      deleteConversation.run(id);
    }
  }

  return {
    load,
    write,
    writeUserMessages(id: string, messages: unknown[]) {
      const now = Date.now();
      putUserMessages.run(id, encode(messages), now);
      retain(now);
    },
  };
}
