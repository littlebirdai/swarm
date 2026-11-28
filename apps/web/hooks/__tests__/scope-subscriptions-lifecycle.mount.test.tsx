import { afterEach, beforeEach, expect, test } from "bun:test";
import { api } from "@codecast/convex/convex/_generated/api";
import { getFunctionName } from "convex/server";
import { act } from "react";
import { mountWeb } from "../../test-helpers/mountWeb";
import { useInboxStore } from "../../store/inboxStore";
import { initialScopeSubscriptionState } from "../../store/scope-subscriptions";
import { resetInboxReplayLanes } from "../inbox-replay-lane";
import {
  applyScopeLifecycleEvent,
  scopeInputsSig,
  useScopeSubscriptions,
  useScopedSyncChangeFeed,
} from "../use-scope-subscriptions";
import { catchUpScope, createCatchUpRunner } from "../use-sync-change-feed";

const PREV_FLAG = process.env.VITE_CLIENT_SCOPE_SUBSCRIPTIONS;
const cid = (s: string) =>
  s
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase()
    .padEnd(32, "0");
const flushMicrotasks = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

function ScopeHookProbe() {
  const { activeScopes, chunks } = useScopeSubscriptions();
  return (
    <span data-count={activeScopes.length} data-chunks={chunks.length}>
      {activeScopes.join(",")}
    </span>
  );
}

function ScopedChangeFeedProbe() {
  useScopedSyncChangeFeed(createCatchUpRunner, resetInboxReplayLanes, {
    debounceMs: 1500,
    tickMs: 60_000,
  });
  return <span data-scoped-feed="1" />;
}

beforeEach(() => {
  delete process.env.VITE_CLIENT_SCOPE_SUBSCRIPTIONS;
});

afterEach(() => {
  if (PREV_FLAG === undefined) {
    delete process.env.VITE_CLIENT_SCOPE_SUBSCRIPTIONS;
  } else {
    process.env.VITE_CLIENT_SCOPE_SUBSCRIPTIONS = PREV_FLAG;
  }
});

