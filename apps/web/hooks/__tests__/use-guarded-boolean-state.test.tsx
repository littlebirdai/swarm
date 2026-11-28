import type { Root } from "react-dom/client";
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { act, type RefObject } from "react";
import { JSDOM } from "jsdom";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { replaceGlobals } from "../../test-helpers/globals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost/",
});
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
});
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const { createRoot } = await import("react-dom/client");
const { useGuardedBooleanState } = await import("../use-guarded-boolean-state");

afterAll(() => {
  closeDomWindow(dom);
  restoreGlobals();
});

let root: Root;

beforeEach(() => {
  root = createRoot(dom.window.document.createElement("div"));
});

afterEach(async () => {
  await act(async () => root.unmount());
});

test("skips same-value set even immediately after commit while reset calls the setter", async () => {
  let renders = 0;
  let current = false;
  let setFn!: (next: boolean) => void;
  let resetFn!: (next: boolean) => void;
  let refObj!: RefObject<boolean>;

  function Probe() {
    renders += 1;
    const [value, set, ref, reset] = useGuardedBooleanState(false);
    current = value;
    setFn = set;
    refObj = ref;
    resetFn = reset;
    return null;
  }

  await act(async () => root.render(<Probe />));
  expect(renders).toBe(1);
  expect(current).toBe(false);
  expect(refObj.current).toBe(false);

  renders = 0;
  await act(async () => {
    setFn(false);
  });
  expect(renders).toBe(0);

  await act(async () => {
    setFn(true);
  });
  expect(renders).toBe(1);
  expect(current).toBe(true);
  expect(refObj.current).toBe(true);

  renders = 0;
  await act(async () => {
    setFn(true);
  });
  expect(renders).toBe(0);

  await act(async () => {
    resetFn(true);
  });
  expect(renders).toBe(1);

  renders = 0;
  await act(async () => {
    resetFn(false);
  });
  expect(renders).toBe(1);
  expect(current).toBe(false);
  expect(refObj.current).toBe(false);
});
