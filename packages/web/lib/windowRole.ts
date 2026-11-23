// Which desktop window this renderer is, for code that must stay free of the
// desktop bridge's imports (the phone bundle reaches some of its callers).
// Outside a browser every answer is the plain app window.

export function windowStorePolicy(role: "spare" | "regular", claimed: boolean) {
  const active = role === "regular" || claimed;
  return { mayHost: active, shouldHydrate: active };
}

let warmSpareClaimed = false;
const storeStartListeners = new Set<() => void>();

export function getWindowStorePolicy() {
  const spare = typeof window !== "undefined" && window.__CODECAST_ELECTRON__?.isWarmSpare === true;
  return windowStorePolicy(spare ? "spare" : "regular", warmSpareClaimed);
}

/** The preload flag covers boot. Only an explicit shell role can end standby,
 *  including on reload of a window built with the original spare flag. */
export function applyWarmSpareRole(spare: unknown): void {
  if (spare !== false || getWindowStorePolicy().shouldHydrate) return;
  warmSpareClaimed = true;
  for (const start of storeStartListeners) start();
  storeStartListeners.clear();
}

export function subscribeWindowStoreStart(start: () => void): () => void {
  if (!getWindowStorePolicy().shouldHydrate) storeStartListeners.add(start);
  return () => { storeStartListeners.delete(start); };
}

/** This renderer IS the call panel: it hosts the call and draws the stage. */
export function isCallPanelWindow(): boolean {
  return typeof window !== "undefined" && window.__CODECAST_ELECTRON__?.isCallPanelWindow === true;
}

/** This renderer is the command palette's window. */
export function isPaletteWindow(): boolean {
  return typeof window !== "undefined" && !!window.location?.pathname?.startsWith("/palette");
}

export function getWindowRole() {
  if (isCallPanelWindow()) return "call_panel";
  if (isPaletteWindow()) return "palette";
  const shell = typeof window === "undefined" ? undefined : window.__CODECAST_ELECTRON__;
  if (shell?.isPeopleWindow) return "people";
  if (shell?.isTransparentWindow) return "auxiliary";
  if (shell?.isTabWindow) return "tab";
  return "app";
}

/** Whether this window ever draws a conversation's transcript: the palette and
 *  the call panel never do, so they keep no message cache warm. */
export function windowDrawsTranscripts(): boolean {
  return !isCallPanelWindow() && !isPaletteWindow();
}

// Desktop windows run with background throttling off (the live socket must
// keep delivering while a window sits unfocused), which in Electron also pins
// document.visibilityState at "visible". A minimized window, one on another
// desktop, or the warm spare then read as on screen, and every "skip this
// while hidden" check in the app ran anyway. The shell knows which windows are
// shown and says so in the window role; this makes the document report it and
// announce each change the way a browser does. Timers stay unthrottled.
let shellShown: boolean | null = null;
let shellVisibilityInstalled = false;

export function applyShellVisibility(shown: boolean | null): void {
  if (typeof document === "undefined" || shown === null || shown === shellShown) return;
  if (!shellVisibilityInstalled) {
    shellVisibilityInstalled = true;
    const proto = Object.getPrototypeOf(document);
    const nativeState = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState") ?? Object.getOwnPropertyDescriptor(proto, "visibilityState");
    const nativeHidden = Object.getOwnPropertyDescriptor(Document.prototype, "hidden") ?? Object.getOwnPropertyDescriptor(proto, "hidden");
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get() { return shellShown === false ? "hidden" : nativeState?.get?.call(document) ?? "visible"; },
    });
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get() { return shellShown === false ? true : nativeHidden?.get?.call(document) ?? false; },
    });
  }
  const was = document.visibilityState;
  shellShown = shown;
  if (document.visibilityState !== was) document.dispatchEvent(new Event("visibilitychange"));
}
