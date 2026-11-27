import { BrowserPaneOfferGlyph } from "../browser/BrowserPaneOfferChip";
import { useContext } from "react";
import { isHostedAgentType } from "@codecast/agent-clients/agentClients";
import { rowHeartbeatAliveAt } from "@codecast/inbox/inboxProjection";
import { RelayPresenceContext } from "../../lib/relay-presence-context";
import { isSessionKilled } from "../../lib/sessionRetirement";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { isConvexId, type InboxSession } from "../../store/inboxStore";
import {
  mountRelayInboxCard,
  useInboxRelayLiveness,
} from "../../store/inbox-relay-liveness";

export function RelayInboxContact({
  session,
  now,
}: {
  session: InboxSession;
  now: number;
}) {
  const viewer = useContext(RelayPresenceContext)?.inboxViewer;
  const { _id: id, owner_device_id: machine } = session;
  const eligible =
    !!viewer &&
    !!machine &&
    isConvexId(id) &&
    !isHostedAgentType(session.agent_type) &&
    !isSessionKilled(session) &&
    session.status !== "archived";
  useWatchEffect(
    () => (eligible ? mountRelayInboxCard(id) : undefined),
    [eligible, id],
  );
  const recent = useInboxRelayLiveness((state) => {
    if (!eligible) return false;
    const contact = state.contacts[id];
    return (
      !!contact &&
      contact.viewer === viewer &&
      contact.machine === machine &&
      contact.deadline > performance.now()
    );
  });
  if (
    !recent ||
    session.agent_status === "stopped" ||
    !rowHeartbeatAliveAt(session, now)
  )
    return null;
  return (
    <span
      className="size-1.5 shrink-0 rounded-full bg-sol-green"
      role="img"
      aria-label="Recent machine contact"
    />
  );
}

export function InboxCardIndicators({
  session,
  now,
}: {
  session: InboxSession;
  now: number;
}) {
  return (
    <>
      <BrowserPaneOfferGlyph offer={session.browser_pane_offer} />
      <RelayInboxContact session={session} now={now} />
    </>
  );
}
