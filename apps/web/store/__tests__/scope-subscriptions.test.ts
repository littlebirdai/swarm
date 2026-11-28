import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useInboxStore } from "../inboxStore";
import {
  SCOPE_FOLLOW_WINDOW_MS,
  SCOPE_HEADS_CHUNK_SIZE,
  SCOPE_SUBSCRIPTION_BUDGET,
  SCOPE_VIEW_GRACE_MS,
  clientScopeSubscriptionsEnabled,
  computePurgeSet,
  extractScopeCandidates,
  initialScopeSubscriptionState,
  reconcileScopeSubscriptions,
  rowHomeScope,
  touchScopeSubscriptionInState,
} from "../scope-subscriptions";

const PREV_FLAG = process.env.VITE_CLIENT_SCOPE_SUBSCRIPTIONS;

beforeEach(() => {
  delete process.env.VITE_CLIENT_SCOPE_SUBSCRIPTIONS;
  useInboxStore.setState({
    currentUser: null,
    teams: [],
    projects: {},
    viewerRoles: {},
    chatChannels: {},
    chatReads: {},
    chatRail: [],
    clientState: { ui: {} } as any,
    clientStateInitialized: false,
    recentVisits: [],
    tabs: [],
    activeTabId: null,
    tasks: {},
    docs: {},
    docDetails: {},
    plans: {},
    chatMessages: {},
    pending: {},
    syncMeta: {},
    syncLogScopeStamps: {},
    scopeSubscriptions: initialScopeSubscriptionState(),
  } as any);
});

afterEach(() => {
  if (PREV_FLAG === undefined)
    delete process.env.VITE_CLIENT_SCOPE_SUBSCRIPTIONS;
  else process.env.VITE_CLIENT_SCOPE_SUBSCRIPTIONS = PREV_FLAG;
});

