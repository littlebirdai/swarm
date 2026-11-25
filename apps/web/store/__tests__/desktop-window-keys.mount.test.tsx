import { expect, test } from "bun:test";
import { makeFunctionReference } from "convex/server";
import { act } from "react";
import { AgentDock } from "../../components/agentDock/AgentDock";
import { DesktopBadge } from "../../components/DesktopBadge";
import { ThemeProvider } from "../../components/ThemeProvider";
import { AUTH_JWT_STORAGE_KEY } from "../../lib/localAuth";
import { mountWeb } from "../../test-helpers/mountWeb";
import { pending } from "../../test-helpers/testConvex";
import { waitForDom } from "../../test-helpers/waitForDom";
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
import { flushSyncPublishes } from "../syncTransaction";

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
    const reads = new Map<string, string>();
    const observed = new Map<object, PropertyDescriptorMap>();
    let renderer: Window | undefined;
    const keys = new Set<string>([
      ...Object.keys(CLIENT_SYNC_REGISTRY),
      ...REPLICATED_STORE_KEYS,
    ]);
    const observe = (state: ReturnType<typeof useInboxStore.getState>) => {
      if (observed.has(state)) return;
      const properties: PropertyDescriptorMap = {};
      observed.set(state, properties);
      for (const key of keys) {
        const property = Object.getOwnPropertyDescriptor(state, key);
        if (!property || !("value" in property) || !property.configurable)
          continue;
        properties[key] = property;
        Object.defineProperty(state, key, {
          configurable: true,
          enumerable: property.enumerable,
          get() {
            const caller = new Error().stack?.split("\n")[2] ?? "";
            const relative = caller.split("/apps/web/")[1];
            if (
              globalThis.window === renderer &&
              relative &&
              !relative.startsWith("store/")
            )
              reads.set(key, relative.replace(/\)$/, ""));
            return property.value;
          },
        });
      }
    };
    let stop: (() => void) | undefined;
    let web: Awaited<ReturnType<typeof mountWeb>> | undefined;
    try {
      web = await mountWeb(
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
            renderer = window;
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
      const checkReads = async (declared: readonly string[]) => {
        await act(async () => {
          flushSyncPublishes();
          useInboxStore.setState({});
        });
        expect(reads.has("clientState")).toBe(true);
        expect(
          [...reads]
            .filter(([key]) => !declared.includes(key))
            .map(([key, caller]) => `${key} via ${caller}`)
            .sort(),
        ).toEqual([]);
      };
      const declared = DESKTOP_WINDOW_KEYS[windowKind];
      await checkReads(declared);
      if (windowKind === "palette") {
        reads.clear();
        const window = web.dom.window;
        await act(async () => {
          window.dispatchEvent(
            new window.CustomEvent("codecast-compose", { detail: "" }),
          );
        });
        expect(web.container.querySelector("textarea")).not.toBeNull();
        await checkReads(declared);
        for (const key of [
          "machineResources",
          "pendingMessageStatus",
          "reviewComments",
          "sessionCommands",
        ])
          expect(reads.has(key)).toBe(true);
      }
      if (windowKind === "call-panel") {
        await act(async () => web?.store.getState().openPalette());
        const container = web.container;
        await waitForDom(
          container,
          () => !!container.querySelector('[aria-label="Command menu"]'),
        );
        await checkReads([...declared, ...PALETTE_KEYS]);
      }
      expect(web.navigationLog[0]?.path).toBe(`/${windowKind}`);
    } finally {
      stop?.();
      for (const [state, properties] of observed)
        Object.defineProperties(state, properties);
      await web?.close();
    }
  });
}
