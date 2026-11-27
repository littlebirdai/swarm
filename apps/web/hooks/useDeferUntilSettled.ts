import { useState } from "react";
import { useWatchEffect } from "./useWatchEffect";

export function useDeferUntilSettled(key: string | null | undefined): boolean {
  const [enabledKey, setEnabledKey] = useState<string | null | undefined>(key);
  useWatchEffect(() => {
    if (!key || enabledKey === key) return;
    const id = setTimeout(() => setEnabledKey(key), 0);
    return () => clearTimeout(id);
  }, [key, enabledKey]);
  return enabledKey === key;
}
