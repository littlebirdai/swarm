const MAX_QUEUED_TRANSITIONS = 64;

type Step = { run: () => void; essential: boolean };

export type TransitionGate = {
  isRunning(): boolean;
  run(step: () => void, options?: { essential?: boolean }): void;
};

export function createTransitionGate(): TransitionGate {
  let running = false;
  const queued: Step[] = [];

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
          queued.push({ run: step, essential });
        return;
      }
      let failure = runNow(step);
      while (queued.length > 0) {
        const error = runNow(queued.shift()!.run);
        failure ??= error;
      }
      if (failure !== undefined) throw failure;
    },
  };
}
