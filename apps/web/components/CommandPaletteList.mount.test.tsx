import { afterAll, afterEach, expect, test } from "bun:test";
import { act } from "react";
import { JSDOM } from "jsdom";
import { replaceGlobals } from "../test-helpers/globals";
import { closeDomWindow } from "../test-helpers/domGlobals";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true,
});
dom.window.HTMLElement.prototype.scrollIntoView = function () {
  const list = this.closest<HTMLElement>("[cmdk-list]");
  if (!list || !this.matches("[cmdk-item]")) return;
  const index = Array.from(list.querySelectorAll("[cmdk-item]")).indexOf(this);
  const top = index * 48;
  if (top < list.scrollTop) list.scrollTop = top;
  else if (top + 48 > list.scrollTop + 480) list.scrollTop = top + 48 - 480;
};
const restoreGlobals = replaceGlobals({
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Event: dom.window.Event,
  MutationObserver: dom.window.MutationObserver,
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = await import("react-dom/client");
const { Command } = await import("cmdk");
const { CommandPaletteList } = await import("./CommandPaletteList");
const container = document.createElement("div");
document.body.appendChild(container);
let root = createRoot(container);
const rows = Array.from({ length: 40 }, (_, i) => `Aivery session ${i}`);

async function render(search: string, items = rows) {
  await act(() =>
    root.render(
      <Command>
        <Command.Input value={search} onValueChange={() => {}} />
        <CommandPaletteList>
          <Command.Group heading="Sessions">
            {items.map((row) => (
              <Command.Item key={row} value={row}>
                {row}
              </Command.Item>
            ))}
          </Command.Group>
        </CommandPaletteList>
      </Command>,
    ),
  );
  return container.querySelector<HTMLElement>("[cmdk-list]")!;
}

afterEach(async () => {
  await act(() => root.unmount());
  root = createRoot(container);
});

afterAll(async () => {
  await act(() => root.unmount());
  closeDomWindow(dom);
  restoreGlobals();
});

test("typing returns to the top even when the first result stays selected", async () => {
  const list = await render("ai");
  const selected = container.querySelector('[aria-selected="true"]');
  list.scrollTop = 800;

  await render("aiv");
  expect(container.querySelector('[aria-selected="true"]')).toBe(selected);
  expect(list.scrollTop).toBe(0);

  list.scrollTop = 400;
  await render("aive");
  expect(list.scrollTop).toBe(0);
  list.scrollTop = 600;
  await render("");
  expect(list.scrollTop).toBe(0);
  expect(list.style.overflowAnchor).toBe("none");
  expect(list.classList.contains("scroll-smooth")).toBe(false);
});

test("results arriving for the same query preserve the user's scroll position", async () => {
  const list = await render("ai");
  list.scrollTop = 300;
  await render("ai", [...rows, "Aivery delayed result"]);
  expect(list.scrollTop).toBe(300);
});
