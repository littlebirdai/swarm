const MAX_QUEUED_TRANSITIONS = 64;

export type TransitionGate = {
  isRunning(): boolean;
  run(step: () => void): void;
};

export function createTransitionGate(): TransitionGate {
  let running = false;
  const queued: Array<() => void> = [];

  const runNow = (step: () => void) => {
    running = true;
    try {
      step();
    } finally {
      running = false;
    }
  };

  return {
    isRunning: () => running,
    run(step) {
      if (running) {
        if (queued.length < MAX_QUEUED_TRANSITIONS) queued.push(step);
        return;
      }
      runNow(step);
      while (queued.length > 0) runNow(queued.shift()!);
    },
  };
}
