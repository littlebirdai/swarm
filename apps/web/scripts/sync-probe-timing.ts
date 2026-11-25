const steps = [
  "save",
  "drainAndHeadBump",
  "getHeads",
  "getRange",
  "apply",
] as const;

type Step = (typeof steps)[number];
type Sample = Record<Step | "total", number>;

const clock = {
  now: () => performance.now(),
  after(ms: number, callback: () => void): () => void {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
};

export async function timeSyncProbe(
  run: (start: (step: Step) => void) => Promise<void>,
  timeoutMs: number,
  timer = clock,
): Promise<Sample> {
  const marks: number[] = [];
  let cancelTimeout: (() => void) | undefined;
  let stalled: Error | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const start = (step: Step) => {
        if (stalled) throw stalled;
        if (steps[marks.length] !== step)
          throw new Error(`Unexpected probe step: ${step}`);
        cancelTimeout?.();
        marks.push(timer.now());
        cancelTimeout = timer.after(timeoutMs, () => {
          stalled = new Error(
            `Sync probe stalled at ${step} after ${timeoutMs} ms`,
          );
          reject(stalled);
        });
      };
      run(start).then(() => {
        if (marks.length === steps.length) resolve();
        else
          reject(new Error(`Sync probe stopped before ${steps[marks.length]}`));
      }, reject);
    });
    const end = timer.now();
    return {
      save: marks[1] - marks[0],
      drainAndHeadBump: marks[2] - marks[1],
      getHeads: marks[3] - marks[2],
      getRange: marks[4] - marks[3],
      apply: end - marks[4],
      total: end - marks[0],
    };
  } finally {
    cancelTimeout?.();
  }
}

export function summarizeSyncProbe(samples: readonly Sample[]) {
  if (!samples.length)
    throw new Error("The sync probe needs at least one sample");
  return Object.fromEntries(
    [...steps, "total" as const].map((step) => {
      const sorted = samples
        .map((sample) => sample[step])
        .sort((a, b) => a - b);
      return [
        step,
        {
          p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
          p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
        },
      ];
    }),
  );
}
