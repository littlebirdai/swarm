import { useContext, useMemo } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import {
  RelayPresenceContext,
  type RelayPresenceClient,
} from "../lib/relay-presence-context";
import { useInboxStore } from "../store/inboxStore";
import { makeCollectionSig } from "../store/wakeSig";
import { useIsSyncHost } from "./use-sync-role";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useWatchEffect } from "./useWatchEffect";

const limit = 64;
const visibleSig = makeCollectionSig<number>(() => "");
const visibleIds = (cards: Record<string, number>) =>
  Object.keys(cards).slice(0, limit) as Id<"conversations">[];

function makeVisibleSelector() {
  let previous: string | undefined;
  let ids: Id<"conversations">[] = [];
  return (state: ReturnType<typeof useInboxStore.getState>) => {
    const signature = visibleSig(state.relayInboxCards);
    if (signature !== previous) {
      previous = signature;
      ids = visibleIds(state.relayInboxCards);
    }
    return ids;
  };
}

const emptyIds: Id<"conversations">[] = [];
const noVisibleCards = () => emptyIds;

type Target = { id: string; run: number; machine: string };

function watchInboxRelay(client: RelayPresenceClient, viewer: string) {
  const active = new Map<string, { target: Target; off: () => void }>();
  let resolved: readonly Target[] = [];
  return (ids: readonly string[], latest?: readonly Target[]) => {
    const visible = new Set(ids);
    resolved = (latest ?? resolved).filter(({ id }) => visible.has(id));
    const targets = resolved;
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
      useInboxStore.getState().setInboxRelayContact(id);
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
          const store = useInboxStore.getState();
          if (
            type === "removed" ||
            signal.run !== run ||
            signal.machine_id !== machine
          ) {
            const current = store.relayInboxContacts[id];
            if (
              current?.connection === signal.connection_id &&
              current.sequence <= signal.seq
            )
              store.setInboxRelayContact(id);
          } else {
            store.setInboxRelayContact(id, {
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
  const selectVisibleIds = useMemo(() => makeVisibleSelector(), []);
  const ids = useInboxStore(viewer ? selectVisibleIds : noVisibleCards);
  const { data, error } = useQueryNoThrow(
    api.relayGrants.inboxTargets,
    viewer && ids.length > 0 ? { ids } : "skip",
  );
  const watch = useMemo(
    () => (client && viewer ? watchInboxRelay(client, viewer) : null),
    [client, viewer],
  );
  useWatchEffect(() => () => watch?.([]), [watch]);
  useWatchEffect(() => {
    const targets =
      error || data === null || (data && data.viewer !== viewer)
        ? []
        : data?.targets;
    watch?.(ids, targets);
  }, [watch, data, error, viewer, ids]);
}
