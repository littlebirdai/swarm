import { withoutSecrets } from "@codecast/secrets/secretShapes";
import { useMemo } from "react";
import { useDocPresence, type PresenceRow } from "./useDocPresence";
import { useSharedDraftStatus } from "./useSharedDraft";
import { useWatchEffect } from "./useWatchEffect";
import { setCoPresent } from "../lib/composerPresence";
import { useInboxStore } from "../store/inboxStore";

export function useComposerPresence(
  conversationId: string,
  draftText: string,
  opts: { enabled: boolean; forceBroadcast: boolean },
): PresenceRow[] {
  const shared = useSharedDraftStatus(conversationId);
  const anchor = useInboxStore((s) =>
    s.viewAnchor?.conversationId === conversationId ? s.viewAnchor : null,
  );
  const previewText = useMemo(
    () => (shared.active ? "" : withoutSecrets(draftText)),
    [shared.active, draftText],
  );
  const present = useDocPresence({
    docId: `compose:${conversationId}`,
    draftText: previewText,
    cursor: shared.active ? shared.caret : null,
    cursorRevision: shared.active ? (shared.revision ?? null) : null,
    inDraft: shared.active,
    anchor: anchor
      ? { message_id: anchor.messageId, offset: anchor.offset }
      : null,
    enabled: opts.enabled,
    forceBroadcast: opts.forceBroadcast,
  });
  useWatchEffect(() => {
    setCoPresent(conversationId, present.length);
    return () => setCoPresent(conversationId, 0);
  }, [conversationId, present.length]);
  return present;
}
