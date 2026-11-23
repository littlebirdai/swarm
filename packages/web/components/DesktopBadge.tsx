import { useNeedsInputCount } from "../hooks/useNeedsInputCount";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { isDesktop, updateBadge } from "../lib/desktop";
import { useInboxStore } from "../store/inboxStore";

/** The dock and tray share the sidebar's needs-input count. */
export function DesktopBadge() {
  const hydrated = useInboxStore((s) => s.clientStateInitialized);
  const ready = isDesktop() && hydrated;
  const count = useNeedsInputCount(ready);
  useWatchEffect(() => {
    if (ready) void updateBadge(count);
  }, [ready, count]);
  return null;
}
