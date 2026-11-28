import {
  installSignedInPrincipal,
  TEST_PRINCIPAL,
} from "./fixtures/signedInPrincipal";
import { expect, test } from "bun:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { makeFunctionReference } from "convex/server";
import { act } from "react";
import { AgentDock } from "../../components/agentDock/agent-dock";
import { Providers } from "../../src/providers";
import { replaceGlobals } from "../../test-helpers/globals";
import { mountWeb } from "../../test-helpers/mountWeb";
import { pending } from "../../test-helpers/testConvex";
import { waitForDom } from "../../test-helpers/waitForDom";
import { HYDRATION_PAINT_KEYS } from "../clientSyncRegistry";
import { DESKTOP_WINDOW_KEYS, desktopWindowKeys } from "../desktop-panel-keys";
import { cacheStorage } from "../idb-cache";
import {
  clearProtectedInboxMemory,
  rebootPersistence,
  useInboxStore,
} from "../inboxStore";
import { _reopenForTests, db } from "../persistence/db";
import * as hydration from "../persistence/hydration";
import { writeOwnerStamp } from "../persistence/ownership";
import { session } from "./bucketFixtures";

const queries = [
  "assistant/incidents:thinkingAvailable",
  "agentTasks:webList",
  "client_state:get",
  "conversations:listFavoriteSessions",
  "conversations:listInboxSessions",
  "conversations:listRecentSessions",
  "conversations:sessionsLiveness",
  "devices:listDevices",
  "docs:webMentionList",
  "teamHosts:list",
  "teams:getUserTeams",
  "users:getCurrentUser",
  "users:getRecentProjectPaths",
];

type Released = {
  session: boolean;
  conversation: boolean;
  lastFocusedConversationId: string | null;
};

test("an agent dock window paints only after its scoped critical cache loads", async () => {
  const sessionId = "d".repeat(32);
  const cachedSession = session(sessionId, {
    title: "Cached dock card",
    is_idle: false,
  });
  const panelKeys: readonly string[] = DESKTOP_WINDOW_KEYS["agent-dock"];
  expect(panelKeys).toContain("sessions");
  expect(panelKeys).toContain("conversations");
  expect(HYDRATION_PAINT_KEYS).toContain("lastFocusedConversationId");
  expect(panelKeys).not.toContain("lastFocusedConversationId");

  const originalFlag = process.env.VITE_DESKTOP_PANEL_SCOPE;
  let released: Released | null = null;
  let stopWatching: (() => void) | undefined;
  let restoreEvents: (() => void) | undefined;
  let web: Awaited<ReturnType<typeof mountWeb>> | undefined;
  try {
    const AgentDockPage = (await import("../../app/agent-dock/page")).default;
    web = await mountWeb(
      <Providers>
        <AgentDockPage />
        <AgentDock />
      </Providers>,
      {
        authenticated: true,
        dispatch: true,
        path: "/agent-dock",
        setup(backend) {
          backend.mutation(
            makeFunctionReference<"mutation">("dispatch:dispatch"),
            undefined,
          );
          backend.mutation(
            makeFunctionReference<"mutation">("pushRouter:reportPresence"),
            undefined,
          );
          for (const query of queries)
            backend.set(makeFunctionReference<"query">(query), pending);
          backend.set(makeFunctionReference<"query">("notifications:list"), []);
          Object.defineProperty(window, "__CODECAST_ELECTRON__", {
            configurable: true,
            value: {
              isAgentDockWindow: true,
              onWindowRole: () => {},
              setBadgeCount: () => {},
              showNotification: () => ({ shown: true }),
            },
          });
          process.env.VITE_DESKTOP_PANEL_SCOPE = "1";
          installSignedInPrincipal(TEST_PRINCIPAL);
        },
      },
    );
    expect(desktopWindowKeys()).toBe(DESKTOP_WINDOW_KEYS["agent-dock"]);
    restoreEvents = replaceGlobals({
      dispatchEvent: web.dom.window.dispatchEvent.bind(web.dom.window),
    });

    await _reopenForTests({ indexedDB: new IDBFactory(), IDBKeyRange });
    await db.meta.put({ key: "currentUser", value: { _id: TEST_PRINCIPAL } });
    await writeOwnerStamp(TEST_PRINCIPAL, "test-fixture");
    const seeded = {
      currentUser: { _id: TEST_PRINCIPAL },
      sessions: { [sessionId]: cachedSession },
      conversations: { [sessionId]: cachedSession },
      liveInboxIdList: [sessionId],
      lastFocusedConversationId: sessionId,
    };
    cacheStorage.setHydrating(false);
    cacheStorage.writePatches(
      (Object.keys(seeded) as (keyof typeof seeded)[])
        .filter((key) => key !== "currentUser")
        .map((key) => ({ op: "replace", path: [key], value: seeded[key] })),
      seeded,
    );
    await cacheStorage.flushPersistence();

    await act(async () => {
      clearProtectedInboxMemory();
      useInboxStore.setState({
        clientStateInitialized: false,
        syncRole: "follower",
      });
      stopWatching = useInboxStore.subscribe((state) => {
        if (released || !state.clientStateInitialized) return;
        released = {
          session: Boolean(state.sessions[sessionId]),
          conversation: Boolean(state.conversations[sessionId]),
          lastFocusedConversationId: state.lastFocusedConversationId,
        };
      });
      rebootPersistence();
    });

    const body = web.dom.window.document.body;
    await act(async () => {
      await waitForDom(
        body,
        () => !!body.querySelector('[title="Cached dock card"]'),
      );
      const deadline = Date.now() + 2000;
      while (hydration._hydrating && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(hydration._hydrating).toBe(false);
    expect(released).toEqual({
      session: true,
      conversation: true,
      lastFocusedConversationId: null,
    });
    expect(useInboxStore.getState().lastFocusedConversationId).toBeNull();
  } finally {
    stopWatching?.();
    await web?.close();
    restoreEvents?.();
    if (originalFlag === undefined) delete process.env.VITE_DESKTOP_PANEL_SCOPE;
    else process.env.VITE_DESKTOP_PANEL_SCOPE = originalFlag;
  }
});
