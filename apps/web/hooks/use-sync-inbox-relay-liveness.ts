import { useContext, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import {
  RelayPresenceContext,
  type RelayPresenceClient,
} from "../lib/relay-presence-context";
import {
  setInboxRelayContact,
  useInboxRelayLiveness,
} from "../store/inbox-relay-liveness";
import { useInboxStore } from "../store/inboxStore";
import { useIsSyncHost } from "./use-sync-role";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useWatchEffect } from "./useWatchEffect";

const limit = 64;

type Target = { id: string; run: number; machine: string };

function watchInboxRelay(client: RelayPresenceClient, viewer: string) {
  const active = new Map<string, { target: Target; off: () => void }>();
  return (targets: readonly Target[]) => {
    const next = new Map(targets.map((target) => [target.id, target]));
    for (const [id, { target, off }] of active) {
      const replacement = next.get(id);
      if (
        replacement?.run === target.run &&
        replacement.machine === target.machine
      )
        continue;
      active.delete(id);
      off();
      setInboxRelayContact(id);
    }
    for (const target of targets) {
      const { id, run, machine } = target;
      if (active.has(id)) continue;
      const entry = {
        target,
        off: client.subscribe(id, ({ type, signal }) => {
          if (
            active.get(id)?.target !== target ||
            signal.type !== "session_liveness" ||
            signal.hub.id !== id
          )
            return;
          if (
            type === "removed" ||
            signal.run !== run ||
            signal.machine_id !== machine
          ) {
            const current = useInboxRelayLiveness.getState().contacts[id];
            if (
              current?.connection === signal.connection_id &&
              current.sequence <= signal.seq
            )
              setInboxRelayContact(id);
          } else {
            setInboxRelayContact(id, {
              viewer,
              machine,
              connection: signal.connection_id,
              sequence: signal.seq,
              deadline: performance.now() + signal.ttl_ms,
            });
          }
        }),
      };
      active.set(id, entry);
    }
  };
}

export function useSyncInboxRelayLiveness() {
  const client = useContext(RelayPresenceContext);
  const isHost = useIsSyncHost();
  const account = useInboxStore((state) => state.currentUser?._id);
  const viewer =
    isHost && client?.inboxViewer === account ? client?.inboxViewer : undefined;
  const ids = useInboxRelayLiveness(
    useShallow((state) =>
      viewer
        ? (Object.keys(state.visible).slice(0, limit) as Id<"conversations">[])
        : [],
    ),
  );
  const { data } = useQueryNoThrow(
    api.relayGrants.inboxTargets,
    viewer && ids.length > 0 ? { ids } : "skip",
  );
  const watch = useMemo(
    () => (client && viewer ? watchInboxRelay(client, viewer) : null),
    [client, viewer],
  );
  useWatchEffect(() => () => watch?.([]), [watch]);
  useWatchEffect(() => {
    watch?.(
      data?.viewer === viewer && data
        ? data.targets.filter(({ id }) => ids.includes(id))
        : [],
    );
  }, [watch, data, viewer, ids]);
}
