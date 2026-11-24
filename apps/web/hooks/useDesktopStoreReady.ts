import { useSyncExternalStore } from "react";
import { useAuthPrincipal } from "../lib/authPrincipal";
import {
  isWindowStoreActive,
  subscribeWindowStoreStart,
} from "../lib/windowRole";
import { useInboxStore } from "../store/inboxStore";

/** A signed-out window can report cleared state as soon as its store is active. */
export function useDesktopStoreReady(): boolean {
  const active = useSyncExternalStore(
    subscribeWindowStoreStart,
    isWindowStoreActive,
    () => true,
  );
  const hydrated = useInboxStore((s) => s.clientStateInitialized);
  const { principalId } = useAuthPrincipal();
  return active && (hydrated || principalId === null);
}
