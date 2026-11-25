import { expect, test } from "bun:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { JSDOM } from "jsdom";
import { closeDomWindow } from "../../test-helpers/domGlobals";
import { replaceGlobals } from "../../test-helpers/globals";
import { AUTH_JWT_STORAGE_KEY, issueFakeToken } from "./fixtures/fakeAuthToken";
import { session } from "./bucketFixtures";

test("warm spare claim and scoped hydration gate replication, then sign-out clears the badge", async () => {
  const dom = new JSDOM("<div id='root'></div>", {
    url: "https://codecast.sh/inbox",
  });
  const { window } = dom;
  let pushRole!: (role: { spare?: boolean }) => void;
  const badgeCounts: number[] = [];
  Object.assign(window, {
    __CODECAST_ELECTRON__: {
      isWarmSpare: true,
      onWindowRole: (cb: typeof pushRole) => {
        pushRole = cb;
      },
      setBadgeCount: async (count: number) => {
        badgeCounts.push(count);
      },
    },
  });
  window.localStorage.setItem(AUTH_JWT_STORAGE_KEY, issueFakeToken("userA"));
  const channels: string[] = [];
  const locks: string[] = [];
  const restore = replaceGlobals({
    window,
    document: window.document,
    navigator: {
      userAgent: window.navigator.userAgent,
      locks: {
        request: (
          name: string,
          _options: unknown,
          grant: () => Promise<void>,
        ) => {
          locks.push(name);
          return Promise.resolve().then(grant);
        },
      },
    },
    localStorage: window.localStorage,
    indexedDB: new IDBFactory(),
    IDBKeyRange,
    IS_REACT_ACT_ENVIRONMENT: true,
    BroadcastChannel: class extends EventTarget {
      constructor(name: string) {
        super();
        channels.push(name);
      }
      postMessage() {}
      close() {}
    },
  });

  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { db } = await import("../persistence/db");
  const hydration = await import("../persistence/hydration");
  const { installWindowRoleTracker } = await import("../../lib/desktop");
  const { useInboxStore, rebootPersistence } = await import("../inboxStore");
  const { useIsSyncHost, useSyncReplication } =
    await import("../../hooks/use-sync-role");
  const { replicationChannelName, replicationLockName } =
    await import("../storage-transport");
  const { DesktopBadge } = await import("../../components/DesktopBadge");
  const { installAuthPrincipalBoundary } = await import("../principalBoundary");
  const { durableAuthStorage } = await import("../../lib/durableAuthStorage");
  const stopAuthBoundary = installAuthPrincipalBoundary();

  function Feeders() {
    useSyncReplication(true);
    return useIsSyncHost() ? <span>Host feeders</span> : null;
  }

  const container = window.document.getElementById("root")!;
  const root = createRoot(container);
  try {
    await db.meta.put({ key: "currentUser", value: { _id: "userA" } });
    await db.meta.put({
      key: "cacheOwner",
      value: { principal: "userA", at: 1, reason: "seed" },
    });
    const id = "a".repeat(32);
    await db.table("sessions").put(
      session(id, {
        session_id: "cached",
        user_id: "userA",
        awaiting_input: true,
      }),
    );
    db.close({ disableAutoOpen: false });

    installWindowRoleTracker();
    await act(async () => {
      root.render(
        <>
          <Feeders />
          <DesktopBadge />
        </>,
      );
    });
    pushRole({ spare: true });
    pushRole({});
    rebootPersistence();
    expect(db.isOpen()).toBe(false);
    expect(useInboxStore.getState().clientStateInitialized).toBe(false);
    expect(useInboxStore.getState().sessions).toEqual({});
    expect(container.textContent).toBe("");
    expect(
      channels.some((name) => name.startsWith(replicationChannelName("userA"))),
    ).toBe(false);
    expect(locks).toEqual([]);
    expect(badgeCounts).toEqual([]);

    await act(async () => {
      pushRole({ spare: false });
      const deadline = performance.now() + 2_000;
      while (hydration._hydrating && performance.now() < deadline)
        await Bun.sleep(1);
    });
    expect(hydration._hydrating).toBe(false);
    expect(useInboxStore.getState().clientStateInitialized).toBe(true);
    expect(useInboxStore.getState().sessions[id]?.session_id).toBe("cached");
    expect(channels).toContain(replicationChannelName("userA"));
    expect(locks).toEqual([replicationLockName("userA")]);
    expect(container.textContent).toBe("Host feeders");
    expect(badgeCounts).toEqual([1]);

    await act(async () => root.render(null));
    dom.reconfigure({ url: "https://codecast.sh/palette" });
    const scoped = `${replicationChannelName("userA")}:scope`;
    await act(async () => {
      useInboxStore.setState({ clientStateInitialized: false });
      root.render(<Feeders />);
    });
    expect(channels.some((name) => name.startsWith(`${scoped}:`))).toBe(false);
    await act(async () => {
      useInboxStore.setState({ clientStateInitialized: true });
      root.render(
        <>
          <Feeders />
          <DesktopBadge />
        </>,
      );
    });
    expect(channels.some((name) => name.startsWith(`${scoped}:`))).toBe(true);
    expect(locks).toEqual([replicationLockName("userA")]);
    expect(badgeCounts.splice(0)).toEqual([1, 1]);

    await act(async () => {
      durableAuthStorage.removeItem(AUTH_JWT_STORAGE_KEY);
    });
    expect(useInboxStore.getState().clientStateInitialized).toBe(false);
    expect(badgeCounts).toEqual([0]);
  } finally {
    await act(async () => {
      root.unmount();
    });
    stopAuthBoundary();
    db.close();
    closeDomWindow(dom);
    restore();
  }
});
