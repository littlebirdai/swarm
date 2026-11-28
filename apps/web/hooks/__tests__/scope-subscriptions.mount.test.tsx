import { expect, test } from "bun:test";
import { api } from "@codecast/convex/convex/_generated/api";
import type { ReplicationChannel, ReplicationMessage } from "@platform/engine";
import { getFunctionName } from "convex/server";
import { act } from "react";
import { mountWeb } from "../../test-helpers/mountWeb";
import { useInboxStore } from "../../store/inboxStore";
import { initialScopeSubscriptionState } from "../../store/scope-subscriptions";
import { applyUpdatesToStore } from "../../store/sync-replication";
import { createScopeViewTransport } from "../../store/scope-view-transport";
import {
  floorScopeKeys,
  floorScopesStamped,
  useBootstrapCollection,
} from "../useBootstrapCollection";
import { resetInboxReplayLanes } from "../inbox-replay-lane";
import {
  useScopeSubscriptions,
  useScopedSyncChangeFeed,
} from "../use-scope-subscriptions";
import {
  catchUp,
  catchUpScope,
  createCatchUpRunner,
  useSyncChangeFeed,
} from "../use-sync-change-feed";

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

function TeamBootstrapProbe({ teamId }: { teamId: string }) {
  const { ready } = useBootstrapCollection(
    "tasks",
    api.tasks.webList,
    { workspace: "team", team_id: teamId },
    { select: (d: any) => d?.items ?? [] },
  );
  return <span data-ready={ready ? "1" : "0"} />;
}

