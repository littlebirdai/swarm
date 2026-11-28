import { afterEach, beforeEach, expect, test } from "bun:test";
import { api } from "@codecast/convex/convex/_generated/api";
import { getFunctionName } from "convex/server";
import { act } from "react";
import { mountWeb } from "../../test-helpers/mountWeb";
import { useInboxStore } from "../../store/inboxStore";
import { initialScopeSubscriptionState } from "../../store/scope-subscriptions";
import { useScopeSubscriptions } from "../use-scope-subscriptions";
import { useSyncChangeFeed } from "../use-sync-change-feed";

const PREV_FLAG = process.env.VITE_CLIENT_SCOPE_SUBSCRIPTIONS;

function ScopeHookProbe() {
  const { activeScopes, chunks } = useScopeSubscriptions();
  return (
    <span data-count={activeScopes.length} data-chunks={chunks.length}>
      {activeScopes.join(",")}
    </span>
  );
}

function ChangeFeedProbe() {
  useSyncChangeFeed();
  return <span data-feed="1" />;
}

beforeEach(() => {
  delete process.env.VITE_CLIENT_SCOPE_SUBSCRIPTIONS;
});

afterEach(() => {
  if (PREV_FLAG === undefined)
    delete process.env.VITE_CLIENT_SCOPE_SUBSCRIPTIONS;
  else process.env.VITE_CLIENT_SCOPE_SUBSCRIPTIONS = PREV_FLAG;
});

test("flag off subscribes to nothing in useScopeSubscriptions", async () => {
  const { backend, container } = await mountWeb(<ScopeHookProbe />, {
    setup(backend, state) {
      useInboxStore.setState({
        syncRole: "host",
        clientStateInitialized: true,
        scopeSubscriptions: initialScopeSubscriptionState(),
      });
      state.syncTable("currentUser", { _id: "viewer" });
      state.syncTable("teams", [{ _id: "team1" }]);
      backend.set(api.syncLog.getHeads, { heads: [] });
    },
  });
  expect(container.textContent).toBe("");
  expect(backend.queryRequests).toEqual([]);
});

test("flag off leaves legacy getHeads unchanged in useSyncChangeFeed", async () => {
  const { backend } = await mountWeb(<ChangeFeedProbe />, {
    setup(backend, state) {
      useInboxStore.setState({
        syncRole: "host",
        clientStateInitialized: true,
        scopeSubscriptions: initialScopeSubscriptionState(),
      });
      state.syncTable("currentUser", { _id: "viewer" });
      backend.set(api.syncLog.getHeads, { heads: [] });
    },
  });
  const headCalls = backend.queryRequests.filter(
    ({ name }) => name === getFunctionName(api.syncLog.getHeads),
  );
  expect(headCalls.length).toBeGreaterThan(0);
  for (const call of headCalls) {
    expect(call.args).toEqual({});
  }
});

test("follower window opens no head subscriptions when the flag is on", async () => {
  process.env.VITE_CLIENT_SCOPE_SUBSCRIPTIONS = "1";
  const { backend, container } = await mountWeb(<ScopeHookProbe />, {
    setup(backend, state) {
      useInboxStore.setState({
        syncRole: "follower",
        clientStateInitialized: true,
        scopeSubscriptions: initialScopeSubscriptionState(),
      });
      state.syncTable("currentUser", { _id: "viewer" });
      state.syncTable("teams", [{ _id: "team1" }]);
      backend.set(api.syncLog.getHeads, { heads: [] });
    },
  });
  expect(container.textContent).toBe("");
  expect(backend.queryRequests).toEqual([]);
});

test("sync host chunks head subscriptions by 16 and wakes only the dirty chunk", async () => {
  process.env.VITE_CLIENT_SCOPE_SUBSCRIPTIONS = "1";
  const pins = Array.from({ length: 18 }, (_, i) => ({
    kind: "project",
    id: `p${String(i).padStart(2, "0")}`,
    label: `Project ${i}`,
  }));
  let positions: Record<string, number> = {
    "user:viewer": 1,
    "dir:team1": 1,
  };
  for (const pin of pins) positions[`project:${pin.id}`] = 1;

  const { backend, clock } = await mountWeb(<ChangeFeedProbe />, {
    clock: true,
    setup(backend, state) {
      useInboxStore.setState({
        syncRole: "host",
        clientStateInitialized: true,
        scopeSubscriptions: initialScopeSubscriptionState(),
        clientState: { ui: { sidebar_pins: pins } } as any,
      });
      state.syncTable("currentUser", { _id: "viewer" });
      state.syncTable("teams", [{ _id: "team1" }]);
      for (const scope of Object.keys(positions)) {
        state.recordSyncMeta(`synclog:v1:${scope}`, { cursor: 1 });
      }
      backend.set(
        api.syncLog.getHeads,
        ({ scopes }: { scopes?: string[] }) => ({
          heads: (scopes ?? []).map((scope_key) => ({
            scope_key,
            position: positions[scope_key] ?? 0,
            floor: 0,
          })),
        }),
      );
      backend.set(
        api.syncLog.getRange,
        ({ scope_key }: { scope_key: string }) => ({
          actions:
            scope_key === "project:p15"
              ? [
                  {
                    position: 2,
                    entity_type: "tasks",
                    entity_id: "t-p15",
                    op: "upsert" as const,
                    patch: { title: "Updated in chunk 1" },
                  },
                ]
              : [],
          nextFrom: positions[scope_key] ?? 1,
          hasMore: false,
        }),
      );
      backend.set(api.tasks.webGetByIds, {
        items: [
          {
            _id: "t-p15",
            short_id: "ct-15",
            title: "Updated in chunk 1",
            workspace: "team:team1",
            home_scope: "project:p15",
          },
        ],
      });
    },
  });

  await clock!.advance(1);
  const initialHeadReqs = backend.queryRequests.filter(
    ({ name }) => name === getFunctionName(api.syncLog.getHeads),
  );
  const chunked = initialHeadReqs.filter(({ args }) =>
    Array.isArray((args as any).scopes),
  );
  expect(chunked.length).toBeGreaterThanOrEqual(2);
  expect(chunked.some(({ args }) => (args as any).scopes.length === 16)).toBe(
    true,
  );
  expect(chunked.some(({ args }) => (args as any).scopes.length === 4)).toBe(
    true,
  );

  const reqCountBeforeWake = backend.queryRequests.length;
  await act(async () => {
    positions = { ...positions, "project:p15": 2 };
    backend.set(api.syncLog.getHeads, ({ scopes }: { scopes?: string[] }) => ({
      heads: (scopes ?? []).map((scope_key) => ({
        scope_key,
        position: positions[scope_key] ?? 0,
        floor: 0,
      })),
    }));
  });
  await clock!.advance(1600);

  const wakeReqs = backend.queryRequests.slice(reqCountBeforeWake);
  const wakeRangeScopes = wakeReqs
    .filter(({ name }) => name === getFunctionName(api.syncLog.getRange))
    .map(({ args }) => (args as any).scope_key);
  expect(wakeRangeScopes).toEqual(["project:p15"]);
  expect(useInboxStore.getState().tasks["t-p15"]?.title).toBe(
    "Updated in chunk 1",
  );
});

