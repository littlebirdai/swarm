import { useRef } from "react";
import { useInboxStore } from "../store/inboxStore";
import type { ScopeViewTargetKind } from "../store/scope-subscriptions";
import { useWatchEffect } from "./useWatchEffect";

let nextOwner = 0;

export function useScopeViewTarget(
  kind: ScopeViewTargetKind,
  id: string | null | undefined,
): void {
  const ownerRef = useRef<string | null>(null);
  ownerRef.current ??= `view-${++nextOwner}`;
  useWatchEffect(() => {
    const owner = ownerRef.current as string;
    useInboxStore
      .getState()
      .setScopeViewTargets(owner, id ? [{ kind, id }] : []);
    return () => useInboxStore.getState().setScopeViewTargets(owner, []);
  }, [kind, id]);
}
