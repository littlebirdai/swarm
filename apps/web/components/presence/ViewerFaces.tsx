import { useContext } from "react";
import { CommentAvatar } from "../comments/CommentAvatar";
import { memberAvatarUrl } from "../../lib/liveEntities";
import { isConvexId } from "../../lib/entityLinks";
import { RelayPresenceContext } from "../../lib/relay-presence-context";
import {
  isRelayViewerPresenceConfigured,
  useSyncRelayViewerPresence,
} from "../../hooks/use-sync-relay-viewer-presence";
import { useTrackedStore } from "../../store/inboxStore";
import {
  isRelayViewerEntryActive,
  relayViewerFaceMembers,
  relayViewerPresenceSig,
} from "../../store/relay-viewer-presence-slice";
import {
  memberDisplayName,
  viewersLabel,
  viewersOf,
  viewersSig,
} from "./memberPresence";
import "./viewers.css";
import { teamMembersOf } from "../../lib/activeTeam";

// Who has this session open right now, as a stack of small faces. Figma's
// avatars on a file: if Ann's face is on the session, she is looking at it
// this minute, and the two of you can steer it without stepping on each
// other. The faces are the app's one small avatar (CommentAvatar), the same
// face the chat typing line wears, at 14px on an inbox card and 18px on the
// conversation header. Nothing here is declared: the list comes straight off
// the roster's viewing field, which the reporter derives from the window a
// teammate actually has focused.

export function ViewerFaces({
  members,
  size = 16,
  max = 3,
  className = "",
}: {
  members: readonly any[];
  size?: number;
  max?: number;
  className?: string;
}) {
  if (members.length === 0) return null;
  const shown = members.slice(0, max);
  const overflow = members.length - shown.length;
  const label = viewersLabel(members.map((m) => memberDisplayName(m)));
  return (
    <span
      data-sv-viewers={members.length}
      className={`cc-viewers ${className}`}
      style={{
        ["--cc-viewers-overlap" as string]: `${Math.round(size * 0.3)}px`,
      }}
      title={label}
      role="img"
      aria-label={label}
    >
      {shown.map((m) => (
        <CommentAvatar
          key={String(m._id)}
          name={memberDisplayName(m)}
          image={memberAvatarUrl(m)}
          size={size}
        />
      ))}
      {overflow > 0 && (
        <span
          className="cc-viewers-more"
          style={{
            width: size,
            height: size,
            fontSize: Math.max(7, Math.round(size * 0.42)),
          }}
        >
          +{overflow}
        </span>
      )}
    </span>
  );
}

/**
 * The faces for one conversation, read off the roster in the store. One
 * subscription on the viewer id list: a roster push that changes nothing
 * about who is here re-renders nothing, and a heartbeat never reaches it.
 */
export function ConversationViewers({
  conversationId,
  size = 18,
  max = 3,
  className = "",
}: {
  conversationId: string;
  size?: number;
  max?: number;
  className?: string;
}) {
  const relayClient = useContext(RelayPresenceContext);
  const relayConfigured = isRelayViewerPresenceConfigured();
  useSyncRelayViewerPresence(conversationId, isConvexId(conversationId));
  const viewerAccount = relayClient?.viewerAccount;
  const st = useTrackedStore([
    (s) => {
      if (relayConfigured && isConvexId(conversationId)) {
        const entry = s.relayViewerPresence[conversationId];
        if (isRelayViewerEntryActive(entry, viewerAccount)) {
          return `relay:${relayViewerPresenceSig(entry, teamMembersOf(s))}`;
        }
        if (entry === undefined) return "relay:pending";
      }
      return viewersSig(
        teamMembersOf(s),
        conversationId,
        s.currentUser?._id?.toString?.() ?? null,
      );
    },
  ]);
  const relayEntry =
    relayConfigured && isConvexId(conversationId)
      ? st.relayViewerPresence[conversationId]
      : undefined;
  if (isRelayViewerEntryActive(relayEntry, viewerAccount)) {
    if (relayEntry.status === "unknown") {
      return (
        <span
          data-sv-presence-status="unknown"
          role="status"
          aria-label="Presence unknown"
          className={`inline-flex items-center rounded-full border border-sol-border/70 px-2 py-0.5 text-meta text-sol-text-dim ${className}`}
        >
          Presence unknown
        </span>
      );
    }
    if (relayEntry.status !== "ready") return null;
    return (
      <ViewerFaces
        members={relayViewerFaceMembers(relayEntry, teamMembersOf(st))}
        size={size}
        max={max}
        className={className}
      />
    );
  }
  if (
    relayConfigured &&
    isConvexId(conversationId) &&
    relayEntry === undefined
  ) {
    return null;
  }
  const me = st.currentUser?._id?.toString?.() ?? null;
  const viewers = viewersOf(teamMembersOf(st), conversationId, me);
  return (
    <ViewerFaces
      members={viewers}
      size={size}
      max={max}
      className={className}
    />
  );
}
