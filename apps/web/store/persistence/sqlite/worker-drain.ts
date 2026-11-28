import type { WorkerHandle } from "./protocol";

export type DrainingWorker = {
  epochId: string;
  workerId: string;
  worker: WorkerHandle;
  releaseLock: (() => void) | null;
};

export function createWorkerDrains(deps: {
  timeoutMs: number;
  onDrained: (drain: DrainingWorker) => void;
}) {
  const drains = new Map<
    string,
    { drain: DrainingWorker; timer: ReturnType<typeof setTimeout> }
  >();

  const finish = (workerId: string): boolean => {
    const entry = drains.get(workerId);
    if (!entry) return false;
    drains.delete(workerId);
    clearTimeout(entry.timer);
    try {
      entry.drain.worker.terminate();
    } catch {}
    entry.drain.releaseLock?.();
    deps.onDrained(entry.drain);
    return true;
  };

  return {
    start(drain: DrainingWorker): boolean {
      try {
        drain.worker.postMessage({ type: "close" });
      } catch {
        return false;
      }
      drains.set(drain.workerId, {
        drain,
        timer: setTimeout(() => finish(drain.workerId), deps.timeoutMs),
      });
      return true;
    },
    finish,
  };
}