test("useSyncChangeFeed always runs scoped without flag and revokes unauthorized project scope", async () => {
  const FeedFromEntry = () => {
    useSyncChangeFeed();
    return <span data-feed="1" />;
  };
  const { backend, clock } = await mountWeb(<FeedFromEntry />, {
    clock: true,
    setup(backend, state) {
      useInboxStore.setState({
        syncRole: "host",
        clientStateInitialized: true,
        scopeSubscriptions: initialScopeSubscriptionState(),
      });
      state.syncTable("currentUser", { _id: "viewer" });
      backend.set(
        api.syncLog.getHeads,
        ({ scopes }: { scopes?: string[] }) => ({
          authenticated: true,
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
  const headCalls = backend.queryRequests.filter(
    ({ name }) => name === getFunctionName(api.syncLog.getHeads),
  );
  expect(headCalls.length).toBeGreaterThan(0);
  for (const call of headCalls) {
    expect(Array.isArray((call.args as any).scopes)).toBe(true);
  }
  const nonTeamId = cid("non-team-task");
  useInboxStore.setState({
    syncMeta: { "synclog:v1:project:p1": { cursor: 1 } },
    tasks: { [nonTeamId]: { _id: nonTeamId, home_scope: "project:p1" } },
  } as any);
  backend.set(api.syncLog.getRange, {
    actions: [],
    nextFrom: 1,
    hasMore: false,
    authorized: false,
  });
  const purgedTeams = new Set<string>();
  await act(async () => {
    await catchUpScope(
      backend.client as any,
      { scope_key: "project:p1", position: 2, floor: 0 },
      purgedTeams,
    );
  });
  expect(
    useInboxStore.getState().syncMeta["synclog:v1:project:p1"],
  ).toBeUndefined();
  expect(useInboxStore.getState().tasks[nonTeamId]).toBeUndefined();
});

test("follower window opens no head subscriptions", async () => {
  const { backend, container } = await mountWeb(<ScopeHookProbe />, {
    setup(backend, state) {
      useInboxStore.setState({
        syncRole: "follower",
        clientStateInitialized: true,
        scopeSubscriptions: initialScopeSubscriptionState(),
      });
      state.syncTable("currentUser", { _id: "viewer" });
      state.syncTable("teams", [{ _id: "team1" }]);
      backend.set(api.syncLog.getHeads, { authenticated: true, heads: [] });
    },
  });
  expect(container.textContent).toBe("");
  expect(backend.queryRequests).toEqual([]);
});

test("team bootstrap floor opens when dir:<teamId> is stamped", async () => {
  const tBoot = cid("tboot1");
  const { backend, clock, container } = await mountWeb(
    <TeamBootstrapProbe teamId="team1" />,
    {
      clock: true,
      setup(backend, state) {
        useInboxStore.setState({
          syncRole: "host",
          clientStateInitialized: true,
          scopeSubscriptions: initialScopeSubscriptionState(),
          syncMeta: {
            "synclog:v1:user:viewer": { cursor: 1 },
            "synclog:v1:dir:team1": { cursor: 1 },
          },
          syncLogScopeStamps: {},
        } as any);
        state.syncTable("currentUser", { _id: "viewer" });
        state.syncTable("teams", [{ _id: "team1" }]);
        backend.set(
          api.syncLog.getHeads,
          ({ scopes }: { scopes?: string[] }) => ({
            authenticated: true,
            heads: (scopes ?? []).map((scope_key) => ({
              scope_key,
              position: 1,
              floor: 0,
            })),
          }),
        );
        backend.set(api.tasks.webList, {
          items: [{ _id: tBoot, title: "Boot task", workspace: "team:team1" }],
          hasMore: false,
          cursor: 0,
          isDelta: false,
        });
      },
    },
  );

  expect(
    floorScopesStamped(
      useInboxStore.getState(),
      floorScopeKeys({ workspace: "team", team_id: "team1" }, "viewer"),
    ),
  ).toBe(false);

  await act(async () => {
    useInboxStore.getState().reconcileScopeSubscriptions(1000);
    await catchUp(backend.client as any);
  });
  await clock!.advance(10);

  expect(
    floorScopesStamped(
      useInboxStore.getState(),
      floorScopeKeys({ workspace: "team", team_id: "team1" }, "viewer"),
    ),
  ).toBe(true);
  expect(container.querySelector("[data-ready='1']")).toBeTruthy();
  expect(useInboxStore.getState().tasks[tBoot]?.title).toBe("Boot task");
});

test("chunks head subscriptions by 16, wakes dirty chunk, and sweeps chunk with all scopes refused", async () => {
  const projects: Record<string, any> = {};
  const pins = Array.from({ length: 18 }, (_, i) => {
    const id = `p${String(i).padStart(2, "0")}`;
    projects[id] = { _id: id, workspace: "team:team1" };
    return { kind: "project", id, label: `Project ${i}` };
  });
  const t15 = cid("tp15");
  let positions: Record<string, number> = {
    "user:viewer": 1,
    "dir:team1": 1,
  };
  for (const pin of pins) positions[`project:${pin.id}`] = 1;

  const { backend, clock } = await mountWeb(<ScopedChangeFeedProbe />, {
    clock: true,
    setup(backend, state) {
      useInboxStore.setState({
        syncRole: "host",
        clientStateInitialized: true,
        scopeSubscriptions: initialScopeSubscriptionState(),
        projects,
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
          authenticated: true,
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
                    entity_id: t15,
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
            _id: t15,
            short_id: "ct-15",
            title: "Updated in chunk 1",
            workspace: "team:team1",
            home_scope: "project:p15",
          },
        ],
      });
    },
  });

  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  await clock!.advance(1);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  const chunked = backend.queryRequests
    .filter(({ name }) => name === getFunctionName(api.syncLog.getHeads))
    .filter(({ args }) => Array.isArray((args as any).scopes));
  expect(chunked.some(({ args }) => (args as any).scopes.length === 16)).toBe(
    true,
  );
  expect(chunked.some(({ args }) => (args as any).scopes.length === 4)).toBe(
    true,
  );

  const reqBefore = backend.queryRequests.length;
  await act(async () => {
    positions = { ...positions, "project:p15": 2 };
    backend.set(api.syncLog.getHeads, ({ scopes }: { scopes?: string[] }) => ({
      authenticated: true,
      heads: (scopes ?? []).map((scope_key) => ({
        scope_key,
        position: positions[scope_key] ?? 0,
        floor: 0,
      })),
    }));
  });
  await clock!.advance(1600);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });

  const wakeRangeScopes = backend.queryRequests
    .slice(reqBefore)
    .filter(({ name }) => name === getFunctionName(api.syncLog.getRange))
    .map(({ args }) => (args as any).scope_key);
  expect(wakeRangeScopes).toEqual(["project:p15"]);
  expect(useInboxStore.getState().tasks[t15]?.title).toBe("Updated in chunk 1");

  const chunk1 = [...useInboxStore.getState().scopeSubscriptions.chunks[1]];
  expect(chunk1.length).toBeGreaterThan(0);
  await act(async () => {
    backend.set(api.syncLog.getHeads, ({ scopes }: { scopes?: string[] }) => ({
      authenticated: true,
      heads: (scopes ?? [])
        .filter((s) => !chunk1.includes(s))
        .map((scope_key) => ({ scope_key, position: 1, floor: 0 })),
    }));
  });
  await act(async () => {
    await catchUp(backend.client as any, undefined, { scopes: chunk1 });
  });
  await flushMicrotasks();
  for (const denied of chunk1) {
    expect(
      useInboxStore.getState().scopeSubscriptions.active[denied],
    ).toBeUndefined();
    expect(
      useInboxStore.getState().scopeSubscriptions.chunks.flat(),
    ).not.toContain(denied);
  }
});

test("grace expires on visible window after 60 s, evicts without excludes, and handles follower views", async () => {
  const tView = cid("tview");
  const tUser = cid("tuser");
  const { backend, clock, store } = await mountWeb(<ScopeHookProbe />, {
    clock: true,
    setup(backend, state) {
      useInboxStore.setState({
        syncRole: "host",
        clientStateInitialized: true,
        scopeSubscriptions: initialScopeSubscriptionState(),
        projects: {
          "p-view": {
            _id: "p-view",
            title: "Project View",
            status: "active",
            created_at: 1,
            updated_at: 1,
            workspace: "team:team1",
          },
          "p-peer": {
            _id: "p-peer",
            title: "Project Peer",
            status: "active",
            created_at: 1,
            updated_at: 1,
            workspace: "team:team1",
          },
        },
        activeTabId: "tab1",
        tabs: [
          { id: "tab1", path: "/projects/p-view", title: "Project" },
        ] as any,
        tasks: {
          [tView]: { _id: tView, home_scope: "project:p-view" },
          [tUser]: { _id: tUser, home_scope: "user:viewer" },
        } as any,
      });
      state.syncTable("currentUser", { _id: "viewer" });
      backend.set(
        api.syncLog.getHeads,
        ({ scopes }: { scopes?: string[] }) => ({
          authenticated: true,
          heads: (scopes ?? []).map((scope_key) => ({
            scope_key,
            position: 1,
            floor: 0,
          })),
        }),
      );
    },
  });

  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  await clock!.advance(1);
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
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
  expect(store.getState().tasks[tView]).toBeDefined();

  await clock!.advance(1500);
  expect(
    store.getState().scopeSubscriptions.active["project:p-view"],
  ).toBeUndefined();
  expect(store.getState().tasks[tView]).toBeUndefined();
  expect(store.getState().pending[`tasks:${tView}`]).toBeUndefined();
  expect(store.getState().tasks[tUser]).toBeDefined();

  const lastHeadArgs = backend.queryRequests
    .filter(({ name }) => name === getFunctionName(api.syncLog.getHeads))
    .at(-1)?.args as { scopes?: string[] } | undefined;
  expect(lastHeadArgs?.scopes).toEqual(["user:viewer"]);

  const hostMsgs: ReplicationMessage[] = [];
  let listener: ((m: ReplicationMessage) => void) | null = null;
  const rxChannel: ReplicationChannel = {
    post(m) {
      hostMsgs.push(m);
      listener?.(m);
    },
    onMessage(cb) {
      listener = cb;
      return () => {
        listener = null;
      };
    },
  };
  const hostTransport = createScopeViewTransport({
    selfId: "host",
    channel: rxChannel,
    getState: store.getState,
    subscribe: store.subscribe,
    onPeerView: (peer, scopes) =>
      store.getState().setPeerViewScopes(peer, scopes),
    onClearPeerViews: () => store.getState().clearPeerViewScopes(),
  });
  hostTransport.startHost();
  const followerTransport = createScopeViewTransport({
    selfId: "follower-1",
    channel: rxChannel,
    getState: () =>
      ({
        ...store.getState(),
        activeTabId: "f-tab",
        tabs: [{ id: "f-tab", path: "/projects/p-peer" }],
      }) as any,
    subscribe: () => () => {},
    onPeerView() {},
    onClearPeerViews() {},
  });
  const unsub = hostTransport.channel.onMessage(() => {});
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    followerTransport.startFollowing();
    await Promise.resolve();
  });
  expect(store.getState().scopeSubscriptions.peerViews["follower-1"]).toEqual([
    "project:p-peer",
  ]);
  await act(async () => {
    followerTransport.stop();
    await Promise.resolve();
  });
  expect(
    store.getState().scopeSubscriptions.peerViews["follower-1"],
  ).toBeUndefined();
  unsub();
  hostTransport.stop();
  expect(hostMsgs.length).toBeGreaterThan(0);

  const tFollowerOpen = cid("tfolloweropen");
  await act(async () => {
    useInboxStore.setState({
      syncRole: "follower",
      activeTabId: "f-tab",
      tabs: [{ id: "f-tab", path: "/projects/p-peer" }] as any,
      tasks: {
        [tFollowerOpen]: { _id: tFollowerOpen, home_scope: "project:p-peer" },
      } as any,
    });
    applyUpdatesToStore([{ key: "tasks", removes: [tFollowerOpen] }]);
    await Promise.resolve();
  });
  expect(useInboxStore.getState().tasks[tFollowerOpen]).toBeUndefined();
});
