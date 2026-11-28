import { useContext, useRef } from "react";
import { useMutation } from "convex/react";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { api } from "@codecast/convex/convex/_generated/api";

import { useWatchEffect } from "./useWatchEffect";
import { teamMembersOf } from "../lib/activeTeam";
import {
  RelayPresenceAvailableContext,
  RelayPresenceContext,
} from "../lib/relay-presence-context";
import { useInboxStore, useTrackedStore } from "../store/inboxStore";
import {
  isRelayViewerEntryActive,
  relayViewerAnchorsSig,
  relayViewerHasPeers,
  relayViewerMessageAnchorSig,
  relayViewerRows,
} from "../store/relay-viewer-presence-slice";
import {
  composeConversationId,
  useRelayViewerTargetState,
  useSubscribeRelayViewer,
} from "./use-sync-relay-viewer-presence";
// ── Generic live co-presence over the doc_presence backend ───────────────────
// One ephemeral presence row per (user, doc_id). Anyone watching a doc_id sees
// who else is there and the words they're forming live (draft_text) — the "type
// with me" / "is typing…" signal — with no shared OT buffer.
//
// doc_id is an arbitrary namespace string. Established conventions:
//   compose:<conversationId>            — the owner/collab composer co-presence
//   comment:<conversationId>            — the conversation's global comment thread
//   comment:<conversationId>:<msgId>    — a per-message anchored comment thread
//
// Broadcast (writing our own row: heartbeat + draft pushes + leave-cleanup) is
// gated: we write iff `forceBroadcast` is set OR someone else is already present.
// So a passive solo viewer writes nothing, but once anyone joins, everyone there
// announces themselves. The query is gated by `enabled` (skip until authed;
// getPresence errors during the auth-loading window otherwise).

export type PresenceAnchor = { message_id: string; offset: number };

export type PresenceRow = {
  user_id: string;
  user_name: string;
  user_color: string;
  user_image?: string;
  draft_text?: string;
  /** compose: rows only. Their caret in the shared draft; present only while their box is in it and focused. */
  cursor_pos?: number;
  /** compose: rows only. Their box has joined the shared draft, focused or not. */
  in_draft?: boolean;
  /** compose: rows only. Whether this person may send into the session; false makes their draft a suggestion. */
  can_send?: boolean;
  /** compose: rows only. Where this person is reading the transcript. */
  anchor?: PresenceAnchor;
  /** compose: rows only. When the anchor last moved; the heartbeat does not touch it. */
  anchor_at?: number;
  /** compose: rows only. Others' drafts this person just sent as parts of one joint turn. */
  claims?: Array<{ user_id: string; text: string; at: number; how?: string }>;
};

const NO_ROWS: PresenceRow[] = [];
const RELAY_SIGNAL_TTL_MS = 15_000;
const RELAY_REFRESH_MS = 10_000;

export type PresenceRowsFilter = {
  scope?: "all" | "draft" | "anchors" | "message";
  messageId?: string;
  sharedRevision?: number | null;
};

/** Read-only: who else is on a doc id. Several surfaces may read one id; only one broadcasts. */
export function usePresenceRows(
  docId: string,
  enabled: boolean,
  filter?: PresenceRowsFilter,
): PresenceRow[] {
  const relayClient = useContext(RelayPresenceContext);
  const relayAvailable = useContext(RelayPresenceAvailableContext);
  const convId = composeConversationId(docId);
  const viewerAccount = relayClient?.viewerAccount;
  const scope = filter?.scope ?? "all";
  const messageId = filter?.messageId;
  const sharedRevision = filter?.sharedRevision;
  const relayScope = scope === "anchors" || scope === "message";
  const useRelay = Boolean(relayScope && convId && relayAvailable && enabled);

  const st = useTrackedStore([
    (s) => {
      if (!useRelay || !convId) return "";
      const entry = s.relayViewerPresence[convId];
      if (!entry) return "pending";
      const status = entry.status;
      if (!isRelayViewerEntryActive(entry, viewerAccount)) return status;
      const roster = teamMembersOf(s);
      if (scope === "message" && messageId !== undefined) {
        return relayViewerMessageAnchorSig(entry, roster, messageId);
      }
      return relayViewerAnchorsSig(entry, roster);
    },
  ]);

  const entry = useRelay && convId ? st.relayViewerPresence[convId] : undefined;
  const relayActive =
    useRelay && isRelayViewerEntryActive(entry, viewerAccount);
  const queryLegacy = enabled && !relayScope;

  // Presence only decorates the editor: when the doc is gone or the viewer
  // lost access the query throws NOT_FOUND, and the editor's own doc read says
  // so. The avatars go empty rather than taking the surface down.
  const legacyRows = (useQueryNoThrow(
    api.docSync.getPresence,
    queryLegacy ? { doc_id: docId } : "skip",
  ).data ?? NO_ROWS) as PresenceRow[];

  if (!enabled) return NO_ROWS;
  if (relayActive) {
    const rows = relayViewerRows(entry, teamMembersOf(st), sharedRevision);
    if (scope === "message" && messageId !== undefined) {
      return rows.filter((r) => r.anchor?.message_id === messageId);
    }
    return rows.length === 0 ? NO_ROWS : rows;
  }
  if (relayScope) {
    return NO_ROWS;
  }
  return legacyRows;
}

