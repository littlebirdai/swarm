import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader, DatabaseWriter } from "../_generated/server";
import { purgeRow, type PurgeNode } from "./purgeTree";

const underShare = (share: Doc<"terminal_watch_shares">) => share._id;

export const terminalWatchRows: PurgeNode = {
  table: "terminal_watch_shares",
  index: "by_conversation",
  field: "conversation_id",
  value: (conversation) => conversation._id,
  children: [
    {
      table: "terminal_watch_viewers",
      index: "by_share_user",
      field: "share",
      value: underShare,
    },
    {
      table: "terminal_watch_screens",
      index: "by_share",
      field: "share",
      value: underShare,
      page: 1,
      weight: 10,
    },
  ],
};

export const terminalWatchBlocks: PurgeNode = {
  table: "terminal_watch_blocks",
  index: "by_conversation_user",
  field: "conversation_id",
  value: (conversation) => conversation._id,
};

export function terminalWatchScreen(
  db: DatabaseReader,
  share: Id<"terminal_watch_shares">,
) {
  return db
    .query("terminal_watch_screens")
    .withIndex("by_share", (q) => q.eq("share", share))
    .unique();
}

export function terminalWatchViewers(
  db: DatabaseReader,
  share: Id<"terminal_watch_shares">,
) {
  return db
    .query("terminal_watch_viewers")
    .withIndex("by_share_user", (q) => q.eq("share", share));
}

export async function deleteTerminalShare(
  db: DatabaseWriter,
  share: Doc<"terminal_watch_shares">,
) {
  await purgeRow({ db }, terminalWatchRows, share, { left: 100 }, {});
}

export async function deleteTerminalViewer(
  db: DatabaseWriter,
  viewer: Doc<"terminal_watch_viewers">,
) {
  await db.delete(viewer._id);
  const now = Date.now();
  const viewers = await terminalWatchViewers(db, viewer.share).collect();
  if (viewers.some((row) => !row.revoked && row.expires_at > now)) return;
  const screen = await terminalWatchScreen(db, viewer.share);
  if (screen) await db.delete(screen._id);
}
