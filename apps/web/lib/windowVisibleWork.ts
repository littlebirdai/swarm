// The desktop shell folds its window visibility into document.hidden and
// dispatches visibilitychange through applyShellVisibility.
export function whileWindowVisible(start: (resumed: boolean) => () => void, onResume?: () => void): () => void {
  if (typeof document === "undefined") return start(false);
  const doc = document;
  let stop: (() => void) | undefined;
  const pause = () => {
    stop?.();
    stop = undefined;
  };
  const update = () => {
    if (doc.hidden) {
      pause();
    } else if (!stop) {
      stop = start(true);
      onResume?.();
    }
  };

  if (!doc.hidden) stop = start(false);
  doc.addEventListener("visibilitychange", update);
  return () => {
    doc.removeEventListener("visibilitychange", update);
    pause();
  };
}

export function visibleInterval(tick: () => void, ms: number): () => void {
  return whileWindowVisible(() => {
    const id = setInterval(tick, ms);
    return () => clearInterval(id);
  }, tick);
}

export function visibleAnimationLoop(tick: (now: number) => void | false): () => void {
  const run = (now: number) => {
    if (tick(now) === false) stop();
  };
  const stop = whileWindowVisible(() => {
    let running = true;
    let frame = requestAnimationFrame(function next(now) {
      run(now);
      if (running) frame = requestAnimationFrame(next);
    });
    return () => {
      running = false;
      cancelAnimationFrame(frame);
    };
  }, () => run(performance.now()));
  return stop;
}