test("account switch reconciles before runAll, scopeInputsSig stays compact, and LRU uses visits", async () => {
  process.env.VITE_CLIENT_SCOPE_SUBSCRIPTIONS = "1";
  const projects: Record<string, any> = {};
  for (let i = 0; i < 65; i++) {
    projects[`p${i}`] = {
      _id: `p${i}`,
      workspace: "team:team1",
      starred: true,
    };
  }
  const dig = scopeInputsSig({
    currentUser: { _id: "viewer" },
    teams: [{ _id: "team1" }],
    projects,
    tabs: [
      { id: "tab1", path: "/tasks/ct-77" },
      { id: "bg", path: "/projects/p60" },
    ],
    activeTabId: "tab1",
    tasks: {
      [cid("t77")]: {
        _id: cid("t77"),
        short_id: "ct-77",
        home_scope: "project:p1",
      },
    },
  });
  expect(dig.length).toBeLessThan(64);

  const tEvict = cid("tlru00");
  const tKeep = cid("tlru01");
  const pins = Array.from({ length: 63 }, (_, i) => ({
    kind: "project",
    id: `p${String(i).padStart(2, "0")}`,
    label: `Project ${i}`,
  }));
  const projMap: Record<string, any> = {
    "p-extra": { _id: "p-extra", workspace: "team:team1" },
  };
  const syncMeta: Record<string, { cursor: number }> = {
    "synclog:v1:user:viewer": { cursor: 1 },
    "synclog:v1:user:viewer-2": { cursor: 1 },
    "synclog:v1:project:p-extra": { cursor: 1 },
  };
  for (const pin of pins) {
    projMap[pin.id] = { _id: pin.id, workspace: "team:team1" };
    syncMeta[`synclog:v1:project:${pin.id}`] = { cursor: 1 };
  }

  const { backend, clock, store } = await mountWeb(<ScopedChangeFeedProbe />, {
    clock: true,
    setup(backend, state) {
      useInboxStore.setState({
        syncRole: "host",
        clientStateInitialized: true,
        scopeSubscriptions: initialScopeSubscriptionState(),
        projects: projMap,
        syncMeta: syncMeta as any,
        clientState: { ui: { sidebar_pins: pins } } as any,
        tasks: {
          [tEvict]: { _id: tEvict, home_scope: "project:p00" },
          [tKeep]: { _id: tKeep, home_scope: "project:p01" },
        } as any,
      });
      state.syncTable("currentUser", { _id: "viewer" });
      backend.set(
        api.syncLog.getHeads,
        ({ scopes }: { scopes?: string[] }) => ({
          heads: (scopes ?? []).map((scope_key) => ({
            scope_key,
            position: 1,
            floor: 0,
          })),
        }),
      );
      backend.set(api.syncLog.getRange, {
        actions: [],
        nextFrom: 1,
        hasMore: false,
      });
    },
  });

  await flushMicrotasks();
  await clock!.advance(500);
  await flushMicrotasks();
  expect(Object.keys(store.getState().scopeSubscriptions.active)).toHaveLength(
    64,
  );

  await act(async () => {
    const visits = Array.from({ length: 62 }, (_, idx) => {
      const i = idx + 1;
      return {
        kind: "view",
        key: `pj:p${String(i).padStart(2, "0")}`,
        ts: Date.now() - (62 - i),
      };
    });
    useInboxStore.setState({
      recentVisits: visits as any,
      activeTabId: "tab-new",
      tabs: [
        { id: "tab-new", path: "/projects/p-extra", title: "Extra" },
      ] as any,
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  await clock!.advance(1);
  await flushMicrotasks();
  const active = store.getState().scopeSubscriptions.active;
  expect(Object.keys(active)).toHaveLength(64);
  expect(active["project:p-extra"]).toBeDefined();
  expect(active["project:p00"]).toBeUndefined();
  expect(store.getState().tasks[tEvict]).toBeUndefined();
  expect(store.getState().tasks[tKeep]).toBeDefined();

  const reqBeforeSwitch = backend.queryRequests.length;
  await act(async () => {
    useInboxStore.setState({ currentUser: { _id: "viewer-2" } as any });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  await clock!.advance(1);
  await flushMicrotasks();
  const switchHeadCalls = backend.queryRequests
    .slice(reqBeforeSwitch)
    .filter(({ name }) => name === getFunctionName(api.syncLog.getHeads))
    .filter(({ args }) => Array.isArray((args as any).scopes));
  expect(switchHeadCalls.length).toBeGreaterThan(0);
  expect(
    switchHeadCalls.every((c) =>
      ((c.args as any).scopes as string[]).every((s) => s !== "user:viewer"),
    ),
  ).toBe(true);

  const purgedTeams = new Set<string>();
  await act(async () => {
    applyScopeLifecycleEvent(
      store.getState(),
      "scope_removed",
      "team1",
      purgedTeams,
    );
    await Promise.resolve();
  });
  expect(purgedTeams.has("team1")).toBe(true);
  await act(async () => {
    applyScopeLifecycleEvent(
      store.getState(),
      "scope_added",
      "team1",
      purgedTeams,
    );
    await Promise.resolve();
  });
  expect(purgedTeams.has("team1")).toBe(false);
});

test("module-level gate switches useSyncChangeFeed to scoped mode when flag is 1", async () => {
  process.env.VITE_CLIENT_SCOPE_SUBSCRIPTIONS = "1";
  const mod = await import(
    /* @vite-ignore */ `../use-sync-change-feed?scoped=${Date.now()}`
  );
  const ScopedFromEntry = () => {
    mod.useSyncChangeFeed();
    return <span data-entry="1" />;
  };
  const { backend, clock } = await mountWeb(<ScopedFromEntry />, {
    clock: true,
    setup(backend, state) {
      useInboxStore.setState({
        syncRole: "host",
        clientStateInitialized: true,
        scopeSubscriptions: initialScopeSubscriptionState(),
      });
      state.syncTable("currentUser", { _id: "viewer" });
      state.syncTable("teams", [{ _id: "team1" }]);
      backend.set(
        api.syncLog.getHeads,
        ({ scopes }: { scopes?: string[] }) => ({
          heads: (scopes ?? []).map((scope_key) => ({
            scope_key,
            position: 1,
            floor: 0,
          })),
        }),
      );
      backend.set(api.syncLog.getRange, {
        actions: [],
        nextFrom: 1,
        hasMore: false,
      });
    },
  });
  await flushMicrotasks();
  await clock!.advance(1);
  await flushMicrotasks();
  const scopedHeadCalls = backend.queryRequests
    .filter(({ name }) => name === getFunctionName(api.syncLog.getHeads))
    .filter(({ args }) => Array.isArray((args as any).scopes));
  expect(scopedHeadCalls.length).toBeGreaterThan(0);
  expect(
    backend.queryRequests.some(
      ({ name, args }) =>
        name === getFunctionName(api.syncLog.getHeads) &&
        !Array.isArray((args as any).scopes),
    ),
  ).toBe(false);
});

test("whileWindowVisible pauses grace timer when hidden and handles project/dir unauthorized under flag", async () => {
  process.env.VITE_CLIENT_SCOPE_SUBSCRIPTIONS = "1";
  const tView = cid("thiddenview");
  const tTeam = cid("tdirteam");
  const { backend, clock, store } = await mountWeb(<ScopeHookProbe />, {
    clock: true,
    setup(backend, state) {
      useInboxStore.setState({
        syncRole: "host",
        clientStateInitialized: true,
        scopeSubscriptions: initialScopeSubscriptionState(),
        projects: {
          "p-hid": { _id: "p-hid", workspace: "team:team1" },
          "p-auth": { _id: "p-auth", workspace: "team:team1" },
        },
        activeTabId: "tab1",
        tabs: [
          { id: "tab1", path: "/projects/p-hid", title: "Hidden Proj" },
        ] as any,
        tasks: {
          [tView]: { _id: tView, home_scope: "project:p-hid" },
          [tTeam]: {
            _id: tTeam,
            workspace: "team:team1",
            home_scope: "dir:team1",
          },
        } as any,
        syncMeta: {
          "synclog:v1:dir:team1": { cursor: 1 },
          "synclog:v1:team:team1": { cursor: 1 },
          "synclog:v1:project:p-auth": { cursor: 1 },
        },
      });
      state.syncTable("currentUser", { _id: "viewer" });
      backend.set(
        api.syncLog.getHeads,
        ({ scopes }: { scopes?: string[] }) => ({
          heads: (scopes ?? []).map((scope_key) => ({
            scope_key,
            position: 1,
            floor: 0,
          })),
        }),
      );
    },
  });

  await flushMicrotasks();
  await clock!.advance(1);
  await flushMicrotasks();

  const prevHiddenDesc = Object.getOwnPropertyDescriptor(document, "hidden");
  let hidden = false;
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => hidden,
  });
  try {
    await act(async () => {
      useInboxStore.setState({
        tabs: [{ id: "tab1", path: "/inbox", title: "Inbox" }] as any,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    hidden = true;
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    await clock!.advance(65_000);
    expect(
      store.getState().scopeSubscriptions.active["project:p-hid"],
    ).toBeDefined();
    expect(store.getState().tasks[tView]).toBeDefined();

    hidden = false;
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(
      store.getState().scopeSubscriptions.active["project:p-hid"],
    ).toBeUndefined();
    expect(store.getState().tasks[tView]).toBeUndefined();
  } finally {
    if (prevHiddenDesc) {
      Object.defineProperty(document, "hidden", prevHiddenDesc);
    } else {
      delete (document as any).hidden;
    }
  }

  await act(async () => {
    useInboxStore.getState().reconcileScopeSubscriptions(Date.now());
    backend.set(api.syncLog.getRange, {
      actions: [],
      nextFrom: 1,
      hasMore: false,
      authorized: false,
    });
    await Promise.resolve();
  });
  const purgedTeams = new Set<string>();
  await act(async () => {
    await catchUpScope(
      backend.client as any,
      { scope_key: "dir:team1", position: 2, floor: 0 },
      purgedTeams,
    );
    await catchUpScope(
      backend.client as any,
      { scope_key: "project:p-auth", position: 2, floor: 0 },
      purgedTeams,
    );
    await Promise.resolve();
  });
  expect(purgedTeams.has("team1")).toBe(true);
  expect(store.getState().syncMeta["synclog:v1:dir:team1"]).toBeUndefined();
  expect(store.getState().syncMeta["synclog:v1:team:team1"]).toBeUndefined();
  expect(
    store.getState().syncMeta["synclog:v1:project:p-auth"],
  ).toBeUndefined();
  expect(
    store.getState().scopeSubscriptions.denied["project:p-auth"],
  ).toBeDefined();
  expect(store.getState().tasks[tTeam]).toBeUndefined();
});
