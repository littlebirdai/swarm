import { JSDOM } from "jsdom";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { replaceGlobals } from "./globals";
import { closeDomWindow } from "./domGlobals";

const noop = () => {};
class InertObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

export function createTestDom(url: string) {
  const dom = new JSDOM(
    "<!doctype html><html><body><div id='root'></div></body></html>",
    { url, pretendToBeVisual: true },
  );
  const w = dom.window;
  const matchMedia = (media: string) => ({
    matches: false,
    media,
    onchange: null,
    addEventListener: noop,
    removeEventListener: noop,
    addListener: noop,
    removeListener: noop,
    dispatchEvent: () => false,
  });
  const restoreGlobals = replaceGlobals({
    window: w,
    document: w.document,
    navigator: w.navigator,
    location: w.location,
    history: w.history,
    localStorage: w.localStorage,
    sessionStorage: w.sessionStorage,
    indexedDB,
    IDBKeyRange,
    HTMLElement: w.HTMLElement,
    HTMLInputElement: w.HTMLInputElement,
    HTMLTextAreaElement: w.HTMLTextAreaElement,
    HTMLButtonElement: w.HTMLButtonElement,
    HTMLAnchorElement: w.HTMLAnchorElement,
    HTMLDivElement: w.HTMLDivElement,
    SVGElement: w.SVGElement,
    Element: w.Element,
    Node: w.Node,
    Text: w.Text,
    DocumentFragment: w.DocumentFragment,
    Event: w.Event,
    CustomEvent: w.CustomEvent,
    KeyboardEvent: w.KeyboardEvent,
    MouseEvent: w.MouseEvent,
    FocusEvent: w.FocusEvent,
    PointerEvent: w.PointerEvent ?? w.MouseEvent,
    DOMParser: w.DOMParser,
    customElements: w.customElements,
    HTMLFormElement: w.HTMLFormElement,
    FormData: w.FormData,
    DOMRect:
      w.DOMRect ??
      class DOMRect {
        constructor(
          public x = 0,
          public y = 0,
          public width = 0,
          public height = 0,
        ) {}
        get top() {
          return this.y;
        }
        get left() {
          return this.x;
        }
        get right() {
          return this.x + this.width;
        }
        get bottom() {
          return this.y + this.height;
        }
        toJSON() {
          return this;
        }
      },
    MutationObserver: w.MutationObserver,
    getComputedStyle: w.getComputedStyle.bind(w),
    requestAnimationFrame: w.requestAnimationFrame.bind(w),
    cancelAnimationFrame: w.cancelAnimationFrame.bind(w),
    ResizeObserver: InertObserver,
    IntersectionObserver: InertObserver,
    matchMedia,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  w.matchMedia = matchMedia;
  w.ResizeObserver = InertObserver;
  w.IntersectionObserver = InertObserver;
  // jsdom lays nothing out, and a virtualized list over a zero-height
  // viewport renders no rows at all. A fixed box per element is enough for
  // every list to render its first rows.
  for (const [prop, value] of [
    ["offsetHeight", 600],
    ["clientHeight", 600],
    ["offsetWidth", 800],
    ["clientWidth", 800],
  ] as const) {
    Object.defineProperty(w.HTMLElement.prototype, prop, {
      configurable: true,
      get: () => value,
    });
  }
  w.HTMLElement.prototype.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 800,
    bottom: 600,
    width: 800,
    height: 600,
    toJSON() {},
  });
  w.HTMLElement.prototype.scrollIntoView ??= noop;
  w.HTMLElement.prototype.scrollTo ??= noop;
  w.scrollTo = noop;
  return {
    dom,
    close() {
      try {
        closeDomWindow(dom);
      } finally {
        restoreGlobals();
      }
    },
  };
}
