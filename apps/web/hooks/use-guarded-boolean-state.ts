import { useCallback, useRef, useState } from "react";

export function useGuardedBooleanState(initial: boolean) {
  const [value, setRaw] = useState(initial);
  const ref = useRef(initial);
  const set = useCallback((next: boolean) => {
    if (ref.current === next) return;
    ref.current = next;
    setRaw(next);
  }, []);
  const reset = useCallback((next: boolean) => {
    ref.current = next;
    setRaw(next);
  }, []);
  return [value, set, ref, reset] as const;
}
