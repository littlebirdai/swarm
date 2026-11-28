const MAX_QUEUED_TRANSITIONS = 64;

export type TransitionGate = {
  isRunning(): boolean;
  run(step: () => void, options?: { essential?: boolean }): void;
};

export function createTransitionGate(): TransitionGate {
  let running = false;
  const queued: Array<() => void> = [];

  const runNow = (step: () => void): unknown => {
    running = true;
    try {
      step();
      return undefined;
    } catch (error) {
      return error ?? new Error("Transition failed");
    } finally {
      running = false;
    }
  };

  return {
    isRunning: () => running,
    run(step, options) {
      const essential = options?.essential === true;
      if (running) {
        if (essential || queued.length < MAX_QUEUED_TRANSITIONS)
          queued.push(step);
        return;
      }
      let failure = runNow(step);
      while (queued.length > 0) {
        const error = runNow(queued.shift()!);
        failure ??= error;
      }
      if (failure !== undefined) throw failure;
    },
  };
}
