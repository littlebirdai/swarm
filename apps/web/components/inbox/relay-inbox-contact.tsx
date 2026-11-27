import { BrowserPaneOfferGlyph } from "../browser/BrowserPaneOfferChip";
import { useContext, useState } from "react";
import { isHostedAgentType } from "@codecast/agent-clients/agentClients";
import { HEARTBEAT_ALIVE_MS } from "@codecast/sessions/agentStatus";
import { RelayPresenceContext } from "../../lib/relay-presence-context";
import { isSessionKilled } from "../../lib/sessionRetirement";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import {
  isConvexId,
  type InboxSession,
  useInboxStore,
} from "../../store/inboxStore";

export function RelayInboxContact({ session }: { session: InboxSession }) {
  const viewer = useContext(RelayPresenceContext)?.inboxViewer;
  const { _id: id, owner_device_id: machine } = session;
  if (
    !viewer ||
    !machine ||
    !isConvexId(id) ||
    isHostedAgentType(session.agent_type) ||
    isSessionKilled(session) ||
    session.status === "archived"
  )
    return null;
  return <ActiveRelayInboxContact id={id} machine={machine} viewer={viewer} />;
}

function ActiveRelayInboxContact({
  id,
  machine,
  viewer,
}: {
  id: string;
  machine: string;
  viewer: string;
}) {
  useWatchEffect(() => {
    const { countRelayInboxCard } = useInboxStore.getState();
    countRelayInboxCard(id, 1);
    return () => countRelayInboxCard(id, -1);
  }, [id]);
  const deadline = useInboxStore((state) => {
    const contact = state.relayInboxContacts[id];
    return contact?.viewer === viewer && contact.machine === machine
      ? contact.deadline
      : undefined;
  });
  const leaseEnd = useInboxStore((state) => {
    const row = state.sessions[id];
    if (!row || row.agent_status === "stopped") return null;
    return (
      row.liveness_lease_end ??
      (row.last_heartbeat == null
        ? null
        : row.last_heartbeat + HEARTBEAT_ALIVE_MS)
    );
  });
  const [live, setLive] = useState(false);
  useWatchEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      const delay =
        deadline === undefined || leaseEnd === null
          ? 0
          : Math.min(deadline - performance.now(), leaseEnd - Date.now());
      setLive(delay > 0);
      if (delay > 0) timer = setTimeout(check, Math.ceil(delay));
    };
    check();
    return () => clearTimeout(timer);
  }, [deadline, leaseEnd]);
  if (!live || deadline === undefined || leaseEnd === null) return null;
  return (
    <span
      className="size-1.5 shrink-0 rounded-full bg-sol-green"
      role="img"
      aria-label="Recent machine contact"
    />
  );
}

export function InboxCardIndicators({ session }: { session: InboxSession }) {
  return (
    <>
      <BrowserPaneOfferGlyph offer={session.browser_pane_offer} />
      <RelayInboxContact session={session} />
    </>
  );
}
