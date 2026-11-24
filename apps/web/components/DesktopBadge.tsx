import { useNeedsInputCount } from "../hooks/useNeedsInputCount";
import { useDesktopStoreReady } from "../hooks/useDesktopStoreReady";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { isDesktop, updateBadge } from "../lib/desktop";

/** The dock and tray share the sidebar's needs-input count. */
export function DesktopBadge() {
  const storeReady = useDesktopStoreReady();
  const ready = isDesktop() && storeReady;
  const count = useNeedsInputCount(ready);
  useWatchEffect(() => {
    if (ready) void updateBadge(count);
  }, [ready, count]);
  return null;
}
