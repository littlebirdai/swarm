import { useCallback, useRef } from "react";
import { useFocusEffect } from "expo-router";
import {
  holdScopeViewTarget,
  newScopeViewOwner,
} from "@codecast/web/store/scope-view-targets";
import type { ScopeViewTargetKind } from "@codecast/web/store/scope-subscriptions";

export function useFocusedScopeViewTarget(
  kind: ScopeViewTargetKind,
  id: string | null | undefined,
): void {
  const owner = useRef<string | null>(null);
  owner.current ??= newScopeViewOwner();
  useFocusEffect(
    useCallback(
      () => holdScopeViewTarget(owner.current as string, kind, id),
      [kind, id],
    ),
  );
}