test("grace expires after 60 s, unsubscribes the view scope, and purges its unheld rows", async () => {
  process.env.VITE_CLIENT_SCOPE_SUBSCRIPTIONS = "1";
  const { backend, clock, store } = await mountWeb(<ScopeHookProbe />, {
    clock: true,
    setup(backend, state) {
      useInboxStore.setState({
        syncRole: "host",
        clientStateInitialized: true,
        scopeSubscriptions: initialScopeSubscriptionState(),
        activeTabId: "tab1",
        tabs: [
          { id: "tab1", path: "/projects/p-view", title: "Project" },
        ] as any,
        tasks: {
          tView: { _id: "tView", home_scope: "project:p-view" },
          tUser: { _id: "tUser", home_scope: "user:viewer" },
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
    },
  });

  await clock!.advance(1);
  expect(
    store.getState().scopeSubscriptions.active["project:p-view"],
  ).toBeDefined();

  await act(async () => {
    useInboxStore.setState({
      tabs: [{ id: "tab1", path: "/inbox", title: "Inbox" }] as any,
    });
  });

  await clock!.advance(59_000);
  expect(
    store.getState().scopeSubscriptions.active["project:p-view"],
  ).toBeDefined();
  expect(store.getState().tasks.tView).toBeDefined();

  await clock!.advance(1500);
  expect(
    store.getState().scopeSubscriptions.active["project:p-view"],
  ).toBeUndefined();
  expect(store.getState().tasks.tView).toBeUndefined();
  expect(store.getState().tasks.tUser).toBeDefined();

  const lastHeadArgs = backend.queryRequests
    .filter(({ name }) => name === getFunctionName(api.syncLog.getHeads))
    .at(-1)?.args as { scopes?: string[] } | undefined;
  expect(lastHeadArgs?.scopes).toEqual(["user:viewer"]);
});

test("evicts least recently used scope past 64 and purges its rows in mount harness", async () => {
  process.env.VITE_CLIENT_SCOPE_SUBSCRIPTIONS = "1";
  const pins = Array.from({ length: 63 }, (_, i) => ({
    kind: "project",
    id: `p${String(i).padStart(2, "0")}`,
    label: `Project ${i}`,
  }));
  const { clock, store } = await mountWeb(<ScopeHookProbe />, {
    clock: true,
    setup(backend, state) {
      useInboxStore.setState({
        syncRole: "host",
        clientStateInitialized: true,
        scopeSubscriptions: initialScopeSubscriptionState(),
        clientState: { ui: { sidebar_pins: pins } } as any,
        tasks: {
          tEvict: { _id: "tEvict", home_scope: "project:p00" },
          tKeep: { _id: "tKeep", home_scope: "project:p01" },
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
    },
  });

  await clock!.advance(1);
  expect(Object.keys(store.getState().scopeSubscriptions.active)).toHaveLength(
    64,
  );

  await act(async () => {
    for (let i = 1; i < 63; i++) {
      store
        .getState()
        .touchScopeSubscription(
          `project:p${String(i).padStart(2, "0")}`,
          Date.now() + i,
        );
    }
    useInboxStore.setState({
      activeTabId: "tab-new",
      tabs: [
        { id: "tab-new", path: "/projects/p-extra", title: "Extra" },
      ] as any,
    });
  });

  await clock!.advance(1);
  const active = store.getState().scopeSubscriptions.active;
  expect(Object.keys(active)).toHaveLength(64);
  expect(active["project:p-extra"]).toBeDefined();
  expect(active["project:p00"]).toBeUndefined();
  expect(store.getState().tasks.tEvict).toBeUndefined();
  expect(store.getState().tasks.tKeep).toBeDefined();
});
