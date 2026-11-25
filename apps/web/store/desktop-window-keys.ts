import type { InboxStoreState } from "./inboxStore";

type StoreKey = Extract<keyof InboxStoreState, string>;

const appearance = [
  "activeTabId",
  "tabs",
  "clientState",
  "currentUser",
  "pendingMessages",
  "mods",
  "settingsData",
] as const;
export const FULL_STORE_DESKTOP_PANELS: readonly string[] = [
  "palette",
  "people",
  "call-panel",
  "agent-dock",
];

export const DESKTOP_WINDOW_KEYS = {
  "call-ring": [
    ...appearance,
    "teams",
    "teamMembers",
    "chatChannels",
    "chatRail",
    "guestsWaiting",
    "roomKnocks",
    "pending",
    "syncMeta",
  ],
  "meeting-offer": appearance,
  "share-cursors": appearance,
} as const satisfies Record<string, readonly StoreKey[]>;

function desktopWindowKind(): string | undefined {
  if (typeof window === "undefined" || !window.__CODECAST_ELECTRON__) return;
  return window.location.pathname.replace(/^\/|\/$/g, "");
}

export function desktopWindowKeys(): readonly StoreKey[] | undefined {
  const kind = desktopWindowKind();
  if (kind && Object.hasOwn(DESKTOP_WINDOW_KEYS, kind))
    return DESKTOP_WINDOW_KEYS[kind as keyof typeof DESKTOP_WINDOW_KEYS];
}

export function isDesktopPanel(): boolean {
  const kind = desktopWindowKind();
  return (
    !!kind &&
    (FULL_STORE_DESKTOP_PANELS.includes(kind) ||
      Object.hasOwn(DESKTOP_WINDOW_KEYS, kind))
  );
}