describe("scope-subscriptions pure core", () => {
  test("flag is off by default and store reconciliation is a no-op without it", () => {
    expect(clientScopeSubscriptionsEnabled()).toBe(false);
    useInboxStore.setState({
      currentUser: { _id: "u1" },
      teams: [{ _id: "t1" }],
      clientStateInitialized: true,
    } as any);
    const res = useInboxStore.getState().reconcileScopeSubscriptions(1000);
    expect(res.addedScopes).toEqual([]);
    expect(res.removedScopes).toEqual([]);
    expect(useInboxStore.getState().scopeSubscriptions.active).toEqual({});
    expect(useInboxStore.getState().scopeSubscriptions.chunks).toEqual([
      [],
      [],
      [],
      [],
    ]);
  });

  test("extracts pinned, membership, follows (starred + 14d visits), and view scopes", () => {
    const now = 20 * 24 * 60 * 60 * 1000;
    const candidates = extractScopeCandidates(
      {
        currentUser: { _id: "u1" },
        teams: [{ _id: "t1" }, { _id: "team-stub-1" }],
        viewerRoles: {
          r1: {
            _id: "r1",
            host_user_id: "u1",
            status: "active",
            scope: { project_ids: ["p-role"] },
          },
          rRetired: {
            _id: "rRetired",
            host_user_id: "u1",
            status: "retired",
            scope: { project_ids: ["p-retired"] },
          },
          rOther: {
            _id: "rOther",
            host_user_id: "u2",
            status: "active",
            scope: { project_ids: ["p-other"] },
          },
        },
        projects: {
          "p-owned": { _id: "p-owned", user_id: "u1" },
          "p-role": { _id: "p-role", user_id: "u2", short_id: "pj-role" },
          "p-star": { _id: "p-star", user_id: "u2", short_id: "pj-star" },
          "p-recent": { _id: "p-recent", user_id: "u2", short_id: "pj-rec" },
          "p-old": { _id: "p-old", user_id: "u2", short_id: "pj-old" },
          "p-view": { _id: "p-view", user_id: "u2" },
        },
        chatChannels: {
          "ch-open": { _id: "ch-open" },
          "ch-muted": { _id: "ch-muted" },
          "ch-muted-open": { _id: "ch-muted-open" },
          "ch-archived": { _id: "ch-archived", archived_at: 100 },
          "ch-unjoined": { _id: "ch-unjoined" },
          "chatstub-1": { _id: "chatstub-1" },
        },
        chatReads: {
          rd1: {
            channel_id: "ch-open",
            notify_level: "mentions",
            updated_at: 10,
          },
          rd2: { channel_id: "ch-muted", notify_level: "none", updated_at: 10 },
          rd3: {
            channel_id: "ch-muted-open",
            notify_level: "none",
            updated_at: 10,
          },
          rd4: {
            channel_id: "ch-archived",
            notify_level: "all",
            updated_at: 10,
          },
        },
        chatRail: [
          { channel_id: "ch-rail", joined: true, notify_level: "all" },
          { channel_id: "ch-unjoined", joined: false, notify_level: "all" },
        ],
        clientState: {
          ui: {
            sidebar_pins: [{ kind: "project", id: "pj-star" }],
          },
        },
        recentVisits: [
          {
            kind: "page",
            key: "page:/projects/pj-rec",
            path: "/projects/pj-rec",
            ts: now - SCOPE_FOLLOW_WINDOW_MS,
          },
          {
            kind: "page",
            key: "page:/projects/pj-old",
            path: "/projects/pj-old",
            ts: now - SCOPE_FOLLOW_WINDOW_MS - 1,
          },
        ],
        activeTabId: "tab1",
        tabs: [
          {
            id: "tab1",
            path: "/projects/p-view",
            layout: {
              type: "split",
              children: [
                { type: "leaf", id: "l1", path: "/projects/p-view" },
                { type: "leaf", id: "l2", path: "/chat/ch-muted-open" },
                { type: "leaf", id: "l3", path: "/tasks/task1" },
              ],
            },
          },
        ],
        tasks: {
          task1: {
            _id: "task1",
            home_scope: "project:p-task-view",
            workspace: "team:t1",
          },
        },
      },
      now,
    );

    expect(candidates.pinned.sort()).toEqual(["dir:t1", "user:u1"]);
    expect(candidates.membership.sort()).toEqual([
      "channel:ch-open",
      "channel:ch-rail",
      "project:p-owned",
      "project:p-role",
    ]);
    expect(candidates.follows).toEqual([
      { scope: "project:p-star", at: undefined },
      { scope: "project:p-recent", at: now - SCOPE_FOLLOW_WINDOW_MS },
    ]);
    expect(candidates.view.sort()).toEqual([
      "channel:ch-muted-open",
      "project:p-task-view",
      "project:p-view",
    ]);
  });

  test("enforces 64-scope budget and evicts least recently used scopes", () => {
    let state = initialScopeSubscriptionState();
    const pinned = ["user:u1", "dir:t1"];
    const membership = Array.from({ length: 62 }, (_, i) => `project:p${i}`);

    const first = reconcileScopeSubscriptions(
      state,
      { principalId: "u1", pinned, membership, follows: [], view: [] },
      1000,
    );
    state = first.state;
    expect(first.activeScopes).toHaveLength(SCOPE_SUBSCRIPTION_BUDGET);
    expect(first.evictedScopes).toEqual([]);

    state = touchScopeSubscriptionInState(state, "project:p0", 1500);
    for (let i = 2; i < 62; i++) {
      state = touchScopeSubscriptionInState(state, `project:p${i}`, 1500 + i);
    }

    const second = reconcileScopeSubscriptions(
      state,
      {
        principalId: "u1",
        pinned,
        membership,
        follows: [],
        view: ["project:p-new"],
      },
      2000,
    );
    expect(second.activeScopes).toHaveLength(SCOPE_SUBSCRIPTION_BUDGET);
    expect(second.activeScopes).toContain("user:u1");
    expect(second.activeScopes).toContain("dir:t1");
    expect(second.activeScopes).toContain("project:p0");
    expect(second.activeScopes).toContain("project:p-new");
    expect(second.activeScopes).not.toContain("project:p1");
    expect(second.evictedScopes).toEqual(["project:p1"]);
    expect(second.removedScopes).toEqual(["project:p1"]);
  });

  test("keeps viewed scopes for 60 s grace after leaving, then expires them", () => {
    let state = initialScopeSubscriptionState();
    const t0 = 10_000;
    const opened = reconcileScopeSubscriptions(
      state,
      {
        principalId: "u1",
        pinned: ["user:u1"],
        membership: [],
        follows: [],
        view: ["project:p-view"],
      },
      t0,
    );
    state = opened.state;
    expect(opened.activeScopes).toContain("project:p-view");
    expect(opened.nextGraceExpiryAt).toBeNull();

    const left = reconcileScopeSubscriptions(
      state,
      {
        principalId: "u1",
        pinned: ["user:u1"],
        membership: [],
        follows: [],
        view: [],
      },
      t0 + 1000,
    );
    state = left.state;
    expect(left.activeScopes).toContain("project:p-view");
    expect(left.nextGraceExpiryAt).toBe(t0 + SCOPE_VIEW_GRACE_MS);

    const beforeExpiry = reconcileScopeSubscriptions(
      state,
      {
        principalId: "u1",
        pinned: ["user:u1"],
        membership: [],
        follows: [],
        view: [],
      },
      t0 + SCOPE_VIEW_GRACE_MS - 1,
    );
    state = beforeExpiry.state;
    expect(beforeExpiry.activeScopes).toContain("project:p-view");
    expect(beforeExpiry.expiredGraceScopes).toEqual([]);

    const atExpiry = reconcileScopeSubscriptions(
      state,
      {
        principalId: "u1",
        pinned: ["user:u1"],
        membership: [],
        follows: [],
        view: [],
      },
      t0 + SCOPE_VIEW_GRACE_MS,
    );
    expect(atExpiry.activeScopes).toEqual(["user:u1"]);
    expect(atExpiry.expiredGraceScopes).toEqual(["project:p-view"]);
    expect(atExpiry.removedScopes).toEqual(["project:p-view"]);
    expect(atExpiry.nextGraceExpiryAt).toBeNull();
  });

  test("preserves chunk assignments across additions and removals in chunks of 16", () => {
    let state = initialScopeSubscriptionState();
    const initialMembership = Array.from(
      { length: 20 },
      (_, i) => `project:p${String(i).padStart(2, "0")}`,
    );
    const r1 = reconcileScopeSubscriptions(
      state,
      {
        principalId: "u1",
        pinned: ["user:u1"],
        membership: initialMembership,
        follows: [],
        view: [],
      },
      1000,
    );
    state = r1.state;
    expect(state.chunks[0]).toHaveLength(SCOPE_HEADS_CHUNK_SIZE);
    expect(state.chunks[1]).toHaveLength(5);
    expect(state.chunks[2]).toEqual([]);
    expect(state.chunks[3]).toEqual([]);

    const prevChunk0 = state.chunks[0];
    const prevChunk1 = state.chunks[1];

    const r2 = reconcileScopeSubscriptions(
      state,
      {
        principalId: "u1",
        pinned: ["user:u1"],
        membership: [...initialMembership, "project:p-added"],
        follows: [],
        view: [],
      },
      2000,
    );
    state = r2.state;
    expect(state.chunks[0]).toBe(prevChunk0);
    expect(state.chunks[1]).toEqual([...prevChunk1, "project:p-added"]);

    const withoutP00 = initialMembership.filter((s) => s !== "project:p00");
    const prevChunk1AfterAdd = state.chunks[1];
    const r3 = reconcileScopeSubscriptions(
      state,
      {
        principalId: "u1",
        pinned: ["user:u1"],
        membership: [...withoutP00, "project:p-added"],
        follows: [],
        view: [],
      },
      3000,
    );
    expect(r3.state.chunks[0]).toHaveLength(15);
    expect(r3.state.chunks[0]).not.toContain("project:p00");
    expect(r3.state.chunks[1]).toBe(prevChunk1AfterAdd);
  });

  test("computes purge set and purges unheld rows in store while lifting excludes on rejoin", () => {
    expect(
      rowHomeScope("tasks", {
        _id: "t1",
        workspace: "team:team1",
        project_id: "p1",
      }),
    ).toBe("project:p1");
    expect(
      rowHomeScope("docs", {
        _id: "d1",
        workspace: "team:team1",
      }),
    ).toBe("dir:team1");
    expect(
      rowHomeScope("plans", {
        _id: "pl1",
        workspace: "user:u1",
        project_id: "p1",
      }),
    ).toBe("user:u1");
    expect(
      rowHomeScope("chatMessages", {
        _id: "m1",
        channel_id: "ch1",
      }),
    ).toBe("channel:ch1");

    const held = new Set(["user:u1", "dir:team1", "project:p-held"]);
    const purgeTargets = computePurgeSet(
      {
        tasks: {
          tHeld: { _id: "tHeld", home_scope: "project:p-held" },
          tDrop: { _id: "tDrop", home_scope: "project:p-evicted" },
          tLocked: { _id: "tLocked", home_scope: "project:p-evicted" },
          tUser: { _id: "tUser", home_scope: "user:u1" },
        },
        docs: {
          dDir: { _id: "dDir", home_scope: "dir:team1" },
          dDrop: { _id: "dDrop", workspace: "team:team1", project_id: "p-old" },
        },
        plans: {
          plDrop: { _id: "plDrop", home_scope: "project:p-evicted" },
        },
        chatMessages: {
          mDrop: { _id: "mDrop", channel_id: "ch-muted" },
        },
      },
      held,
      { "tasks:tLocked:title": { type: "field", value: "locked", ts: 1 } },
    );

    expect(purgeTargets).toEqual([
      { collection: "tasks", id: "tDrop", scope: "project:p-evicted" },
      { collection: "docs", id: "dDrop", scope: "project:p-old" },
      { collection: "plans", id: "plDrop", scope: "project:p-evicted" },
      { collection: "chatMessages", id: "mDrop", scope: "channel:ch-muted" },
    ]);

    process.env.VITE_CLIENT_SCOPE_SUBSCRIPTIONS = "1";
    useInboxStore.setState({
      currentUser: { _id: "u1" },
      teams: [{ _id: "team1" }],
      clientStateInitialized: true,
      clientState: {
        ui: { sidebar_pins: [{ kind: "project", id: "p-star" }] },
      } as any,
      tasks: {
        tKeep: { _id: "tKeep", home_scope: "project:p-star" },
        tDrop: { _id: "tDrop", home_scope: "project:p-star" },
      },
      syncMeta: { "synclog:v1:project:p-star": { cursor: 5 } },
      syncLogScopeStamps: { "project:p-star": 100 },
    } as any);

    const joinRes = useInboxStore.getState().reconcileScopeSubscriptions(1000);
    expect(joinRes.addedScopes).toContain("project:p-star");
    expect(useInboxStore.getState().tasks.tDrop).toBeDefined();

    useInboxStore.setState({
      clientState: { ui: { sidebar_pins: [] } } as any,
    } as any);

    const dropRes = useInboxStore.getState().reconcileScopeSubscriptions(2000);
    expect(dropRes.removedScopes).toContain("project:p-star");
    expect(useInboxStore.getState().tasks.tDrop).toBeUndefined();
    expect(useInboxStore.getState().tasks.tKeep).toBeUndefined();
    expect(useInboxStore.getState().pending["tasks:tDrop"]).toMatchObject({
      type: "exclude",
      scope: "project:p-star",
    });
    expect(
      useInboxStore.getState().syncMeta["synclog:v1:project:p-star"],
    ).toBeUndefined();

    useInboxStore.setState({
      clientState: {
        ui: { sidebar_pins: [{ kind: "project", id: "p-star" }] },
      } as any,
    } as any);
    const rejoinRes = useInboxStore
      .getState()
      .reconcileScopeSubscriptions(3000);
    expect(rejoinRes.addedScopes).toContain("project:p-star");
    expect(useInboxStore.getState().pending["tasks:tDrop"]).toBeUndefined();
  });
});
