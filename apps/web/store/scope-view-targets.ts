import { useInboxStore } from "./inboxStore";
import type { ScopeViewTargetKind } from "./scope-subscriptions";

let nextOwner = 0;

export function newScopeViewOwner(): string {
  nextOwner += 1;
  return `view-${nextOwner}`;
}

export function holdScopeViewTarget(
  owner: string,
  kind: ScopeViewTargetKind,
  id: string | null | undefined,
): () => void {
  if (!id) return () => {};
  useInboxStore.getState().setScopeViewTargets(owner, [{ kind, id }]);
  return () => useInboxStore.getState().setScopeViewTargets(owner, []);
}
