import { expect, test } from "bun:test";
import { makeFunctionReference } from "convex/server";
import { act } from "react";
import { AgentDock } from "../../components/agentDock/AgentDock";
import { DesktopBadge } from "../../components/DesktopBadge";
import { ThemeProvider } from "../../components/ThemeProvider";
import { AUTH_JWT_STORAGE_KEY } from "../../lib/localAuth";
import { mountWeb } from "../../test-helpers/mountWeb";
import { pending } from "../../test-helpers/testConvex";
import {
  DESKTOP_WINDOW_KEYS,
  PALETTE_KEYS,
  desktopWindowKeys,
} from "../desktop-window-keys";
import {
  CLIENT_SYNC_REGISTRY,
  REPLICATED_STORE_KEYS,
} from "../clientSyncRegistry";
import { useInboxStore } from "../inboxStore";

const windows = {
  palette: () => import("../../app/palette/page"),
  people: () => import("../../app/people/page"),
  "call-panel": () => import("../../app/call-panel/page"),
  "agent-dock": () => import("../../app/agent-dock/page"),
  "call-ring": () => import("../../app/call-ring/page"),
  "meeting-offer": () => import("../../app/meeting-offer/page"),
  "share-cursors": () => import("../../app/share-cursors/page"),
} as const;

const queries = [
  "org:roles",
  "users:getMySkills",
  "devices:listDevices",
  "users:getRecentProjectPaths",
  "teamHosts:list",
  "agentTasks:webList",
  "assistant/incidents:thinkingAvailable",
  "bookmarks:listBookmarks",
  "calls:getCallConfig",
  "client_state:get",
  "conversations:listFavoriteSessions",
  "conversations:listInboxSessions",
  "conversations:listRecentSessions",
  "conversations:sessionsLiveness",
  "docs:webMentionList",
  "teams:getUserTeams",
  "users:getCurrentUser",
];

for (const windowKind of Object.keys(windows) as (keyof typeof windows)[]) {
  test(`${windowKind} store reads`, async () => {
    const Page = (await windows[windowKind]()).default;
    const reads = new Set<string>();
    const keys = new Set<string>([
      ...Object.keys(CLIENT_SYNC_REGISTRY),
      ...REPLICATED_STORE_KEYS,
    ]);
    const observe = (state: ReturnType<typeof useInboxStore.getState>) => {
      for (const key of keys) {
        const property = Object.getOwnPropertyDescriptor(state, key);
        if (!property || !("value" in property) || !property.configurable)
          continue;
        Object.defineProperty(state, key, {
          configurable: true,
          enumerable: property.enumerable,
          get() {
            const caller = new Error().stack?.split("\n")[2] ?? "";
            if (caller.includes("/apps/web/") && !caller.includes("/store/"))
              reads.add(key);
            return property.value;
          },
        });
      }
    };
    let stop: (() => void) | undefined;
    try {
      const web = await mountWeb(
        <ThemeProvider>
          <Page />
          {windowKind === "agent-dock" && <AgentDock />}
          {DESKTOP_WINDOW_KEYS[windowKind].some(
            (key) => key === "sessions",
          ) && <DesktopBadge />}
        </ThemeProvider>,
        {
          authenticated: true,
          path: `/${windowKind}`,
          setup(backend) {
            backend.mutation(
              makeFunctionReference<"mutation">("dispatch:dispatch"),
              undefined,
            );
            for (const query of queries)
              backend.set(makeFunctionReference<"query">(query), pending);
            Object.defineProperty(window, "__CODECAST_ELECTRON__", {
              value: {},
            });
            expect(desktopWindowKeys()).toBe(DESKTOP_WINDOW_KEYS[windowKind]);
            localStorage.setItem(AUTH_JWT_STORAGE_KEY, "fixture-jwt");
            useInboxStore.setState({
              clientStateInitialized: true,
              syncRole: "follower",
            });
            observe(useInboxStore.getState());
            stop = useInboxStore.subscribe(observe);
          },
        },
      );
      if (windowKind === "palette")
        await act(async () =>
          window.dispatchEvent(
            new CustomEvent("codecast-compose", { detail: "" }),
          ),
        );
      expect(reads.has("clientState")).toBe(true);
      const declared = new Set<string>(DESKTOP_WINDOW_KEYS[windowKind]);
      expect([...reads].filter((key) => !declared.has(key)).sort()).toEqual([]);
      if (windowKind === "call-panel") {
        await act(async () => web.store.getState().openPalette());
        const expanded = new Set<string>([...declared, ...PALETTE_KEYS]);
        expect([...reads].filter((key) => !expanded.has(key)).sort()).toEqual(
          [],
        );
      }
      stop?.();
      await web.close();
      expect(web.navigationLog[0]?.path).toBe(`/${windowKind}`);
    } finally {
      stop?.();
    }
  });
}
