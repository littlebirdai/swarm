import { afterEach, beforeEach, expect, jest, mock, test } from "bun:test";
import { replaceGlobals } from "../../test-helpers/globals";
import { visibleAnimationLoop, visibleInterval } from "../windowVisibleWork";

const doc = Object.assign(new EventTarget(), { hidden: false });
const show = (visible: boolean) => {
  doc.hidden = !visible;
  doc.dispatchEvent(new Event("visibilitychange"));
};
let restore: () => void;

beforeEach(() => {
  jest.useFakeTimers();
  doc.hidden = false;
  restore = replaceGlobals({
    document: doc,
    requestAnimationFrame: (fn: FrameRequestCallback) =>
      setTimeout(() => fn(performance.now()), 16),
    cancelAnimationFrame: clearTimeout,
  });
});
afterEach(() => {
  restore();
  jest.useRealTimers();
});

test("one interval runs while visible and ticks once on each return", () => {
  const tick = mock(() => {});
  const stop = visibleInterval(tick, 100);
  for (let cycle = 0; cycle < 3; cycle++) {
    expect(jest.getTimerCount()).toBe(1);
    show(false);
    expect(jest.getTimerCount()).toBe(0);
    jest.advanceTimersByTime(200);
    expect(tick).toHaveBeenCalledTimes(cycle * 2);
    show(true);
    show(true);
    expect(tick).toHaveBeenCalledTimes(cycle * 2 + 1);
    jest.advanceTimersByTime(100);
    expect(tick).toHaveBeenCalledTimes(cycle * 2 + 2);
  }
  stop();
});

test("a frame loop can stop itself on the resume tick", () => {
  const tick = mock(() => stop());
  const stop = visibleAnimationLoop(tick);
  show(false);
  show(true);
  expect(tick).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(0);
  show(false);
  show(true);
  expect(tick).toHaveBeenCalledTimes(1);
});

test("cleanup while hidden prevents the interval from restarting", () => {
  const tick = mock(() => {});
  const stop = visibleInterval(tick, 100);
  show(false);
  stop();
  show(true);
  expect(tick).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});