export function useDocPresence(opts: {
  docId: string;
  draftText?: string;
  /** Where this person is reading, sent with the draft (at most twice a second). */
  anchor?: PresenceAnchor | null;
  /** My caret in the shared draft (hooks/useSharedDraft); null when my box is not in one or not focused. */
  cursor?: number | null;
  cursorRevision?: number | null;
  /** My box has joined the shared draft. */
  inDraft?: boolean;
  enabled: boolean;
  forceBroadcast: boolean;
}): PresenceRow[] {
  const {
    docId,
    draftText = "",
    anchor = null,
    cursor = null,
    cursorRevision = null,
    inDraft = false,
    enabled,
    forceBroadcast,
  } = opts;
  const convId = composeConversationId(docId);
  const viewerState = useRelayViewerTargetState(convId, enabled);
  const relayClient = viewerState.client;
  const viewerAccount = relayClient?.viewerAccount;
  const targetHub = viewerState.activeTarget?.hub;
  const relayStatus = useInboxStore((s) => {
    const entry = convId ? s.relayViewerPresence[convId] : undefined;
    return viewerAccount && entry?.viewer === viewerAccount
      ? entry.status
      : undefined;
  });
  const hasRelayPeers = useInboxStore((s) =>
    convId
      ? relayViewerHasPeers(s.relayViewerPresence[convId], viewerAccount)
      : false,
  );
  const relayReady =
    Boolean(targetHub && relayClient && viewerState.available) &&
    relayStatus === "ready";
  const update = useMutation(api.docSync.updatePresence);
  const remove = useMutation(api.docSync.removePresence);
  const present = usePresenceRows(docId, enabled, {
    scope: "all",
    sharedRevision: cursorRevision,
  });
  const broadcast = enabled && (forceBroadcast || present.length > 0);

  const draftRef = useRef(draftText);
  draftRef.current = draftText;
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const inDraftRef = useRef(inDraft);
  inDraftRef.current = inDraft;
  const relayLatestRef = useRef({
    anchor,
    hasRelayPeers,
  });
  useWatchEffect(() => {
    relayLatestRef.current = {
      anchor,
      hasRelayPeers,
    };
  }, [anchor, hasRelayPeers]);
  const sentReadingRef = useRef(false);

  const push = () =>
    update({
      doc_id: docId,
      draft_text: draftRef.current,
      cursor_pos: cursorRef.current ?? undefined,
      in_draft: inDraftRef.current || undefined,
    }).catch(() => {});

  // Heartbeat while broadcasting (keeps the row inside the 30s stale window),
  // and clear it on exit so the other side sees us leave promptly.
  useWatchEffect(() => {
    if (!broadcast) return;
    push();
    const iv = setInterval(push, 3000);
    return () => {
      clearInterval(iv);
      remove({ doc_id: docId }).catch(() => {});
    };
  }, [broadcast, docId, update, remove]);

  useWatchEffect(() => {
    if (!broadcast) return;
    const t = setTimeout(push, 250);
    return () => clearTimeout(t);
  }, [draftText, cursor, inDraft, broadcast, docId, update]);

  useWatchEffect(() => {
    if (!relayReady || !enabled || !targetHub || !relayClient) return;
    const hub = { kind: "session" as const, id: targetHub };
    const publishPresence = () => {
      relayClient.publish(
        {
          v: 1,
          hub,
          type: "presence",
          state: "active",
          in_draft: false,
        },
        RELAY_SIGNAL_TTL_MS,
      );
    };
    const publishReading = () => {
      const latest = relayLatestRef.current;
      if (!latest.anchor || !latest.hasRelayPeers) return;
      sentReadingRef.current = true;
      relayClient.publish(
        {
          v: 1,
          hub,
          type: "reading_cursor",
          cursor: {
            message_id: latest.anchor.message_id,
            offset: Math.min(1, Math.max(0, latest.anchor.offset)),
          },
        },
        RELAY_SIGNAL_TTL_MS,
      );
    };

    publishPresence();
    const iv = setInterval(() => {
      publishPresence();
      publishReading();
    }, RELAY_REFRESH_MS);

    return () => {
      clearInterval(iv);
      sentReadingRef.current = false;
      relayClient.publish(
        {
          v: 1,
          hub,
          type: "presence",
          state: "left",
          in_draft: false,
        },
        0,
      );
    };
  }, [relayReady, enabled, relayClient, targetHub]);

  const relayAnchorAt = useRef(0);
  const anchorMessageId = anchor?.message_id ?? null;
  const anchorOffset = anchor ? Number(anchor.offset.toFixed(2)) : null;
  useWatchEffect(() => {
    if (!relayReady || !enabled || !targetHub || !relayClient) return;
    const hub = { kind: "session" as const, id: targetHub };
    if (!hasRelayPeers || !anchorMessageId || anchorOffset === null) {
      if (sentReadingRef.current) {
        sentReadingRef.current = false;
        relayClient.publish(
          { v: 1, hub, type: "reading_cursor", cursor: null },
          0,
        );
      }
      return;
    }
    const wait = Math.max(0, 500 - (Date.now() - relayAnchorAt.current));
    const publishAnchor = () => {
      relayAnchorAt.current = Date.now();
      const latest = relayLatestRef.current;
      if (!latest.anchor || !latest.hasRelayPeers) return;
      sentReadingRef.current = true;
      relayClient.publish(
        {
          v: 1,
          hub,
          type: "reading_cursor",
          cursor: {
            message_id: latest.anchor.message_id,
            offset: Math.min(1, Math.max(0, latest.anchor.offset)),
          },
        },
        RELAY_SIGNAL_TTL_MS,
      );
    };
    if (wait === 0) {
      publishAnchor();
      return;
    }
    const t = setTimeout(publishAnchor, wait);
    return () => clearTimeout(t);
  }, [
    relayReady,
    enabled,
    relayClient,
    targetHub,
    hasRelayPeers,
    anchorMessageId,
    anchorOffset,
  ]);

  useSubscribeRelayViewer(viewerState, enabled);

  return present;
}
